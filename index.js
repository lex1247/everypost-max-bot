process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import express from "express";
import pg from "pg";
import crypto from "crypto";

const { Pool } = pg;

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const BOT_USERNAME = "id190206555510_3_bot";

if (!MAX_BOT_TOKEN) {
  throw new Error("MAX_BOT_TOKEN is not set");
}

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({
  connectionString: DATABASE_URL
});

// ======================================================
// DATABASE
// ======================================================

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      max_user_id BIGINT UNIQUE NOT NULL,
      first_name TEXT,
      last_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id BIGSERIAL PRIMARY KEY,
      max_chat_id BIGINT UNIQUE NOT NULL,
      owner_user_id BIGINT NOT NULL,
      title TEXT,
      proposal_code TEXT UNIQUE NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS proposal_sessions (
      max_user_id BIGINT PRIMARY KEY,
      channel_id BIGINT NOT NULL REFERENCES channels(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id BIGSERIAL PRIMARY KEY,
      channel_id BIGINT NOT NULL REFERENCES channels(id),
      sender_user_id BIGINT NOT NULL,
      max_message_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log("DATABASE READY");
}

function createProposalCode() {
  return crypto.randomBytes(12).toString("hex");
}

// ======================================================
// MAX API
// ======================================================

async function maxRequest(path, options = {}) {
  const response = await fetch(
    `https://platform-api2.max.ru${path}`,
    {
      ...options,
      headers: {
        Authorization: MAX_BOT_TOKEN,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `MAX API ${response.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : {};
}

async function sendToUser(userId, body) {
  return maxRequest(
    `/messages?user_id=${encodeURIComponent(userId)}`,
    {
      method: "POST",
      body: JSON.stringify(body)
    }
  );
}

async function sendToChannel(chatId, body) {
  return maxRequest(
    `/messages?chat_id=${encodeURIComponent(chatId)}`,
    {
      method: "POST",
      body: JSON.stringify(body)
    }
  );
}

// ВАЖНО:
// MAX не разрешает attachments одновременно с forward.
// Поэтому оригинал пересылаем отдельным сообщением.
async function forwardToUser(userId, mid, extraText = null) {
  return sendToUser(userId, {
    text: extraText,
    link: {
      type: "forward",
      mid
    }
  });
}

async function forwardToChannel(chatId, mid) {
  return sendToChannel(chatId, {
    link: {
      type: "forward",
      mid
    }
  });
}

async function sendSubmissionControls(
  ownerUserId,
  submissionId,
  channelTitle
) {
  return sendToUser(ownerUserId, {
    text:
      `Предложка #${submissionId}\n` +
      `Канал: «${channelTitle}»`,
    attachments: [
      {
        type: "inline_keyboard",
        payload: {
          buttons: [
            [
              {
                type: "callback",
                text: "🚀 Опубликовать",
                payload: `publish_${submissionId}`
              },
              {
                type: "callback",
                text: "🗑 Отклонить",
                payload: `reject_${submissionId}`
              }
            ]
          ]
        }
      }
    ]
  });
}

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/", (req, res) => {
  res.status(200).json({
    service: "EveryPost MAX",
    status: "running"
  });
});

// ======================================================
// WEBHOOK
// ======================================================

