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

if (!MAX_BOT_TOKEN) throw new Error("MAX_BOT_TOKEN is not set");
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");

const pool = new Pool({
  connectionString: DATABASE_URL
});

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

  console.log("DATABASE READY");
}

function createProposalCode() {
  return crypto.randomBytes(12).toString("hex");
}

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
    throw new Error(`MAX API ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : {};
}

async function sendToUser(userId, text) {
  return maxRequest(
    `/messages?user_id=${encodeURIComponent(userId)}`,
    {
      method: "POST",
      body: JSON.stringify({
        text
      })
    }
  );
}

app.get("/", (req, res) => {
  res.status(200).json({
    service: "EveryPost MAX",
    status: "running"
  });
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const update = req.body;

    console.log("UPDATE TYPE:", update.update_type);

    if (
      update.update_type === "bot_added" &&
      update.is_channel === true
    ) {
      const chatId = update.chat_id;
      const user = update.user;
      const ownerUserId = user?.user_id;

      if (!chatId || !ownerUserId) {
        console.log("bot_added without chat_id or user_id");
        return;
      }

      const channel = await maxRequest(`/chats/${chatId}`);

      const title =
        channel.title ??
        channel.name ??
        "Без названия";

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

      const existingChannel = await pool.query(
        `
        SELECT proposal_code
        FROM channels
        WHERE max_chat_id = $1
        `,
        [chatId]
      );

      const proposalCode =
        existingChannel.rows[0]?.proposal_code ??
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
        `https://max.ru/${BOT_USERNAME}?start=${proposalCode}`;

      console.log(
        "CHANNEL SAVED:",
        JSON.stringify({
          chat_id: chatId,
          title,
          owner_user_id: ownerUserId
        })
      );

      await sendToUser(
        ownerUserId,
        `✅ Канал «${title}» подключён к EveryPost.\n\n` +
        `📥 Ссылка для предложки:\n${proposalLink}\n\n` +
        `Разместите эту ссылку в своём канале. По ней подписчики смогут присылать новости, фото и видео.`
      );

      console.log("PROPOSAL LINK SENT");

      return;
    }

    if (
      update.update_type === "bot_removed" &&
      update.chat_id
    ) {
      await pool.query(
        `
        UPDATE channels
        SET active = FALSE, updated_at = NOW()
        WHERE max_chat_id = $1
        `,
        [update.chat_id]
      );

      console.log("CHANNEL DISABLED:", update.chat_id);
      return;
    }

    if (update.update_type === "bot_started") {
      console.log(
        "BOT STARTED:",
        JSON.stringify({
          user_id: update.user?.user_id,
          payload: update.payload ?? null
        })
      );

      return;
    }

    if (update.update_type === "message_created") {
      console.log(
        "MESSAGE RECEIVED:",
        update.message?.body?.mid ?? "no-mid"
      );

      return;
    }

  } catch (error) {
    console.error("Webhook error:", error);
  }
});

async function start() {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      console.log(`EveryPost MAX started on port ${PORT}`);
    });
  } catch (error) {
    console.error("STARTUP ERROR:", error);
    process.exit(1);
  }
}

start();