app.post("/webhook", async (req, res) => {
  // MAX сразу получает 200 OK.
  res.sendStatus(200);

  try {
    const update = req.body;

    console.log(
      "UPDATE TYPE:",
      update.update_type
    );

    // ==================================================
    // 1. EVERYPOST ДОБАВИЛИ В КАНАЛ
    // ==================================================

    if (
      update.update_type === "bot_added" &&
      update.is_channel === true
    ) {
      const chatId = update.chat_id;
      const user = update.user;
      const ownerUserId = user?.user_id;

      if (!chatId || !ownerUserId) {
        console.log(
          "BOT_ADDED WITHOUT CHAT OR USER"
        );
        return;
      }

      const channel = await maxRequest(
        `/chats/${chatId}`
      );

      const title =
        channel.title ??
        channel.name ??
        "Без названия";

      // Сохраняем владельца.
      await pool.query(
        `
        INSERT INTO users (
          max_user_id,
          first_name,
          last_name
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (max_user_id)
        DO UPDATE SET
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name
        `,
        [
          ownerUserId,
          user?.first_name ?? null,
          user?.last_name ?? null
        ]
      );

      // Если канал уже существовал,
      // сохраняем его старый proposal_code.
      const existing = await pool.query(
        `
        SELECT proposal_code
        FROM channels
        WHERE max_chat_id = $1
        `,
        [chatId]
      );

      const proposalCode =
        existing.rows[0]?.proposal_code ??
        createProposalCode();

      await pool.query(
        `
        INSERT INTO channels (
          max_chat_id,
          owner_user_id,
          title,
          proposal_code,
          active,
          updated_at
        )
        VALUES ($1, $2, $3, $4, TRUE, NOW())

        ON CONFLICT (max_chat_id)
        DO UPDATE SET
          owner_user_id = EXCLUDED.owner_user_id,
          title = EXCLUDED.title,
          active = TRUE,
          updated_at = NOW()
        `,
        [
          chatId,
          ownerUserId,
          title,
          proposalCode
        ]
      );

      const proposalLink =
        `https://max.ru/${BOT_USERNAME}` +
        `?start=${proposalCode}`;

      await sendToUser(ownerUserId, {
        text:
          `✅ Канал «${title}» подключён к EveryPost.\n\n` +
          `📥 Ссылка для предложки:\n` +
          `${proposalLink}\n\n` +
          `Разместите её в канале. ` +
          `Подписчики смогут отправлять текст, фото и видео.`
      });

      console.log(
        "CHANNEL SAVED:",
        chatId
      );

      console.log(
        "PROPOSAL LINK SENT"
      );

      return;
    }

    // ==================================================
    // 2. ПОДПИСЧИК ОТКРЫЛ ПЕРСОНАЛЬНУЮ ССЫЛКУ
    // ==================================================

    if (update.update_type === "bot_started") {
      const userId =
        update.user?.user_id;

      const payload =
        update.payload;

      if (!userId || !payload) {
        console.log(
          "BOT STARTED WITHOUT PAYLOAD"
        );
        return;
      }

      const result = await pool.query(
        `
        SELECT
          id,
          title
        FROM channels
        WHERE proposal_code = $1
          AND active = TRUE
        `,
        [payload]
      );

      if (result.rowCount === 0) {
        await sendToUser(userId, {
          text:
            "Эта ссылка предложки недействительна."
        });

        return;
      }

      const channel =
        result.rows[0];

      // Запоминаем:
      // этот пользователь сейчас отправляет
      // предложку именно в этот канал.
      await pool.query(
        `
        INSERT INTO proposal_sessions (
          max_user_id,
          channel_id,
          updated_at
        )
        VALUES ($1, $2, NOW())

        ON CONFLICT (max_user_id)
        DO UPDATE SET
          channel_id = EXCLUDED.channel_id,
          updated_at = NOW()
        `,
        [
          userId,
          channel.id
        ]
      );

      await sendToUser(userId, {
        text:
          `📥 Предложка для канала ` +
          `«${channel.title}».\n\n` +
          `Отправьте сюда текст, фото или видео.`
      });

      console.log(
        "PROPOSAL SESSION STARTED:",
        userId,
        "CHANNEL:",
        channel.id
      );

      return;
    }

    // ==================================================
    // 3. ПОЛУЧИЛИ ПРЕДЛОЖКУ
    // ==================================================

    if (
      update.update_type ===
      "message_created"
    ) {
      const message =
        update.message;

      const senderUserId =
        message?.sender?.user_id;

      const mid =
        message?.body?.mid;

      if (
        !senderUserId ||
        !mid
      ) {
        console.log(
          "MESSAGE WITHOUT USER OR MID"
        );

        return;
      }

      // Проверяем, есть ли у пользователя
      // активная сессия предложки.
      const sessionResult =
        await pool.query(
          `
          SELECT
            ps.channel_id,
            c.title,
            c.owner_user_id,
            c.max_chat_id
          FROM proposal_sessions ps

          JOIN channels c
            ON c.id = ps.channel_id

          WHERE ps.max_user_id = $1
            AND c.active = TRUE
          `,
          [senderUserId]
        );

      if (
        sessionResult.rowCount === 0
      ) {
        console.log(
          "MESSAGE WITHOUT PROPOSAL SESSION:",
          senderUserId
        );

        return;
      }

      const session =
        sessionResult.rows[0];

      // Сохраняем предложку.
      const saved =
        await pool.query(
          `
          INSERT INTO submissions (
            channel_id,
            sender_user_id,
            max_message_id,
            status
          )
          VALUES (
            $1,
            $2,
            $3,
            'new'
          )
          RETURNING id
          `,
          [
            session.channel_id,
            senderUserId,
            mid
          ]
        );

      const submissionId =
        saved.rows[0].id;

      console.log(
        "SUBMISSION SAVED:",
        submissionId
      );

      // Подписчику подтверждение.
      await sendToUser(
        senderUserId,
        {
          text:
            "✅ Предложка получена."
        }
      );

      // 1. Отдельно пересылаем оригинал владельцу.
      await forwardToUser(
        session.owner_user_id,
        mid,
        `📥 Новая предложка\n` +
        `Канал: «${session.title}»`
      );

      // 2. Отдельным сообщением отправляем кнопки.
      // Так мы не смешиваем forward и attachments.
      await sendSubmissionControls(
        session.owner_user_id,
        submissionId,
        session.title
      );

      console.log(
        "SUBMISSION SENT TO OWNER:",
        submissionId
      );

      return;
    }

    // ==================================================
    // 4. ВЛАДЕЛЕЦ НАЖАЛ КНОПКУ
    // ==================================================

    if (
      update.update_type ===
      "message_callback"
    ) {
      const callback =
        update.callback;

      const payload =
        callback?.payload;

      const actorUserId =
        callback?.user?.user_id ??
        update.user?.user_id;

      if (
        !payload ||
        !actorUserId
      ) {
        console.log(
          "CALLBACK WITHOUT PAYLOAD OR USER"
        );

        return;
      }

      const match =
        payload.match(
          /^(publish|reject)_(\d+)$/
        );

      if (!match) {
        console.log(
          "UNKNOWN CALLBACK:",
          payload
        );

        return;
      }

      const action =
        match[1];

      const submissionId =
        match[2];

      const result =
        await pool.query(
          `
          SELECT
            s.id,
            s.status,
            s.max_message_id,
            c.max_chat_id,
            c.owner_user_id,
            c.title
          FROM submissions s

          JOIN channels c
            ON c.id = s.channel_id

          WHERE s.id = $1
          `,
          [submissionId]
        );

      if (
        result.rowCount === 0
      ) {
        console.log(
          "SUBMISSION NOT FOUND:",
          submissionId
        );

        return;
      }

      const submission =
        result.rows[0];

      // Нажимать кнопки может
      // только владелец этого канала.
      if (
        String(
          submission.owner_user_id
        ) !==
        String(actorUserId)
      ) {
        console.log(
          "UNAUTHORIZED CALLBACK:",
          actorUserId
        );

        return;
      }

      // Защита от повторного нажатия.
      if (
        submission.status !==
        "new"
      ) {
        await sendToUser(
          actorUserId,
          {
            text:
              `Эта предложка уже обработана.\n` +
              `Статус: ${submission.status}`
          }
        );

        return;
      }

      // ----------------------------------------------
      // ОТКЛОНИТЬ
      // ----------------------------------------------

      if (
        action ===
        "reject"
      ) {
        await pool.query(
          `
          UPDATE submissions
          SET status = 'rejected'
          WHERE id = $1
          `,
          [submissionId]
        );

        await sendToUser(
          actorUserId,
          {
            text:
              `🗑 Предложка #${submissionId} ` +
              `отклонена.`
          }
        );

        console.log(
          "SUBMISSION REJECTED:",
          submissionId
        );

        return;
      }

      // ----------------------------------------------
      // ОПУБЛИКОВАТЬ
      // ----------------------------------------------

      if (
        action ===
        "publish"
      ) {
        await forwardToChannel(
          submission.max_chat_id,
          submission.max_message_id
        );

        await pool.query(
          `
          UPDATE submissions
          SET status = 'published'
          WHERE id = $1
          `,
          [submissionId]
        );

        await sendToUser(
          actorUserId,
          {
            text:
              `✅ Предложка #${submissionId} ` +
              `опубликована в канале ` +
              `«${submission.title}».`
          }
        );

        console.log(
          "SUBMISSION PUBLISHED:",
          submissionId
        );

        return;
      }
    }

    // ==================================================
    // 5. БОТА УДАЛИЛИ ИЗ КАНАЛА
    // ==================================================

    if (
      update.update_type ===
      "bot_removed" &&
      update.chat_id
    ) {
      await pool.query(
        `
        UPDATE channels
        SET
          active = FALSE,
          updated_at = NOW()
        WHERE max_chat_id = $1
        `,
        [update.chat_id]
      );

      console.log(
        "CHANNEL DISABLED:",
        update.chat_id
      );

      return;
    }

  } catch (error) {
    console.error(
      "Webhook error:",
      error
    );
  }
});

// ======================================================
// START
// ======================================================

async function start() {
  try {
    await initDatabase();

    app.listen(
      PORT,
      () => {
        console.log(
          `EveryPost MAX started on port ${PORT}`
        );
      }
    );
  } catch (error) {
    console.error(
      "STARTUP ERROR:",
      error
    );

    process.exit(1);
  }
}

start();
