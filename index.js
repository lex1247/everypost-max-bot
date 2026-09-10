import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import https from "node:https";
import tls from "node:tls";

// EveryPost: предложка, анонимная публикация, редактор, постинг, права и сохранённые черновики.
// Черновики сохраняются в PostgreSQL. Медиа остаются вложениями MAX по токенам;
// эта версия не создаёт собственную бессрочную резервную копию медиафайлов.
// Оригинальная предложка не удаляется при сохранении или удалении её черновика.
// Назначения относятся только к EveryPost, права в самом MAX не изменяются.
// ИИ не подключён. Режим модерации на этой версии только manual.
// Режим администратора открывается командой /menu в личном чате с ботом.
// Полный файл для существующего everypost-max-bot. Новые секреты не нужны.
// Контент предложки и редакторский черновик хранятся отдельно.
// Документация API: https://dev.max.ru/docs-api/methods/POST/messages
const VERSION = "drafts-1";
const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.MAX_BOT_TOKEN?.trim();
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_USERNAME = "id190206555510_3_bot";
const WEBHOOK_URL = "https://everypost-max-bot.onrender.com/webhook";
const API_URL = "https://platform-api2.max.ru";

if (!TOKEN) throw new Error("MAX_BOT_TOKEN is not set");
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");

// Больше не отключаем проверку сертификатов для Node.js.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}
const SECRET = crypto.createHmac("sha256", TOKEN)
  .update("EveryPost webhook v1").digest("hex");
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 10000
});
pool.on("error", error => console.error("DATABASE ERROR:", error.message));
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ready = false;
let workerBusy = false;
let maxAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: true });
let certificateLoading;
let apiTail = Promise.resolve();
let lastApiCall = 0;

// ---------- HTTPS и API ----------

function httpsRequest(url, { method = "GET", headers = {}, body, agent } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method, headers, agent, rejectUnauthorized: true
    }, res => {
      const chunks = [];
      let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          res.destroy(new Error("Response is too large"));
        } else chunks.push(chunk);
      });
      res.on("error", error => { clearTimeout(timer); reject(error); });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("HTTPS request timeout")), 12000);
    req.on("error", error => { clearTimeout(timer); reject(error); });
    req.end(body);
  });
}

async function loadMaxCertificate() {
  if (!certificateLoading) {
    certificateLoading = (async () => {
      const cached = await pool.query(
        "SELECT value FROM ep_settings WHERE key = 'max_root_ca'"
      );
      let pem = process.env.MAX_CA_PEM || cached.rows[0]?.value;
      if (!pem) {
        // Сертификат загружается по проверяемому HTTPS, без токена бота.
        const result = await httpsRequest(
          "https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt"
        );
        if (result.status !== 200) throw new Error("Could not download MAX root certificate");
        pem = result.text;
      }
      const cert = new crypto.X509Certificate(pem);
      if (!cert.ca || Date.now() < Date.parse(cert.validFrom) ||
          Date.now() > Date.parse(cert.validTo)) {
        throw new Error("MAX root certificate is invalid or expired");
      }
      maxAgent = new https.Agent({
        keepAlive: true,
        rejectUnauthorized: true,
        ca: [...tls.rootCertificates, cert.toString()]
      });
      await pool.query(`
        INSERT INTO ep_settings(key, value) VALUES ('max_root_ca', $1)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `, [cert.toString()]);
      console.log("MAX TLS CERTIFICATE READY");
    })().catch(error => { certificateLoading = undefined; throw error; });
  }
  return certificateLoading;
}

async function maxRequest(path, method = "GET", body) {
  const options = {
    method,
    headers: { Authorization: TOKEN, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    agent: maxAgent
  };
  let result;
  try {
    result = await httpsRequest(API_URL + path, options);
  } catch (error) {
    const missingCA = ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN"].includes(error.code);
    if (!missingCA) throw error;
    await loadMaxCertificate();
    // Повтор только после ошибки TLS до установления защищённого соединения.
    result = await httpsRequest(API_URL + path, { ...options, agent: maxAgent });
  }
  let data;
  try { data = result.text ? JSON.parse(result.text) : {}; }
  catch { data = {}; }
  if (result.status < 200 || result.status >= 300 || data.success === false) {
    const error = new Error(`MAX API ${result.status}: ${result.text.slice(0, 1000)}`);
    error.status = result.status;
    throw error;
  }
  return data;
}

// Для прототипа сообщения и ответы на кнопки идут последовательно.
// GET-запросы проверки прав не занимают очередь публикаций.
function queueMaxWrite(path, method, body) {
  const task = apiTail.catch(() => {}).then(async () => {
    await sleep(Math.max(0, 650 - (Date.now() - lastApiCall)));
    lastApiCall = Date.now();
    return maxRequest(path, method, body);
  });
  apiTail = task.catch(() => {});
  return task;
}

function sendMessage(kind, id, body) {
  // В канал никогда не отправляем ссылку на оригинал предложки.
  if (kind === "chat_id" && (
    Object.hasOwn(body, "link") || Object.hasOwn(body, "sender")
  )) {
    throw new Error("ANONYMITY GUARD: linked publication is forbidden");
  }
  return queueMaxWrite(`/messages?${kind}=${encodeURIComponent(id)}`, "POST", body);
}
const sendToUser = (id, body) => sendMessage("user_id", id, body);

// В forward нет НИ text, НИ attachments. Только ссылка на оригинал.
function forwardMessage(kind, id, mid) {
  if (kind !== "user_id") {
    throw new Error("ANONYMITY GUARD: forwarding is allowed only to the administrator");
  }
  return sendMessage(kind, id, { link: { type: "forward", mid } });
}
function messageId(result) {
  const mid = result?.message?.body?.mid;
  if (!mid) throw new Error("MAX returned no message ID; check delivery before retrying");
  return mid;
}
async function notify(userId, text) {
  try { await sendToUser(userId, { text }); }
  catch (error) { console.error("NOTIFICATION ERROR:", error.message); }
}
async function answerCallback(callbackId, text, removeButtons = false) {
  // MAX отклоняет пустой ответ {}: нужен message или notification.
  // Уведомление подтверждает только нажатие, а не успех публикации.
  if (typeof callbackId !== "string" || !callbackId.trim()) return;
  const replyText = typeof text === "string" ? text.trim() : "";
  const body = removeButtons
    ? { message: { text: replyText || "Действие завершено.", attachments: [] } }
    : { notification: replyText || "Обрабатываю…" };
  try {
    await queueMaxWrite(
      `/answers?callback_id=${encodeURIComponent(callbackId)}`, "POST", body
    );
  } catch (error) {
    // Ошибка ответа на кнопку не меняет статус публикации
    // и не запускает повторную отправку материала в канал.
    console.error("CALLBACK ANSWER ERROR:", error.message);
  }
}

// ---------- База: прежние таблицы и записи сохраняются ----------

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY, max_user_id BIGINT UNIQUE NOT NULL,
      first_name TEXT, last_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS channels (
      id BIGSERIAL PRIMARY KEY, max_chat_id BIGINT UNIQUE NOT NULL,
      owner_user_id BIGINT NOT NULL, title TEXT,
      proposal_code TEXT UNIQUE NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS proposal_sessions (
      max_user_id BIGINT PRIMARY KEY,
      channel_id BIGINT NOT NULL REFERENCES channels(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id BIGSERIAL PRIMARY KEY,
      channel_id BIGINT NOT NULL REFERENCES channels(id),
      sender_user_id BIGINT NOT NULL, max_message_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS owner_forward_mid TEXT;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS controls_mid TEXT;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS published_mid TEXT;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS last_error TEXT;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS source_message JSONB;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS published_body JSONB;
    CREATE TABLE IF NOT EXISTS ep_editor_sessions (
      actor_user_id BIGINT PRIMARY KEY,
      submission_id BIGINT UNIQUE NOT NULL REFERENCES submissions(id),
      nonce TEXT UNIQUE NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('waiting_text', 'preview')),
      draft_body JSONB,
      draft_text TEXT,
      input_mid TEXT,
      preview_mid TEXT,
      controls_mid TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ep_posts (
      id BIGSERIAL PRIMARY KEY,
      channel_id BIGINT NOT NULL REFERENCES channels(id),
      author_user_id BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      source_message JSONB,
      body JSONB,
      input_mid TEXT,
      preview_mid TEXT,
      controls_mid TEXT,
      published_mid TEXT,
      published_body JSONB,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ep_composer_sessions (
      actor_user_id BIGINT PRIMARY KEY,
      post_id BIGINT UNIQUE REFERENCES ep_posts(id),
      nonce TEXT UNIQUE NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN (
        'choose_channel', 'waiting_content', 'waiting_text', 'preview'
      )),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ep_posts ADD COLUMN IF NOT EXISTS is_saved BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE ep_posts ADD COLUMN IF NOT EXISTS saved_at TIMESTAMPTZ;
    ALTER TABLE ep_posts ADD COLUMN IF NOT EXISTS draft_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ep_posts ADD COLUMN IF NOT EXISTS source_submission_id BIGINT REFERENCES submissions(id);
    ALTER TABLE ep_composer_sessions ADD COLUMN IF NOT EXISTS restore_snapshot JSONB;
    CREATE UNIQUE INDEX IF NOT EXISTS ep_post_source_once
      ON ep_posts(source_submission_id)
      WHERE source_submission_id IS NOT NULL
        AND status IN ('draft', 'publishing', 'needs_check', 'published');
    CREATE INDEX IF NOT EXISTS ep_saved_drafts
      ON ep_posts(channel_id, saved_at DESC) WHERE is_saved = TRUE AND status = 'draft';
    CREATE TABLE IF NOT EXISTS ep_draft_delete_intents (
      nonce TEXT PRIMARY KEY,
      post_id BIGINT NOT NULL REFERENCES ep_posts(id),
      actor_user_id BIGINT NOT NULL,
      expected_revision INTEGER NOT NULL,
      access_version INTEGER NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
    );
    CREATE TABLE IF NOT EXISTS ep_composer_inputs (
      max_message_id TEXT PRIMARY KEY,
      actor_user_id BIGINT NOT NULL,
      session_nonce TEXT,
      post_id BIGINT REFERENCES ep_posts(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ep_posts_owner_status ON ep_posts(author_user_id, status);
    CREATE TABLE IF NOT EXISTS ep_editor_inputs (
      max_message_id TEXT PRIMARY KEY,
      actor_user_id BIGINT NOT NULL,
      session_nonce TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ep_submission_dedupe ON submissions(dedupe_key);

    ALTER TABLE channels ADD COLUMN IF NOT EXISTS moderation_mode TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS notify_owner BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS receipt_sent BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS decision_actor_id BIGINT;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS decision_kind TEXT;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS ep_channel_admins (
      channel_id BIGINT NOT NULL REFERENCES channels(id),
      max_user_id BIGINT NOT NULL,
      display_name TEXT NOT NULL,
      assigned_by BIGINT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      can_create_posts BOOLEAN NOT NULL DEFAULT FALSE,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(channel_id, max_user_id)
    );
    CREATE INDEX IF NOT EXISTS ep_channel_admins_user ON ep_channel_admins(max_user_id, active);
    CREATE TABLE IF NOT EXISTS ep_access_intents (
      nonce TEXT PRIMARY KEY,
      channel_id BIGINT NOT NULL REFERENCES channels(id),
      owner_user_id BIGINT NOT NULL,
      target_user_id BIGINT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('grant', 'revoke', 'allow_posts', 'deny_posts')),
      expected_version INTEGER NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
    );
    CREATE TABLE IF NOT EXISTS ep_submission_deliveries (
      submission_id BIGINT NOT NULL REFERENCES submissions(id),
      recipient_user_id BIGINT NOT NULL,
      access_version INTEGER NOT NULL,
      original_mid TEXT,
      controls_mid TEXT,
      last_error TEXT,
      issue_reported BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(submission_id, recipient_user_id)
    );
    CREATE TABLE IF NOT EXISTS ep_audit_events (
      id BIGSERIAL PRIMARY KEY,
      channel_id BIGINT NOT NULL REFERENCES channels(id),
      actor_user_id BIGINT,
      actor_kind TEXT NOT NULL DEFAULT 'human',
      action TEXT NOT NULL,
      target_id TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ep_audit_channel ON ep_audit_events(channel_id, id);

    CREATE TABLE IF NOT EXISTS ep_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ep_webhook_jobs (
      id BIGSERIAL PRIMARY KEY, event_key TEXT UNIQUE NOT NULL,
      payload JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMPTZ, last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("DATABASE READY");
}

async function checkAdministrator(chatId, userId) {
  const member = await maxAdministrator(chatId, userId);
  return Boolean(member && !member.is_bot && (member.is_owner || member.is_admin));
}

async function handleBotAdded(update) {
  if (update.is_channel !== true) return;
  const chatId = update.chat_id;
  const user = update.user;
  const userId = user?.user_id ?? update.user_id;
  if (chatId == null || userId == null) return;
  const channel = await maxRequest(`/chats/${chatId}`);
  if (!(await checkAdministrator(chatId, userId))) {
    console.log("CHANNEL CONNECT DENIED");
    return;
  }
  const existing = await pool.query(
    "SELECT owner_user_id FROM channels WHERE max_chat_id = $1", [chatId]
  );
  // Повторное добавление другим администратором не передаёт ему аккаунт канала.
  if (existing.rowCount && String(existing.rows[0].owner_user_id) !== String(userId)) {
    await notify(userId, "Этот канал уже связан с другим аккаунтом EveryPost.");
    return;
  }
  await pool.query(`
    INSERT INTO users(max_user_id, first_name, last_name) VALUES ($1, $2, $3)
    ON CONFLICT (max_user_id) DO UPDATE SET
      first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name
  `, [userId, user?.first_name ?? null, user?.last_name ?? null]);
  const saved = await pool.query(`
    INSERT INTO channels(max_chat_id, owner_user_id, title, proposal_code)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (max_chat_id) DO UPDATE SET
      title = EXCLUDED.title, active = TRUE, updated_at = NOW()
    RETURNING *
  `, [chatId, userId, channel.title || "Без названия", crypto.randomBytes(12).toString("hex")]);
  const row = saved.rows[0];
  await sendToUser(userId, {
    text: `✅ Канал «${row.title}» подключён.\n\n📥 Ссылка для предложки:\n` +
      `https://max.ru/${BOT_USERNAME}?start=${row.proposal_code}\n\n` +
      `Для управления каналом отправьте /menu в этот чат.`
  });
  console.log("CHANNEL SAVED:", chatId);
}

async function handleStart(update) {
  const userId = update.user?.user_id;
  if (userId == null) return;
  await rememberUser(update.user);
  if (typeof update.payload !== "string" || !update.payload) {
    await showAdminMenu(userId, true);
    return;
  }
  const composing = await getComposer(userId);
  if (composing) {
    await notify(userId,
      "Сейчас открыто создание собственного поста. Завершите его или отправьте /cancel, " +
      "затем откройте ссылку предложки ещё раз.");
    return;
  }
  const editing = await getEditorSession(userId);
  if (editing) {
    await notify(userId,
      `Сейчас открыта правка предложки #${editing.submission_id}. ` +
      `Завершите её или отправьте /cancel, затем откройте ссылку ещё раз.`);
    return;
  }
  const result = await pool.query(`
    SELECT id, title FROM channels WHERE proposal_code = $1 AND active = TRUE
  `, [typeof update.payload === "string" ? update.payload : ""]);
  if (!result.rowCount) {
    await pool.query("DELETE FROM proposal_sessions WHERE max_user_id = $1", [userId]);
    await notify(userId, "Откройте ссылку «Предложить новость» из нужного канала.");
    return;
  }
  const channel = result.rows[0];
  await pool.query(`
    INSERT INTO proposal_sessions(max_user_id, channel_id) VALUES ($1, $2)
    ON CONFLICT (max_user_id) DO UPDATE SET
      channel_id = EXCLUDED.channel_id, updated_at = NOW()
  `, [userId, channel.id]);
  await notify(userId,
    `📥 Предложка для канала «${channel.title}».\nОтправьте текст, фото или видео.`);
  console.log("PROPOSAL SESSION STARTED:", channel.id);
}

function controlsBody(submissionId, title, accessVersion = 0) {
  const suffix = accessVersion > 0 ? `_a${accessVersion}` : "";
  const action = (name, text) => ({ type: "callback", text,
    payload: `${name}_${submissionId}${suffix}` });
  return {
    text: `📥 Предложка #${submissionId}\nКанал: «${shortTitle(title)}»`,
    attachments: keyboard([
      [action("publish", "🚀 Опубликовать"), action("edit", "✏️ Редактировать")],
      [action("preview", "👁 Предпросмотр"), action("reject", "🗑 Отклонить")],
      [action("savedraft", "💾 Сохранить черновик")]
    ])
  };
}

async function handleMessage(update) {
  const message = update.message;
  const sender = message?.sender;
  const mid = message?.body?.mid;
  if (!sender || sender.is_bot || sender.user_id == null || !mid) return;
  const chatType = message.recipient?.chat_type;
  if (chatType && chatType !== "dialog") return;
  await rememberUser(sender);
  // Повторная доставка уже записанной предложки сохраняет прежнее назначение.
  let found = await pool.query(`
    SELECT s.*, c.title, c.owner_user_id, c.max_chat_id, c.active
    FROM submissions s JOIN channels c ON c.id = s.channel_id
    WHERE s.max_message_id = $1 ORDER BY s.id LIMIT 1
  `, [mid]);
  if (!found.rowCount) {
    // Собственные посты и правки обрабатываются до входящих предложок.
    if (await handleComposerMessage(message)) return;
    if (await handleEditorMessage(message)) return;
    const sessionResult = await pool.query(`
      SELECT ps.channel_id FROM proposal_sessions ps
      JOIN channels c ON c.id = ps.channel_id
      WHERE ps.max_user_id = $1 AND c.active = TRUE
    `, [sender.user_id]);
    if (!sessionResult.rowCount) {
      if (await hasOwnChannel(sender.user_id)) {
        await notify(sender.user_id,
          "Для своего поста нажмите «Создать пост». Это сообщение не опубликовано и не сохранено как предложка.");
        await showAdminMenu(sender.user_id);
      } else {
        await notify(sender.user_id, "Откройте ссылку предложки из нужного канала и отправьте сообщение ещё раз.");
      }
      return;
    }
    const saved = await pool.query(`
      INSERT INTO submissions(channel_id, sender_user_id, max_message_id, dedupe_key)
      VALUES ($1, $2, $3, $3)
      ON CONFLICT (dedupe_key) DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key
      RETURNING *
    `, [sessionResult.rows[0].channel_id, sender.user_id, mid]);
    found = await pool.query(`
      SELECT s.*, c.title, c.owner_user_id, c.max_chat_id, c.active
      FROM submissions s JOIN channels c ON c.id = s.channel_id WHERE s.id = $1
    `, [saved.rows[0].id]);
  }
  const submission = found.rows[0];
  if (!submission || !submission.active) return;
  if (submission.status !== "new") return;
  // Сохраняем содержание именно той версии, которую получил администратор.
  // Эта запись не отправляется в канал целиком.
  await pool.query(`
    UPDATE submissions
    SET source_message = COALESCE(source_message, $2::jsonb)
    WHERE id = $1
  `, [submission.id, JSON.stringify(message)]);
  console.log("SUBMISSION SAVED:", submission.id);

  // Каждому получателю — своя карточка и версия доступа.
  await deliverSubmission(submission);

}


// ---------- Публикация без ссылки на автора предложки ----------
// В MAX создаётся новое сообщение. В него попадают только текст,
// оформление и допустимые вложения. Sender, mid и link не переносятся.

const escapeHtml = value => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

function safeWebUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username && !url.password ? value : null;
  } catch { return null; }
}

function renderBodyText(body) {
  const text = typeof body.text === "string" ? body.text : "";
  const tags = {
    strong: "b", emphasized: "i", strikethrough: "s",
    underline: "u", monospaced: "code", highlighted: "mark",
    heading: "h1", quote: "blockquote"
  };
  const ranges = [];
  const markup = Array.isArray(body.markup) ? body.markup : [];
  if (markup.length > 1000) throw new Error("Слишком сложное оформление текста.");

  for (const entity of markup) {
    if (!entity || !Number.isInteger(entity.from) ||
        !Number.isInteger(entity.length) || entity.from < 0 ||
        entity.length <= 0 || entity.from + entity.length > text.length) continue;
    let tag = tags[entity.type];
    let open = tag ? `<${tag}>` : null;
    let close = tag ? `</${tag}>` : null;
    if (entity.type === "link") {
      const url = safeWebUrl(entity.url);
      if (url) { open = `<a href="${escapeHtml(url)}">`; close = "</a>"; }
    }
    // Скрытые ссылки на профили из user_mention не создаём.
    // Сам текст сообщения, включая введённые имена, не переписываем.
    if (open) ranges.push({
      from: entity.from, to: entity.from + entity.length,
      open, close, id: ranges.length
    });
  }

  const points = [...new Set([0, text.length,
    ...ranges.flatMap(r => [r.from, r.to])])].sort((a, b) => a - b);
  let html = "";
  let stack = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const active = ranges.filter(r => r.from <= from && r.to >= to)
      .sort((a, b) => a.from - b.from || b.to - a.to || a.id - b.id);
    let common = 0;
    while (common < stack.length && common < active.length &&
           stack[common].id === active[common].id) common++;
    for (let j = stack.length - 1; j >= common; j--) html += stack[j].close;
    for (let j = common; j < active.length; j++) html += active[j].open;
    html += escapeHtml(text.slice(from, to));
    stack = active;
  }
  for (let j = stack.length - 1; j >= 0; j--) html += stack[j].close;
  return { text, html, formatted: ranges.length > 0 };
}

function copyAttachment(attachment) {
  const type = attachment?.type;
  const payload = attachment?.payload || {};
  // Чужие кнопки не копируем, как и при прежней пересылке.
  if (type === "inline_keyboard") return null;
  if (["image", "video", "audio", "file"].includes(type)) {
    if (typeof payload.token === "string" && payload.token.length) {
      return { type, payload: { token: payload.token } };
    }
    // Прямая ссылка допустима только для изображения, не для видео.
    if (type === "image" && safeWebUrl(payload.url)) {
      return { type: "image", payload: { url: payload.url } };
    }
    throw new Error(`Нет токена вложения типа ${type}.`);
  }
  if (type === "sticker" && typeof payload.code === "string" && payload.code) {
    return { type, payload: { code: payload.code } };
  }
  if (type === "share") {
    if (typeof payload.token === "string" && payload.token) {
      return { type, payload: { token: payload.token } };
    }
    if (safeWebUrl(payload.url)) return { type, payload: { url: payload.url } };
  }
  // Не публикуем незнакомое вложение и не теряем его молча.
  // Контактная карточка также не подходит для анонимной публикации.
  throw new Error(`Для вложения «${type || "неизвестно"}» нужна отдельная обработка.`);
}

function buildAnonymousPost(source, replacementTextBody = null) {
  if (!source || typeof source !== "object") {
    throw new Error("Не удалось получить содержание предложки.");
  }
  const bodies = [];
  if (source.body && typeof source.body === "object") bodies.push(source.body);
  // У пересланной подписчиком новости содержимое находится в link.message.
  // Берём только MessageBody; не берём link.sender или link.chat_id.
  if (source.link?.type === "forward") {
    const original = source.link.message;
    if (!original || typeof original !== "object") {
      throw new Error("Содержимое пересланного оригинала недоступно.");
    }
    bodies.push(original);
  }
  if (!bodies.length) throw new Error("В предложке нет доступного содержимого.");

  let texts = [];
  const attachments = [];
  for (const body of bodies) {
    if (replacementTextBody === null) {
      const rendered = renderBodyText(body);
      if (rendered.text.length) texts.push(rendered);
    }
    if (body.attachments != null && !Array.isArray(body.attachments)) {
      throw new Error("Неизвестный формат списка вложений.");
    }
    for (const attachment of body.attachments || []) {
      const copy = copyAttachment(attachment);
      if (copy) attachments.push(copy);
    }
  }
  if (replacementTextBody !== null) {
    // Полная замена текста/подписи. Медиа берём только из оригинала.
    const replacement = renderBodyText(replacementTextBody);
    texts = replacement.text.length ? [replacement] : [];
  }
  if (attachments.length > 12) {
    throw new Error("В одном посте больше 12 вложений. Разделите материал.");
  }
  if (attachments.length > 1 && attachments.some(a =>
    ["file", "audio", "sticker"].includes(a.type))) {
    throw new Error("Эту комбинацию вложений нельзя публиковать одним сообщением.");
  }
  const formatted = texts.some(t => t.formatted);
  const text = texts.map(t => formatted ? t.html : t.text).join("\n\n");
  if (text.length > 4000) {
    throw new Error("Текст с оформлением превышает 4000 символов. Сократите его.");
  }
  if (!text.trim() && !attachments.length) {
    throw new Error("В предложке нет текста или поддерживаемых вложений.");
  }
  const body = { text: text || null };
  if (attachments.length) body.attachments = attachments;
  if (formatted) body.format = "html";
  return body;
}

async function loadSubmissionSource(row) {
  if (row.source_message) return row.source_message;
  // Для предложок, полученных до этого обновления, берём сохранённый webhook.
  const eventKey = crypto.createHash("sha256")
    .update(`message_created:${row.max_message_id}`).digest("hex");
  const saved = await pool.query(`
    SELECT payload->'message' AS source_message
    FROM ep_webhook_jobs WHERE event_key = $1
  `, [eventKey]);
  let source = saved.rows[0]?.source_message;
  // Старые версии ещё не сохраняли webhook: получаем сообщение через API.
  if (!source) source = await maxRequest(
    `/messages/${encodeURIComponent(row.max_message_id)}`
  );
  if (!source || typeof source !== "object") {
    throw new Error("Оригинальное сообщение недоступно.");
  }
  await pool.query(`
    UPDATE submissions SET source_message = $2::jsonb WHERE id = $1
  `, [row.id, JSON.stringify(source)]);
  return source;
}

// ---------- Редактор текста: отдельный черновик, оригинал не изменяется ----------

async function getSubmission(id) {
  const result = await pool.query(`
    SELECT s.*, c.max_chat_id, c.owner_user_id, c.title, c.active
    FROM submissions s JOIN channels c ON c.id = s.channel_id WHERE s.id = $1
  `, [id]);
  return result.rows[0] || null;
}

async function getEditorSession(userId) {
  const result = await pool.query(
    "SELECT * FROM ep_editor_sessions WHERE actor_user_id = $1", [userId]);
  return result.rows[0] || null;
}

const newEditNonce = () => crypto.randomBytes(12).toString("hex");

function editorButton(action, session, text) {
  return {
    type: "callback", text,
    payload: `${action}_${session.submission_id}_${session.nonce}`
  };
}

function keyboard(rows) {
  return [{ type: "inline_keyboard", payload: { buttons: rows } }];
}

async function canEdit(row, userId) {
  return Boolean(row && row.status === "new" &&
    await channelAccess(row.channel_id, userId, "moderate"));
}

async function sendEditPrompt(session) {
  const row = await getSubmission(session.submission_id);
  if (!(await canEdit(row, session.actor_user_id))) return;
  await sendToUser(session.actor_user_id, {
    text: `✏️ Правка предложки #${row.id}\nКанал: «${row.title}»\n\n` +
      `Пришлите весь исправленный текст одним обычным сообщением. ` +
      `Если есть фото или видео, этот текст станет подписью к ним.\n\n` +
      `Медиа останутся прежними. Пока ничего не публикуется. ` +
      `Для отмены нажмите кнопку ниже или отправьте /cancel.`,
    attachments: keyboard([[
      editorButton("cancel", session, "↩️ Отменить правку")
    ]])
  });
}

function draftControls(session, title) {
  return {
    text: `👁 Предпросмотр предложки #${session.submission_id}\n` +
      `Канал: «${title}»\n\n` +
      `Выше показан вариант для публикации. В канал он ещё не отправлен.`,
    attachments: keyboard([
      [editorButton("draftpublish", session, "🚀 Опубликовать этот вариант")],
      [editorButton("editsave", session, "💾 Сохранить черновик")],
      [editorButton("again", session, "✏️ Изменить ещё"),
       editorButton("cancel", session, "↩️ Отменить правку")]
    ])
  };
}

async function showDraft(session) {
  // Публиковать разрешено только тот снимок, который показан в предпросмотре.
  const current = await getEditorSession(session.actor_user_id);
  if (!current || current.nonce !== session.nonce || current.stage !== "preview") return;
  const row = await getSubmission(current.submission_id);
  if (!(await canEdit(row, current.actor_user_id))) return;
  if (!current.draft_body) throw new Error("Черновик предпросмотра отсутствует.");

  try {
    if (!current.preview_mid) {
      // Никакого forward: и предпросмотр, и публикация используют один body.
      const shown = await sendToUser(current.actor_user_id, current.draft_body);
      const mid = messageId(shown);
      await pool.query(`
        UPDATE ep_editor_sessions SET preview_mid = $3, updated_at = NOW()
        WHERE actor_user_id = $1 AND nonce = $2
      `, [current.actor_user_id, current.nonce, mid]);
    }
    if (!current.controls_mid) {
      const controls = await sendToUser(current.actor_user_id, draftControls(current, row.title));
      await pool.query(`
        UPDATE ep_editor_sessions SET controls_mid = $3, updated_at = NOW()
        WHERE actor_user_id = $1 AND nonce = $2
      `, [current.actor_user_id, current.nonce, messageId(controls)]);
    }
    console.log("EDIT PREVIEW READY:", row.id);
  } catch (error) {
    console.error("EDIT PREVIEW ERROR:", error.message);
    // Если предпросмотр не отправился, не предлагаем публикацию вслепую.
    await sendToUser(current.actor_user_id, {
      text: `Не удалось полностью показать предпросмотр #${row.id}. ` +
        `Черновик сохранён, в канале ничего не опубликовано.`,
      attachments: keyboard([
        [editorButton("draftpreview", current, "🔄 Показать предпросмотр")],
        [editorButton("cancel", current, "↩️ Отменить правку")]
      ])
    });
  }
}

async function resumeEditor(session) {
  if (session.stage === "preview") {
    if (session.controls_mid) {
      const row = await getSubmission(session.submission_id);
      if (await canEdit(row, session.actor_user_id)) {
        await sendToUser(session.actor_user_id, draftControls(session, row.title));
      }
    } else await showDraft(session);
  } else await sendEditPrompt(session);
}

async function beginEdit(row, userId) {
  if (!(await canEdit(row, userId))) return;
  await pool.query("DELETE FROM proposal_sessions WHERE max_user_id = $1", [userId]);
  const composing = await getComposer(userId);
  if (composing) {
    await notify(userId, "Сначала завершите создание собственного поста или отправьте /cancel.");
    await resumeComposer(composing);
    return;
  }
  let session = await getEditorSession(userId);
  if (session) {
    if (String(session.submission_id) !== String(row.id)) {
      await notify(userId,
        `У вас уже открыта правка предложки #${session.submission_id}. ` +
        `Завершите её или отправьте /cancel, затем выберите другую предложку.`);
    }
    await resumeEditor(session);
    return;
  }
  const occupied = await pool.query(
    "SELECT actor_user_id FROM ep_editor_sessions WHERE submission_id = $1", [row.id]);
  if (occupied.rowCount) {
    await notify(userId, `Предложка #${row.id} уже в работе у другого администратора. ` +
      "Дождитесь завершения правки или её отмены.");
    return;
  }
  // Заблаговременно сохраняем оригинал, в том числе для старых предложок.
  await loadSubmissionSource(row);
  const created = await pool.query(`
    INSERT INTO ep_editor_sessions(actor_user_id, submission_id, nonce, stage)
    VALUES ($1, $2, $3, 'waiting_text')
    ON CONFLICT DO NOTHING
    RETURNING *
  `, [userId, row.id, newEditNonce()]);
  session = created.rows[0] || await getEditorSession(userId);
  if (!session) await notify(userId, "Эту предложку уже открыл другой администратор.");
  if (created.rowCount) await audit(row.channel_id, userId, "edit_started", row.id);
  if (session) {
    console.log("EDIT STARTED:", session.submission_id);
    await resumeEditor(session);
  }
}

async function returnOriginalControls(submissionId, userId) {
  const row = await getSubmission(submissionId);
  if (!row || row.status !== "new") return;
  const access = await channelAccess(row.channel_id, userId, "moderate");
  if (access) await sendToUser(userId, controlsBody(row.id, row.title, access.version));
}

async function cancelEditor(session, inputMid = null) {
  const client = await pool.connect();
  let deleted;
  try {
    await client.query("BEGIN");
    if (inputMid) {
      await client.query(`
        INSERT INTO ep_editor_inputs(max_message_id, actor_user_id, session_nonce)
        VALUES ($1, $2, $3) ON CONFLICT (max_message_id) DO NOTHING
      `, [inputMid, session.actor_user_id, session.nonce]);
    }
    deleted = await client.query(`
      DELETE FROM ep_editor_sessions
      WHERE actor_user_id = $1 AND nonce = $2 RETURNING submission_id
    `, [session.actor_user_id, session.nonce]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
  if (!deleted.rowCount) return;
  await notify(session.actor_user_id,
    `Правка предложки #${session.submission_id} отменена. ` +
    `Исходный материал не изменён и не опубликован.`);
  await returnOriginalControls(session.submission_id, session.actor_user_id);
  console.log("EDIT CANCELLED:", session.submission_id);
}

async function rememberEditorInput(message, nonce = null) {
  await pool.query(`
    INSERT INTO ep_editor_inputs(max_message_id, actor_user_id, session_nonce)
    VALUES ($1, $2, $3) ON CONFLICT (max_message_id) DO NOTHING
  `, [message.body.mid, message.sender.user_id, nonce]);
}

async function handleEditorMessage(message) {
  const userId = message.sender.user_id;
  const mid = message.body.mid;
  const text = typeof message.body.text === "string" ? message.body.text : "";

  // Повторно доставленная правка после закрытия редактора
  // не должна стать новой предложкой для чужого канала.
  const receipt = await pool.query(
    "SELECT * FROM ep_editor_inputs WHERE max_message_id = $1", [mid]);
  if (receipt.rowCount) {
    const saved = receipt.rows[0];
    const session = await getEditorSession(userId);
    if (session && session.nonce === saved.session_nonce &&
        session.stage === "preview" && session.input_mid === mid &&
        !session.controls_mid) await showDraft(session);
    return true;
  }

  const session = await getEditorSession(userId);
  const cancelCommand = ["/cancel", "/отмена"].includes(text.trim().toLowerCase());
  if (!session) {
    if (!cancelCommand) return false;
    await rememberEditorInput(message);
    await notify(userId, "Сейчас нет открытой правки.");
    return true;
  }
  if (cancelCommand) {
    await cancelEditor(session, mid);
    return true;
  }

  const row = await getSubmission(session.submission_id);
  if (!(await canEdit(row, userId))) {
    await rememberEditorInput(message, session.nonce);
    await pool.query("DELETE FROM ep_editor_sessions WHERE actor_user_id = $1 AND nonce = $2",
      [userId, session.nonce]);
    await notify(userId,
      "Правка закрыта: предложка уже обработана, канал отключён или права изменились. " +
      "Ваш текст не был опубликован и не отправлен в предложку.");
    return true;
  }
  if (session.stage !== "waiting_text") {
    await rememberEditorInput(message, session.nonce);
    await notify(userId,
      `Для предложки #${row.id} уже открыт предпросмотр. ` +
      `Чтобы заменить текст ещё раз, нажмите «Изменить ещё». ` +
      `Для отмены отправьте /cancel. Это сообщение не изменило черновик.`);
    return true;
  }

  let draftBody;
  try {
    if (!text.trim()) throw new Error("Отправьте непустой текст одним сообщением.");
    if (message.link?.type === "forward") {
      throw new Error("Нужен обычный текст, а не пересылка другого сообщения.");
    }
    // Превью обычной ссылки может прийти как share. Новые медиа
    // здесь не принимаем, чтобы случайно не заменить исходные фотографии.
    const attachments = message.body.attachments;
    if (attachments != null && !Array.isArray(attachments)) {
      throw new Error("Отправьте только текст, без новых вложений.");
    }
    if ((attachments || []).some(a => a?.type !== "share")) {
      throw new Error("На этом шаге меняется только текст. Фото и видео прикреплять не нужно.");
    }
    const source = await loadSubmissionSource(row);
    draftBody = buildAnonymousPost(source, {
      text,
      markup: Array.isArray(message.body.markup) ? message.body.markup : []
    });
  } catch (error) {
    await rememberEditorInput(message, session.nonce);
    await notify(userId, `${error.message}\nПравка #${row.id} остаётся открытой. Пришлите текст ещё раз.`);
    return true;
  }

  const nextNonce = newEditNonce();
  const client = await pool.connect();
  let changed;
  try {
    await client.query("BEGIN");
    const inserted = await client.query(`
      INSERT INTO ep_editor_inputs(max_message_id, actor_user_id, session_nonce)
      VALUES ($1, $2, $3) ON CONFLICT (max_message_id) DO NOTHING
      RETURNING max_message_id
    `, [mid, userId, nextNonce]);
    if (inserted.rowCount) {
      changed = await client.query(`
        UPDATE ep_editor_sessions
        SET nonce = $3, stage = 'preview', draft_body = $4::jsonb,
          draft_text = $5, input_mid = $6, preview_mid = NULL,
          controls_mid = NULL, updated_at = NOW()
        WHERE actor_user_id = $1 AND nonce = $2 AND stage = 'waiting_text'
          AND EXISTS (SELECT 1 FROM submissions s
            WHERE s.id = ep_editor_sessions.submission_id AND s.status = 'new')
        RETURNING *
      `, [userId, session.nonce, nextNonce, JSON.stringify(draftBody), text, mid]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
  if (changed?.rowCount) {
    await audit(row.channel_id, userId, "edit_saved", row.id);
    console.log("EDIT DRAFT SAVED:", row.id);
    await showDraft(changed.rows[0]);
  }
  return true;
}

async function publishPrepared(row, userId, callbackId, body, session = null) {
  if (!(await canEdit(row, userId))) {
    await notify(userId, "Публикация остановлена: доступ к каналу изменился.");
    return;
  }
  // Claim и снимок будущего поста сохраняются одним запросом.
  // Старые кнопки исходной предложки не обходят открытый редактор.
  const claimed = session
    ? await pool.query(`
        UPDATE submissions SET status = 'publishing', published_body = $4::jsonb
        WHERE id = $1 AND status = 'new'
          AND EXISTS (
            SELECT 1 FROM ep_editor_sessions e
            WHERE e.submission_id = submissions.id AND e.actor_user_id = $2
              AND e.nonce = $3 AND e.stage = 'preview' AND e.preview_mid IS NOT NULL
          ) RETURNING id
      `, [row.id, userId, session.nonce, JSON.stringify(body)])
    : await pool.query(`
        UPDATE submissions SET status = 'publishing', published_body = $2::jsonb
        WHERE id = $1 AND status = 'new'
          AND NOT EXISTS (
            SELECT 1 FROM ep_editor_sessions e WHERE e.submission_id = submissions.id
          ) RETURNING id
      `, [row.id, JSON.stringify(body)]);
  if (!claimed.rowCount) {
    await notify(userId, "Публикация не выполнена: статус или версия предложки уже изменились.");
    return;
  }

  let accepted = false;
  try {
    const published = await sendMessage("chat_id", row.max_chat_id, body);
    accepted = true;
    await pool.query(`
      UPDATE submissions SET status = 'published', published_mid = $2, last_error = NULL,
        decision_actor_id = $3, decision_kind = 'human', decided_at = NOW()
      WHERE id = $1
    `, [row.id, messageId(published), userId]);
  } catch (error) {
    // При сетевой неопределённости не делаем автоматический повтор публикации.
    const definiteRejection = !accepted && error.status >= 400 && error.status < 500 && error.status !== 408;
    await pool.query("UPDATE submissions SET status = $2, last_error = $3 WHERE id = $1",
      [row.id, definiteRejection ? "new" : "needs_check", error.message.slice(0, 1000)]);
    await notify(userId, definiteRejection
      ? `Не удалось опубликовать предложку #${row.id}. Она сохранена. Ошибка есть в Logs.`
      : `Статус публикации #${row.id} не подтверждён. Проверьте канал: ` +
        `повторная отправка остановлена, чтобы не создать дубль.`);
    console.error("PUBLISH ERROR:", error.message);
    return;
  }
  await pool.query("DELETE FROM ep_editor_sessions WHERE submission_id = $1", [row.id]);
  await answerCallback(callbackId,
    `✅ Предложка #${row.id} опубликована в канале «${row.title}».`, true);
  await notify(userId, `✅ Предложка #${row.id} опубликована в канале «${row.title}».`);
  await audit(row.channel_id, userId, "submission_published", row.id);
  console.log("SUBMISSION PUBLISHED ANONYMOUSLY:", row.id);
}

async function handleCallback(update) {
  // Настройки доступа не меняются из групп или пересланных чужих карточек.
  const recipientType = update.message?.recipient?.chat_type;
  if (recipientType && recipientType !== "dialog") return;
  if (await handleAccessCallback(update)) return;
  if (await handleSavedDraftCallback(update)) return;
  if (await handleAdminCallback(update)) return;
  const callback = update.callback;
  const userId = callback?.user?.user_id;
  const payload = typeof callback?.payload === "string" ? callback.payload : "";
  const basic = payload.match(/^(publish|reject|edit|preview|savedraft)_(\d+)(?:_a(\d+))?$/);
  const draft = payload.match(/^(draftpublish|again|cancel|draftpreview|editsave)_(\d+)_([a-f0-9]{24})$/);
  if ((!basic && !draft) || userId == null) return;
  const [, action, id] = draft || basic;
  const row = await getSubmission(id);
  const access = row ? await channelAccess(row.channel_id, userId, "moderate") : null;
  if (!access || (basic && !access.owner && Number(basic[3]) !== access.version)) {
    await answerCallback(callback.callback_id);
    await notify(userId, "Нет доступа к этой карточке либо права изменились. Откройте /menu.");
    return;
  }
  // Снимаем ожидание кнопки. Саму карточку уберём только после завершения.
  await answerCallback(callback.callback_id);
  const composing = await getComposer(userId);
  if (composing && action !== "reject") {
    await notify(userId,
      "Сейчас открыто создание собственного поста. Завершите его или отправьте /cancel, " +
      "затем вернитесь к предложке. Предложка не опубликована.");
    return;
  }

  if (row.status !== "new") {
    if (["published", "rejected"].includes(row.status)) {
      // Восстановление после остановки процесса между записью результата
      // и закрытием редактора. Завершённая правка не блокирует следующую.
      await pool.query("DELETE FROM ep_editor_sessions WHERE submission_id = $1", [id]);
    }
    const labels = {
      published: "уже опубликована", rejected: "отклонена",
      drafted: "сохранена в разделе «Черновики»",
      publishing: "публикуется", needs_check: "нужно проверить результат в канале"
    };
    await notify(userId,
      `Предложка #${id}: ${labels[row.status] || row.status}. Повторная публикация не выполнена.`);
    return;
  }

  const lock = await pool.query(
    "SELECT actor_user_id FROM ep_editor_sessions WHERE submission_id = $1", [id]);
  if (lock.rowCount && String(lock.rows[0].actor_user_id) !== String(userId)) {
    await notify(userId, `Предложка #${id} уже в работе у другого администратора.`);
    return;
  }

  if (draft) {
    const session = await getEditorSession(userId);
    if (!session || session.nonce !== draft[3] || String(session.submission_id) !== id) {
      await notify(userId,
        "Это кнопка от предыдущей версии правки. Используйте последнюю карточку предпросмотра.");
      return;
    }
    if (action === "cancel") {
      await cancelEditor(session);
      await answerCallback(callback.callback_id, `Правка #${id} отменена.`, true);
      return;
    }
    if (action === "again") {
      const next = await pool.query(`
        UPDATE ep_editor_sessions
        SET nonce = $3, stage = 'waiting_text', preview_mid = NULL,
          controls_mid = NULL, updated_at = NOW()
        WHERE actor_user_id = $1 AND nonce = $2 RETURNING *
      `, [userId, session.nonce, newEditNonce()]);
      if (next.rowCount) await sendEditPrompt(next.rows[0]);
      return;
    }
    if (action === "draftpreview") {
      await showDraft(session);
      return;
    }
    if (session.stage !== "preview" || !session.preview_mid || !session.draft_body) {
      await notify(userId, "Сначала нужен успешно показанный предпросмотр. Публикация не выполнена.");
      return;
    }
    if (action === "editsave") {
      await saveSubmissionDraft(row, userId, callback.callback_id, session);
    } else await publishPrepared(row, userId, callback.callback_id, session.draft_body, session);
    return;
  }

  if (action === "reject") {
    const changed = await pool.query(
      `UPDATE submissions SET status = 'rejected', decision_actor_id = $2,
         decision_kind = 'human', decided_at = NOW()
       WHERE id = $1 AND status = 'new' RETURNING id`, [id, userId]);
    if (!changed.rowCount) return;
    await pool.query("DELETE FROM ep_editor_sessions WHERE submission_id = $1", [id]);
    await answerCallback(callback.callback_id, `🗑 Предложка #${id} отклонена.`, true);
    await audit(row.channel_id, userId, "submission_rejected", id);
    console.log("SUBMISSION REJECTED:", id);
    return;
  }
  if (action === "edit") {
    await beginEdit(row, userId);
    return;
  }
  const session = await getEditorSession(userId);
  if (session && String(session.submission_id) === id) {
    await notify(userId,
      `Для предложки #${id} открыта правка. Используйте её предпросмотр или отмените правку. ` +
      `Исходный вариант сейчас не опубликован.`);
    await resumeEditor(session);
    return;
  }

  if (action === "savedraft") {
    await saveSubmissionDraft(row, userId, callback.callback_id);
    return;
  }
  let body;
  try {
    body = buildAnonymousPost(await loadSubmissionSource(row));
  } catch (error) {
    await pool.query("UPDATE submissions SET last_error = $2 WHERE id = $1",
      [id, error.message.slice(0, 1000)]);
    await notify(userId,
      `Предложка #${id} не опубликована. ${error.message} ` +
      `Оригинал сохранён; пересылка с автором не выполнялась.`);
    console.error("ANONYMOUS PREPARE ERROR:", error.message);
    return;
  }
  if (action === "preview") {
    await sendToUser(userId, body);
    const controls = controlsBody(id, row.title, access.version);
    controls.text = `👁 Предпросмотр предложки #${id}\nКанал: «${row.title}»\n\n` +
      `Выше исходный вариант без ссылки на отправителя. В канал он ещё не отправлен.`;
    await sendToUser(userId, controls);
    return;
  }
  await publishPrepared(row, userId, callback.callback_id, body);
}

// ---------- Доступ администраторов: строго отдельно для каждого канала ----------
// Подписка остаётся у канала. Эта версия не включает ИИ и не изменяет права MAX.
// Для будущей автоматизации есть moderation_mode и тип автора решения.
// Любой неизвестный режим запрещает публикацию, а не включает автоматику.

async function rememberUser(user) {
  if (!user || user.user_id == null || user.is_bot) return;
  await pool.query(`
    INSERT INTO users(max_user_id, first_name, last_name) VALUES ($1, $2, $3)
    ON CONFLICT (max_user_id) DO UPDATE SET
      first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name
  `, [user.user_id, user.first_name ?? null, user.last_name ?? null]);
}

async function maxAdministrators(chatId) {
  const result = await maxRequest(`/chats/${encodeURIComponent(chatId)}/members/admins`);
  if (!Array.isArray(result.members)) throw new Error("MAX returned no administrator list");
  return result.members;
}
async function maxAdministrator(chatId, userId) {
  return (await maxAdministrators(chatId)).find(m => String(m.user_id) === String(userId)) || null;
}
function memberCanPublish(member) {
  if (!member || member.is_bot) return false;
  return Boolean(member.is_owner || (member.is_admin && Array.isArray(member.permissions) &&
    member.permissions.some(p => ["write", "post_edit_delete_message"].includes(p))));
}
function displayName(user) {
  return ([user?.first_name, user?.last_name].filter(Boolean).join(" ").trim() ||
    user?.display_name || `ID ${user?.user_id ?? user?.max_user_id}`).slice(0, 70);
}
function pageNumber(page) { return Math.max(0, Math.min(100000, Number(page) || 0)); }
function pageButtons(prefix, page, total) {
  const rows = [];
  if (page > 0) rows.push(button("◀️ Назад", `${prefix}_${page - 1}`));
  if ((page + 1) * ADMIN_PAGE_SIZE < total) rows.push(button("Далее ▶️", `${prefix}_${page + 1}`));
  return rows;
}
async function getChannel(id) {
  return (await pool.query("SELECT * FROM channels WHERE id = $1", [id])).rows[0] || null;
}
async function getGrant(channelId, userId) {
  return (await pool.query(`
    SELECT * FROM ep_channel_admins WHERE channel_id = $1 AND max_user_id = $2
  `, [channelId, userId])).rows[0] || null;
}

async function channelAccess(channelId, userId, capability = "view") {
  const channel = await getChannel(channelId);
  if (!channel?.active || userId == null) return null;
  const owner = String(channel.owner_user_id) === String(userId);
  let grant = null;
  if (!owner) {
    if (capability === "manage") return null;
    grant = await getGrant(channel.id, userId);
    if (!grant?.active) return null;
    if (capability === "create" && !grant.can_create_posts) return null;
  }
  const member = await maxAdministrator(channel.max_chat_id, userId);
  if (!member || member.is_bot || !(member.is_admin || member.is_owner)) return null;
  if (["moderate", "create"].includes(capability)) {
    if (channel.moderation_mode !== "manual" || !memberCanPublish(member)) return null;
  }
  return { channel, owner, grant, version: owner ? 0 : Number(grant.version), member,
    can_create: memberCanPublish(member) && (owner || grant.can_create_posts) };
}

async function accessibleChannels(userId, capability = "view") {
  const result = await pool.query(`
    SELECT c.* FROM channels c WHERE c.active = TRUE
      AND (c.owner_user_id = $1 OR EXISTS (
        SELECT 1 FROM ep_channel_admins a WHERE a.channel_id = c.id
          AND a.max_user_id = $1 AND a.active = TRUE))
    ORDER BY c.id
  `, [userId]);
  const rows = [];
  for (const channel of result.rows) {
    try {
      const access = await channelAccess(channel.id, userId, capability);
      if (access) rows.push({ ...channel, access_owner: access.owner, can_create: access.can_create });
    } catch (error) {
      // При недоступности API список закрывается безопасно: чужие данные не показываются.
      console.error("CHANNEL ACCESS CHECK ERROR:", channel.id, error.message);
    }
  }
  return rows;
}

async function audit(channelId, actor, action, targetId = null, details = {}, client = pool) {
  await client.query(`
    INSERT INTO ep_audit_events(channel_id, actor_user_id, actor_kind, action, target_id, details)
    VALUES ($1, $2, 'human', $3, $4, $5::jsonb)
  `, [channelId, actor, action, targetId == null ? null : String(targetId), JSON.stringify(details)]);
}

async function requireOwner(channelId, userId) {
  const access = await channelAccess(channelId, userId, "manage");
  if (!access?.owner) {
    await notify(userId, "Эта настройка доступна только владельцу данного канала в EveryPost.");
    return null;
  }
  return access.channel;
}

async function showChannelAccess(channelId, userId) {
  const access = await channelAccess(channelId, userId);
  if (!access) { await notify(userId, "Канал недоступен. Откройте /menu."); return; }
  const c = access.channel;
  if (!access.owner) {
    await sendToUser(userId, {
      text: `📁 Канал «${shortTitle(c.title)}»\nВаша роль: админ предложки.\n` +
        `Собственные посты: ${access.grant.can_create_posts ? "разрешены" : "не разрешены"}.\n\n` +
        "Доступ относится только к этому каналу. Платежи и назначение сотрудников доступны владельцу.",
      attachments: keyboard([[button("📥 Предложки", "menu_inbox_0")],
        [button("↩️ Мои каналы", "menu_channels_0")]])
    });
    return;
  }
  const grants = await pool.query(`
    SELECT max_user_id, display_name FROM ep_channel_admins
    WHERE channel_id = $1 AND active = TRUE ORDER BY max_user_id
  `, [c.id]);
  await sendToUser(userId, {
    text: `📁 Канал «${shortTitle(c.title)}»\n\n` +
      `📥 Предложка: https://max.ru/${BOT_USERNAME}?start=${c.proposal_code}\n\n` +
      `Назначено админов: ${grants.rowCount}.\n` +
      "Назначение и разжалование меняют только доступ в EveryPost. " +
      "Права в самом MAX остаются прежними.",
    attachments: keyboard([
      [button("Назначить админом", `access_add_${c.id}_0`),
       button("Разжаловать", `access_remove_${c.id}_0`)],
      [button("Админы канала", `access_members_${c.id}_0`)],
      [button(`Уведомления мне: ${c.notify_owner ? "вкл" : "выкл"}`,
        `access_notify_${c.id}_${c.notify_owner ? 0 : 1}`)],
      [button("История действий", `access_log_${c.id}_0`)],
      [button("↩️ Мои каналы", "menu_channels_0")]
    ])
  });
}

async function showAdminCandidates(channelId, userId, page = 0) {
  const c = await requireOwner(channelId, userId);
  if (!c) return;
  const active = await pool.query(`
    SELECT max_user_id FROM ep_channel_admins WHERE channel_id = $1 AND active = TRUE
  `, [c.id]);
  const assigned = new Set(active.rows.map(r => String(r.max_user_id)));
  const candidates = (await maxAdministrators(c.max_chat_id)).filter(m =>
    memberCanPublish(m) && String(m.user_id) !== String(c.owner_user_id) &&
    !assigned.has(String(m.user_id)));
  page = pageNumber(page);
  const rows = candidates.slice(page * ADMIN_PAGE_SIZE, (page + 1) * ADMIN_PAGE_SIZE);
  const nav = pageButtons(`access_add_${c.id}`, page, candidates.length);
  await sendToUser(userId, {
    text: `Назначить админом · «${shortTitle(c.title)}»\n\n` + (candidates.length
      ? "Выберите человека. Показаны администраторы этого MAX-канала с правом публикации, " +
        "которым ещё не выдан доступ к EveryPost. Перед тестом человек должен открыть нашего бота и отправить /menu."
      : "Нет подходящих кандидатов. Добавьте человека администратором ЭТОГО канала в MAX " +
        "и включите ему право публикации. Попросите его открыть EveryPost и отправить /menu. " +
        "Затем откройте этот список снова."),
    attachments: keyboard([
      ...rows.map(m => [button(displayName(m), `access_grant_${c.id}_${m.user_id}`)]),
      ...(nav.length ? [nav] : []),
      [button("↩️ К каналу", `access_channel_${c.id}`)]
    ])
  });
}

async function showChannelAdmins(channelId, userId, page = 0, remove = false) {
  const c = await requireOwner(channelId, userId);
  if (!c) return;
  const result = await pool.query(`
    SELECT * FROM ep_channel_admins WHERE channel_id = $1 AND active = TRUE ORDER BY max_user_id
  `, [channelId]);
  page = pageNumber(page);
  const rows = result.rows.slice(page * ADMIN_PAGE_SIZE, (page + 1) * ADMIN_PAGE_SIZE);
  const prefix = remove ? "access_remove" : "access_members";
  const nav = pageButtons(`${prefix}_${c.id}`, page, result.rowCount);
  await sendToUser(userId, {
    text: `${remove ? "Разжаловать" : "Админы канала"} · «${shortTitle(c.title)}»\n\n` +
      (result.rowCount ? "Выберите человека." : "Назначенных админов пока нет."),
    attachments: keyboard([
      ...rows.map(m => [button(m.display_name,
        `access_${remove ? "revoke" : "person"}_${c.id}_${m.max_user_id}`)]),
      ...(nav.length ? [nav] : []), [button("↩️ К каналу", `access_channel_${c.id}`)]
    ])
  });
}

async function showAdminPerson(channelId, ownerId, targetId) {
  const c = await requireOwner(channelId, ownerId);
  if (!c) return;
  const grant = await getGrant(c.id, targetId);
  if (!grant?.active) { await notify(ownerId, "Админ уже разжалован."); return; }
  await sendToUser(ownerId, {
    text: `Админ: ${grant.display_name}\nКанал: «${shortTitle(c.title)}»\n\n` +
      "Предложки: получать, редактировать, публиковать, отклонять.\n" +
      `Собственные посты: ${grant.can_create_posts ? "разрешены" : "не разрешены"}.`,
    attachments: keyboard([
      [button(grant.can_create_posts ? "Запретить свои посты" : "Разрешить свои посты",
        `access_posts_${c.id}_${targetId}`)],
      [button("Разжаловать", `access_revoke_${c.id}_${targetId}`)],
      [button("↩️ К каналу", `access_channel_${c.id}`)]
    ])
  });
}

async function proposeAccessChange(channelId, ownerId, targetId, action) {
  const c = await requireOwner(channelId, ownerId);
  if (!c) return;
  if (String(targetId) === String(c.owner_user_id)) {
    await notify(ownerId, "Владельцу не нужно назначать эти права, разжаловать его здесь нельзя."); return;
  }
  const grant = await getGrant(c.id, targetId);
  let name = grant?.display_name;
  if (action === "grant") {
    if (grant?.active) { await notify(ownerId, "Этот человек уже назначен админом."); return; }
    const candidate = await maxAdministrator(c.max_chat_id, targetId);
    if (!memberCanPublish(candidate)) {
      await notify(ownerId, "У кандидата нет действующих прав администратора на публикацию в этом MAX-канале."); return;
    }
    name = displayName(candidate);
  } else if (!grant?.active) {
    await notify(ownerId, "Эти права уже сняты. Обновите список."); return;
  }
  const nonce = newEditNonce();
  await pool.query(`
    INSERT INTO ep_access_intents(nonce, channel_id, owner_user_id, target_user_id, action, expected_version)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [nonce, c.id, ownerId, targetId, action, grant ? Number(grant.version) : 0]);
  const label = {grant: "Назначить админом", revoke: "Разжаловать",
    allow_posts: "Разрешить свои посты", deny_posts: "Запретить свои посты"}[action];
  await sendToUser(ownerId, {
    text: `${label}: ${name}\nКанал: «${shortTitle(c.title)}»\n\n` +
      (action === "grant"
        ? "Человек получит доступ к предложкам только этого канала. " +
          "Создание собственных постов пока выключено. Платежи и назначение сотрудников недоступны."
        : action === "revoke"
          ? "Доступ к предложкам этого канала в EveryPost будет снят. " +
            "Незавершённая правка будет закрыта. Права в самом MAX не меняются."
          : "Это отдельное разрешение внутри EveryPost. Право работы с предложкой не изменится."),
    attachments: keyboard([[button(label, `access_confirm_${nonce}`)],
      [button("Отмена", `access_abort_${nonce}`)]])
  });
}

async function confirmAccessChange(nonce, ownerId) {
  const selected = await pool.query(`
    SELECT * FROM ep_access_intents
    WHERE nonce = $1 AND owner_user_id = $2 AND used = FALSE AND expires_at > NOW()
  `, [nonce, ownerId]);
  const intent = selected.rows[0];
  if (!intent) { await notify(ownerId, "Подтверждение устарело или уже использовано. Откройте канал заново."); return; }
  const c = await requireOwner(intent.channel_id, ownerId);
  if (!c) return;
  if (String(intent.target_user_id) === String(c.owner_user_id)) return;
  let target = null;
  if (["grant", "allow_posts"].includes(intent.action)) {
    target = await maxAdministrator(c.max_chat_id, intent.target_user_id);
    if (!memberCanPublish(target)) {
      await notify(ownerId, "Права человека в MAX изменились. Доступ не выдан."); return;
    }
  }
  const client = await pool.connect();
  let changed;
  try {
    await client.query("BEGIN");
    // Взаимное исключение настроек этого канала плюс одноразовый nonce.
    await client.query("SELECT id FROM channels WHERE id = $1 FOR UPDATE", [c.id]);
    const consumed = await client.query(`
      UPDATE ep_access_intents SET used = TRUE
      WHERE nonce = $1 AND owner_user_id = $2 AND used = FALSE AND expires_at > NOW()
      RETURNING *
    `, [nonce, ownerId]);
    const current = (await client.query(`
      SELECT * FROM ep_channel_admins WHERE channel_id = $1 AND max_user_id = $2 FOR UPDATE
    `, [c.id, intent.target_user_id])).rows[0];
    if (!consumed.rowCount || Number(current?.version || 0) !== Number(intent.expected_version)) {
      await client.query("COMMIT");
      await notify(ownerId, "Права уже изменились. Обновите карточку канала."); return;
    }
    const active = intent.action !== "revoke";
    const allow = intent.action === "allow_posts" ||
      (intent.action === "revoke" && Boolean(current?.can_create_posts));
    changed = (await client.query(`
      INSERT INTO ep_channel_admins(channel_id, max_user_id, display_name, assigned_by,
        active, can_create_posts, version)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (channel_id, max_user_id) DO UPDATE SET
        display_name = EXCLUDED.display_name, assigned_by = EXCLUDED.assigned_by,
        active = EXCLUDED.active, can_create_posts = EXCLUDED.can_create_posts,
        version = EXCLUDED.version, updated_at = NOW()
      RETURNING *
    `, [c.id, intent.target_user_id, target ? displayName(target) : current.display_name,
      ownerId, active, allow, Number(current?.version || 0) + 1])).rows[0];
    if (intent.action === "revoke") {
      await client.query(`
        DELETE FROM ep_editor_sessions WHERE actor_user_id = $1
          AND submission_id IN (SELECT id FROM submissions WHERE channel_id = $2)
      `, [intent.target_user_id, c.id]);
    }
    if (["revoke", "deny_posts"].includes(intent.action)) {
      // Сохранённый черновик возвращается к версии до незавершённой правки.
      await client.query(`
        UPDATE ep_posts AS p SET body = e.restore_snapshot->'body',
          source_message = e.restore_snapshot->'source_message',
          input_mid = e.restore_snapshot->>'input_mid', preview_mid = NULL,
          controls_mid = NULL, updated_at = NOW()
        FROM ep_composer_sessions e WHERE e.post_id = p.id AND e.actor_user_id = $1
          AND p.channel_id = $2 AND p.status = 'draft' AND p.is_saved = TRUE
          AND e.restore_snapshot IS NOT NULL
          AND ($3 = 'revoke' OR p.source_submission_id IS NULL)
      `, [intent.target_user_id, c.id, intent.action]);
      // Запрет собственных постов не отнимает отдельное право на предложку.
      await client.query(`
        DELETE FROM ep_composer_sessions WHERE actor_user_id = $1
          AND post_id IN (SELECT id FROM ep_posts WHERE channel_id = $2
            AND ($3 = 'revoke' OR source_submission_id IS NULL))
      `, [intent.target_user_id, c.id, intent.action]);
    }
    await audit(c.id, ownerId, `access_${intent.action}`, intent.target_user_id,
      { version: changed.version, can_create_posts: changed.can_create_posts }, client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {}); throw error;
  } finally { client.release(); }
  const text = intent.action === "grant" ? "✅ Админ назначен."
    : intent.action === "revoke" ? "✅ Админ разжалован." : "✅ Разрешение обновлено.";
  await notify(ownerId, `${text}\n${changed.display_name} · «${shortTitle(c.title)}»`);
  try {
    await sendToUser(changed.max_user_id, {text:
      intent.action === "revoke"
        ? `Доступ к каналу «${shortTitle(c.title)}» в EveryPost снят. ` +
          "Новые предложки не будут присылаться, прежние кнопки больше не дают доступа."
        : `Вам выдан доступ к предложкам канала «${shortTitle(c.title)}».\n` +
          `Собственные посты: ${changed.can_create_posts ? "разрешены" : "не разрешены"}.\n` +
          "Отправьте /menu, чтобы открыть управление. Старые карточки после изменения прав нужно открыть заново из меню."
    });
  } catch (error) {
    await notify(ownerId, "Права сохранены, но уведомление человеку не доставлено. " +
      "Попросите его открыть EveryPost и отправить /menu.");
    console.error("ADMIN NOTIFICATION ERROR:", error.message);
  }
}

async function showAccessLog(channelId, ownerId, page = 0) {
  const c = await requireOwner(channelId, ownerId);
  if (!c) return;
  page = pageNumber(page);
  const result = await pool.query(`
    SELECT a.*, u.first_name, u.last_name FROM ep_audit_events a
    LEFT JOIN users u ON u.max_user_id = a.actor_user_id
    WHERE a.channel_id = $1 ORDER BY a.id DESC LIMIT $2 OFFSET $3
  `, [c.id, ADMIN_PAGE_SIZE + 1, page * ADMIN_PAGE_SIZE]);
  const labels = {access_grant: "Назначен админ", access_revoke: "Админ разжалован",
    access_allow_posts: "Разрешены свои посты", access_deny_posts: "Запрещены свои посты",
    edit_started: "Открыта правка", edit_saved: "Сохранена правка",
    submission_published: "Предложка опубликована", submission_rejected: "Предложка отклонена",
    own_post_published: "Собственный пост опубликован", owner_notifications: "Уведомления владельцу",
    draft_saved: "Черновик сохранён", draft_deleted: "Черновик удалён",
    submission_draft_saved: "Предложка сохранена в черновик"};
  const rows = result.rows.slice(0, ADMIN_PAGE_SIZE);
  const nav = [];
  if (page > 0) nav.push(button("◀️ Назад", `access_log_${c.id}_${page - 1}`));
  if (result.rowCount > ADMIN_PAGE_SIZE) nav.push(button("Далее ▶️", `access_log_${c.id}_${page + 1}`));
  await sendToUser(ownerId, {
    text: `История · «${shortTitle(c.title)}»\nВремя UTC.\n\n` + (rows.length
      ? rows.map(r => `${new Date(r.created_at).toISOString().slice(0,16).replace("T", " ")} · ` +
          `${displayName({ ...r, user_id: r.actor_user_id })}\n` +
          `${labels[r.action] || r.action}${r.target_id ? ` · #${r.target_id}` : ""}`).join("\n\n")
      : "Новых записей пока нет. Действия до этой версии в историю не добавляются."),
    attachments: keyboard([...(nav.length ? [nav] : []),
      [button("↩️ К каналу", `access_channel_${c.id}`)]])
  });
}

async function handleAccessCallback(update) {
  const cb = update.callback;
  const ownerId = cb?.user?.user_id;
  const value = typeof cb?.payload === "string" ? cb.payload : "";
  if (!value.startsWith("access_") || ownerId == null) return false;
  await answerCallback(cb.callback_id);
  let m;
  if ((m = value.match(/^access_channel_(\d+)$/))) {
    await showChannelAccess(m[1], ownerId);
  } else if ((m = value.match(/^access_(add|remove|members|log)_(\d+)_(\d+)$/))) {
    if (m[1] === "add") await showAdminCandidates(m[2], ownerId, m[3]);
    else if (m[1] === "log") await showAccessLog(m[2], ownerId, m[3]);
    else await showChannelAdmins(m[2], ownerId, m[3], m[1] === "remove");
  } else if ((m = value.match(/^access_(grant|revoke|person|posts)_(\d+)_(\d+)$/))) {
    if (m[1] === "person") await showAdminPerson(m[2], ownerId, m[3]);
    else if (m[1] === "posts") {
      if (!(await requireOwner(m[2], ownerId))) return true;
      const grant = await getGrant(m[2], m[3]);
      if (grant?.active) await proposeAccessChange(m[2], ownerId, m[3],
        grant.can_create_posts ? "deny_posts" : "allow_posts");
    } else await proposeAccessChange(m[2], ownerId, m[3], m[1]);
  } else if ((m = value.match(/^access_confirm_([a-f0-9]{24})$/))) {
    await confirmAccessChange(m[1], ownerId);
    await answerCallback(cb.callback_id, "Заявка обработана. Результат — в сообщении ниже.", true);
  } else if ((m = value.match(/^access_abort_([a-f0-9]{24})$/))) {
    await pool.query(`UPDATE ep_access_intents SET used = TRUE
      WHERE nonce = $1 AND owner_user_id = $2 AND used = FALSE`, [m[1], ownerId]);
    await answerCallback(cb.callback_id, "Изменение прав отменено.", true);
  } else if ((m = value.match(/^access_notify_(\d+)_([01])$/))) {
    const c = await requireOwner(m[1], ownerId);
    if (c) {
      await pool.query("UPDATE channels SET notify_owner = $2 WHERE id = $1", [c.id, m[2] === "1"]);
      await audit(c.id, ownerId, "owner_notifications", null, { enabled: m[2] === "1" });
      await notify(ownerId, m[2] === "1" ? "Уведомления вам включены."
        : "Уведомления вам выключены, когда доступен назначенный админ. " +
          "Если админам нельзя доставить предложку, она будет отправлена вам. " +
          "Все материалы по-прежнему доступны вам через «Предложки».");
      await showChannelAccess(c.id, ownerId);
    }
  }
  return true;
}

// ---------- Доставка предложок с раздельной проверкой каждого получателя ----------

async function deliverOne(submission, userId) {
  const access = await channelAccess(submission.channel_id, userId, "moderate");
  if (!access) return false;
  await pool.query(`
    INSERT INTO ep_submission_deliveries(submission_id, recipient_user_id, access_version, original_mid, controls_mid)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (submission_id, recipient_user_id) DO NOTHING
  `, [submission.id, userId, access.version,
    access.owner ? submission.owner_forward_mid : null, access.owner ? submission.controls_mid : null]);
  let delivery = (await pool.query(`
    SELECT * FROM ep_submission_deliveries WHERE submission_id = $1 AND recipient_user_id = $2
  `, [submission.id, userId])).rows[0];
  if (Number(delivery.access_version) !== access.version) {
    delivery = (await pool.query(`
      UPDATE ep_submission_deliveries SET access_version = $3, original_mid = NULL,
        controls_mid = NULL, last_error = NULL, issue_reported = FALSE, updated_at = NOW()
      WHERE submission_id = $1 AND recipient_user_id = $2 RETURNING *
    `, [submission.id, userId, access.version])).rows[0];
  }
  if (!delivery.original_mid) {
    const sent = await forwardMessage("user_id", userId, submission.max_message_id);
    await pool.query(`UPDATE ep_submission_deliveries SET original_mid = $3, updated_at = NOW()
      WHERE submission_id = $1 AND recipient_user_id = $2`, [submission.id, userId, messageId(sent)]);
  }
  if (!delivery.controls_mid) {
    const card = await sendToUser(userId, controlsBody(submission.id, submission.title, access.version));
    await pool.query(`UPDATE ep_submission_deliveries SET controls_mid = $3,
      last_error = NULL, updated_at = NOW() WHERE submission_id = $1 AND recipient_user_id = $2`,
      [submission.id, userId, messageId(card)]);
  }
  return true;
}

async function deliverSubmission(submission) {
  const c = await getChannel(submission.channel_id);
  if (!c?.active || c.moderation_mode !== "manual") return;
  if (!submission.receipt_sent) {
    await notify(submission.sender_user_id, "✅ Предложка получена.");
    await pool.query("UPDATE submissions SET receipt_sent = TRUE WHERE id = $1", [submission.id]);
  }
  const members = await pool.query(`SELECT max_user_id FROM ep_channel_admins
    WHERE channel_id = $1 AND active = TRUE ORDER BY max_user_id`, [c.id]);
  let deliveredToAdmin = false;
  let failures = 0;
  for (const member of members.rows) {
    try {
      if (await deliverOne(submission, member.max_user_id)) deliveredToAdmin = true;
    } catch (error) {
      failures++;
      console.error("ADMIN DELIVERY ERROR:", submission.id, error.message);
      await pool.query(`UPDATE ep_submission_deliveries SET last_error = $3
        WHERE submission_id = $1 AND recipient_user_id = $2`,
        [submission.id, member.max_user_id, error.message.slice(0, 1000)]);
    }
  }
  // Ошибка одного получателя не препятствует доставке остальным.
  let deliveredToOwner = false;
  if (c.notify_owner || !deliveredToAdmin) {
    try { deliveredToOwner = await deliverOne(submission, c.owner_user_id); }
    catch (error) { failures++; console.error("OWNER DELIVERY ERROR:", error.message); }
  }
  if (!deliveredToOwner && !deliveredToAdmin && failures === 0) failures = 1;
  if (failures) {
    console.log("SUBMISSION DELIVERY INCOMPLETE:", submission.id);
    throw new Error(`Submission ${submission.id}: ${failures} delivery attempt(s) failed; saved in inbox`);
  }
  console.log("SUBMISSION SENT TO ADMINS:", submission.id);
}


// ---------- Меню администратора и собственные посты ----------
// Собственные посты хранятся отдельно от предложок.
// В один момент у администратора либо редактор предложки, либо создание поста.

const ADMIN_PAGE_SIZE = 6;
const shortTitle = title => String(title || "Без названия").slice(0, 70);
const button = (text, payload) => ({ type: "callback", text, payload });

async function getComposer(userId) {
  const result = await pool.query(
    "SELECT * FROM ep_composer_sessions WHERE actor_user_id = $1", [userId]);
  return result.rows[0] || null;
}

async function getOwnPost(postId) {
  const result = await pool.query(`
    SELECT p.*, c.title, c.max_chat_id, c.owner_user_id, c.active
    FROM ep_posts p JOIN channels c ON c.id = p.channel_id WHERE p.id = $1
  `, [postId]);
  return result.rows[0] || null;
}

async function hasOwnChannel(userId) {
  return (await accessibleChannels(userId)).length > 0;
}

async function canUseOwnPost(row, userId) {
  if (!row || userId == null) return false;
  const access = await channelAccess(row.channel_id, userId,
    row.source_submission_id ? "moderate" : "create");
  // Владелец может продолжить черновик своего сотрудника.
  // Сотрудник видит только собственные черновики разрешённых ему каналов.
  if (!access || (!access.owner && String(row.author_user_id) !== String(userId))) return false;
  if (row.source_submission_id) {
    const source = await getSubmission(row.source_submission_id);
    if (!source || String(source.channel_id) !== String(row.channel_id) ||
        source.status !== "drafted") return false;
  }
  return true;
}

function adminMenuBody(canCreate = true) {
  return {
    text: "EveryPost · Управление каналами\n\n" +
      "Здесь только каналы, к которым вам выдан доступ. " +
      "Без подтверждения ничего не публикуется.",
    attachments: keyboard([
      ...(canCreate ? [[button("➕ Создать пост", "menu_create")]] : []),
      [button("📝 Черновики", "menu_drafts_0")],
      [button("📥 Предложки", "menu_inbox_0"), button("📁 Мои каналы", "menu_channels_0")]
    ])
  };
}

async function showAdminMenu(userId, switchMode = false) {
  const composer = await getComposer(userId);
  if (composer) {
    await resumeComposer(composer);
    return;
  }
  const editor = await getEditorSession(userId);
  if (editor) {
    await resumeEditor(editor);
    return;
  }
  if (!(await hasOwnChannel(userId))) {
    await notify(userId,
      "Для отправки новости откройте ссылку предложки из нужного канала.\n\n" +
      "Для управления своим каналом добавьте EveryPost в него администратором. " +
      "После подключения отправьте /menu.");
    return;
  }
  // Только явный вход в админское меню меняет режим пользователя.
  // Переход подписчика по ссылке предложки меню не открывает.
  if (switchMode) {
    await pool.query("DELETE FROM proposal_sessions WHERE max_user_id = $1", [userId]);
  }
  const available = await accessibleChannels(userId);
  await sendToUser(userId, adminMenuBody(available.some(c => c.can_create)));
}

async function listMyChannels(userId, page = 0) {
  page = pageNumber(page);
  const channels = await accessibleChannels(userId);
  const rows = channels.slice(page * ADMIN_PAGE_SIZE, (page + 1) * ADMIN_PAGE_SIZE);
  const nav = pageButtons("menu_channels", page, channels.length);
  await sendToUser(userId, {
    text: "📁 Мои каналы\n\n" + (rows.length
      ? "Выберите канал. Назначать и разжаловать админов может только владелец в EveryPost."
      : "На этой странице нет доступных каналов."),
    attachments: keyboard([
      ...rows.map(c => [button(shortTitle(c.title), `access_channel_${c.id}`)]),
      ...(nav.length ? [nav] : []), [button("↩️ Меню", "menu_main")]
    ])
  });
}

async function listMySubmissions(userId, page = 0) {
  page = pageNumber(page);
  const ids = (await accessibleChannels(userId)).map(c => c.id);
  const result = await pool.query(`
    SELECT s.id, c.title FROM submissions s JOIN channels c ON c.id = s.channel_id
    WHERE c.id = ANY($1::bigint[]) AND c.active = TRUE AND s.status = 'new'
    ORDER BY s.id DESC LIMIT $2 OFFSET $3
  `, [ids, ADMIN_PAGE_SIZE + 1, page * ADMIN_PAGE_SIZE]);
  const rows = result.rows.slice(0, ADMIN_PAGE_SIZE);
  const nav = [];
  if (page > 0) nav.push(button("◀️ Назад", `menu_inbox_${page - 1}`));
  if (result.rows.length > ADMIN_PAGE_SIZE) nav.push(button("Далее ▶️", `menu_inbox_${page + 1}`));
  await sendToUser(userId, {
    text: rows.length ? "📥 Новые предложки\nВыберите материал."
      : "📥 На этой странице нет новых предложок.",
    attachments: keyboard([
      ...rows.map(x => [button(`#${x.id} · ${shortTitle(x.title)}`, `inboxopen_${x.id}`)]),
      ...(nav.length ? [nav] : []), [button("↩️ Меню", "menu_main")]
    ])
  });
}

async function showChannelPicker(session, page = 0) {
  const current = await getComposer(session.actor_user_id);
  if (!current || current.nonce !== session.nonce || current.stage !== "choose_channel") return;
  page = pageNumber(page);
  const channels = await accessibleChannels(session.actor_user_id, "create");
  const rows = channels.slice(page * ADMIN_PAGE_SIZE, (page + 1) * ADMIN_PAGE_SIZE);
  const nav = pageButtons(`cpage_${session.nonce}`, page, channels.length);
  await sendToUser(session.actor_user_id, {
    text: "➕ Создать пост\n\n" + (rows.length
      ? "Выберите канал для публикации."
      : "Нет доступных каналов для собственных постов. Попросите владельца выдать это право."),
    attachments: keyboard([
      ...rows.map(c => [button(shortTitle(c.title), `cpick_${session.nonce}_${c.id}`)]),
      ...(nav.length ? [nav] : []),
      [button("↩️ Отменить создание", `ccancel_${session.nonce}`)]
    ])
  });
}

async function beginComposer(userId) {
  const editor = await getEditorSession(userId);
  if (editor) {
    await notify(userId, "Сначала завершите правку предложки или отправьте /cancel.");
    await resumeEditor(editor);
    return;
  }
  const current = await getComposer(userId);
  if (current) { await resumeComposer(current); return; }
  if (!(await accessibleChannels(userId, "create")).length) {
    await notify(userId, "Создание собственных постов не разрешено. Доступ к предложкам остаётся отдельным правом.");
    await showAdminMenu(userId); return;
  }
  const created = await pool.query(`
    INSERT INTO ep_composer_sessions(actor_user_id, nonce, stage)
    VALUES ($1, $2, 'choose_channel')
    ON CONFLICT (actor_user_id) DO NOTHING RETURNING *
  `, [userId, newEditNonce()]);
  await pool.query("DELETE FROM proposal_sessions WHERE max_user_id = $1", [userId]);
  const session = created.rows[0] || await getComposer(userId);
  if (session) await resumeComposer(session);
}

async function choosePostChannel(session, channelId) {
  const access = await channelAccess(channelId, session.actor_user_id, "create");
  const channel = access?.channel;
  if (!channel) {
    await notify(session.actor_user_id,
      "Канал недоступен или у вас нет действующих прав администратора. Выберите другой канал.");
    return;
  }
  const client = await pool.connect();
  let next;
  try {
    await client.query("BEGIN");
    const locked = await client.query(`
      SELECT * FROM ep_composer_sessions WHERE actor_user_id = $1
        AND nonce = $2 AND stage = 'choose_channel' FOR UPDATE
    `, [session.actor_user_id, session.nonce]);
    if (locked.rowCount) {
      const created = await client.query(`
        INSERT INTO ep_posts(channel_id, author_user_id) VALUES ($1, $2) RETURNING id
      `, [channel.id, session.actor_user_id]);
      next = await client.query(`
        UPDATE ep_composer_sessions
        SET post_id = $3, nonce = $4, stage = 'waiting_content', updated_at = NOW()
        WHERE actor_user_id = $1 AND nonce = $2 RETURNING *
      `, [session.actor_user_id, session.nonce, created.rows[0].id, newEditNonce()]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
  if (next?.rowCount) await sendComposerPrompt(next.rows[0]);
}

async function sendComposerPrompt(session) {
  const row = await getOwnPost(session.post_id);
  if (!(await canUseOwnPost(row, session.actor_user_id)) || row.status !== "draft") return;
  const editing = session.stage === "waiting_text";
  await sendToUser(session.actor_user_id, {
    text: `➕ Пост #${row.id}\nКанал: «${shortTitle(row.title)}»\n\n` +
      (editing
        ? "Пришлите весь новый текст одним обычным сообщением. Он заменит текст или подпись. " +
          "Фото и видео останутся прежними."
        : "Отправьте текст или прикрепите фото, несколько фото либо видео с подписью " +
          "одним сообщением. После этого будет предпросмотр. " +
          "Последующие отдельные сообщения автоматически к посту не добавляются.") +
      "\n\nВ канал пока ничего не публикуется. Отмена: /cancel.",
    attachments: keyboard([
      ...(row.body ? [[button("👁 Вернуться к предпросмотру", `cback_${session.nonce}`)]] : []),
      [button("↩️ Отменить пост", `ccancel_${session.nonce}`)]
    ])
  });
}

function ownPostControls(session, row) {
  return {
    text: `👁 ${row.is_saved ? "Черновик" : "Новый пост"} #${row.id}\nКанал: «${shortTitle(row.title)}»\n\n` +
      "Выше показан вариант для публикации. Он ещё не отправлен в канал.",
    attachments: keyboard([
      [button("🚀 Опубликовать", `cpublish_${session.nonce}`),
       button("💾 Сохранить черновик", `csave_${session.nonce}`)],
      [button("✏️ Изменить текст", `ctext_${session.nonce}`),
       button("📎 Заменить материал", `creplace_${session.nonce}`)],
      ...(row.is_saved ? [[button("🗑 Удалить черновик", `ddelete_${session.nonce}`)]] : []),
      [button(row.is_saved ? "↩️ Закрыть без сохранения" : "↩️ Отменить пост",
        `ccancel_${session.nonce}`)]
    ])
  };
}

async function showOwnPostPreview(session) {
  const current = await getComposer(session.actor_user_id);
  if (!current || current.nonce !== session.nonce || current.stage !== "preview") return;
  const row = await getOwnPost(current.post_id);
  if (!(await canUseOwnPost(row, current.actor_user_id)) || row.status !== "draft") return;
  if (!row.body) throw new Error("Содержимое нового поста отсутствует.");
  try {
    if (!row.preview_mid) {
      const preview = await sendToUser(current.actor_user_id, row.body);
      await pool.query(`
        UPDATE ep_posts SET preview_mid = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'draft'
          AND EXISTS (SELECT 1 FROM ep_composer_sessions e
            WHERE e.post_id = ep_posts.id AND e.nonce = $3 AND e.stage = 'preview')
      `, [row.id, messageId(preview), current.nonce]);
    }
    if (!row.controls_mid) {
      const controls = await sendToUser(current.actor_user_id, ownPostControls(current, row));
      await pool.query(`
        UPDATE ep_posts SET controls_mid = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'draft'
          AND EXISTS (SELECT 1 FROM ep_composer_sessions e
            WHERE e.post_id = ep_posts.id AND e.nonce = $3 AND e.stage = 'preview')
      `, [row.id, messageId(controls), current.nonce]);
    }
    console.log("POST PREVIEW READY:", row.id);
  } catch (error) {
    console.error("POST PREVIEW ERROR:", error.message);
    await sendToUser(current.actor_user_id, {
      text: `Предпросмотр поста #${row.id} не удалось показать полностью. ` +
        "Пост сохранён, в канале ничего не опубликовано.",
      attachments: keyboard([
        [button("🔄 Показать предпросмотр", `crefresh_${current.nonce}`)],
        [button("↩️ Отменить пост", `ccancel_${current.nonce}`)]
      ])
    });
  }
}

async function resumeComposer(session) {
  if (session.stage === "choose_channel") { await showChannelPicker(session); return; }
  const row = await getOwnPost(session.post_id);
  if (!row || row.status !== "draft" || !(await canUseOwnPost(row, session.actor_user_id))) {
    await restoreSavedComposer(session);
    await pool.query(
      "DELETE FROM ep_composer_sessions WHERE actor_user_id = $1 AND nonce = $2",
      [session.actor_user_id, session.nonce]);
    const statuses = {
      published: "уже опубликован", cancelled: "отменён",
      publishing: "отправлялся; проверьте канал, повторная отправка не выполняется",
      needs_check: "требует проверки результата в канале"
    };
    await notify(session.actor_user_id, row && row.status !== "draft"
      ? `Пост #${row.id}: ${statuses[row.status] || row.status}. Для меню отправьте /menu.`
      : "Создание закрыто: канал недоступен или права изменились. Для меню отправьте /menu.");
    return;
  }
  if (session.stage === "preview") {
    if (row.preview_mid && row.controls_mid) {
      await sendToUser(session.actor_user_id, ownPostControls(session, row));
    } else await showOwnPostPreview(session);
  } else await sendComposerPrompt(session);
}

async function rememberComposerInput(message, session = null) {
  await pool.query(`
    INSERT INTO ep_composer_inputs(max_message_id, actor_user_id, session_nonce, post_id)
    VALUES ($1, $2, $3, $4) ON CONFLICT (max_message_id) DO NOTHING
  `, [message.body.mid, message.sender.user_id, session?.nonce ?? null, session?.post_id ?? null]);
}

async function cancelComposer(session, message = null) {
  const post = session.post_id ? await getOwnPost(session.post_id) : null;
  if (post && post.status !== "draft") {
    if (message) await rememberComposerInput(message, session);
    await resumeComposer(session);
    return false;
  }
  const client = await pool.connect();
  let deleted;
  try {
    await client.query("BEGIN");
    if (message) {
      await client.query(`
        INSERT INTO ep_composer_inputs(max_message_id, actor_user_id, session_nonce, post_id)
        VALUES ($1, $2, $3, $4) ON CONFLICT (max_message_id) DO NOTHING
      `, [message.body.mid, session.actor_user_id, session.nonce, session.post_id]);
    }
    await restoreSavedComposer(session, client);
    deleted = await client.query(`
      DELETE FROM ep_composer_sessions WHERE actor_user_id = $1 AND nonce = $2 RETURNING post_id
    `, [session.actor_user_id, session.nonce]);
    if (deleted.rowCount && deleted.rows[0].post_id) {
      await client.query(`
        UPDATE ep_posts SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND author_user_id = $2 AND status = 'draft' AND is_saved = FALSE
      `, [deleted.rows[0].post_id, session.actor_user_id]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {}); throw error;
  } finally { client.release(); }
  if (!deleted.rowCount) return false;
  await notify(session.actor_user_id, post?.is_saved
    ? "Правка закрыта без сохранения. Прежний черновик остаётся в разделе «Черновики». В канал ничего не отправлено."
    : "Создание поста отменено. Ничего в канал не отправлено.");
  await showAdminMenu(session.actor_user_id, true);
  console.log(post?.is_saved ? "SAVED DRAFT EDIT CANCELLED:" : "POST CANCELLED:", session.post_id ?? "selection");
  return true;
}

async function handleComposerMessage(message) {
  const userId = message.sender.user_id;
  const mid = message.body.mid;
  const text = typeof message.body.text === "string" ? message.body.text : "";
  const command = text.trim().toLowerCase();
  const oldEditorInput = await pool.query(
    "SELECT 1 FROM ep_editor_inputs WHERE max_message_id = $1", [mid]);
  if (oldEditorInput.rowCount) return false;
  const receipt = await pool.query(
    "SELECT * FROM ep_composer_inputs WHERE max_message_id = $1", [mid]);
  if (receipt.rowCount) {
    const session = await getComposer(userId);
    if (session && session.stage === "preview" && session.nonce === receipt.rows[0].session_nonce) {
      const row = await getOwnPost(session.post_id);
      if (row?.input_mid === mid && !row.controls_mid) await showOwnPostPreview(session);
    }
    return true;
  }

  // Команды управления распознаются только в обычном текстовом сообщении,
  // не в подписи к фото и не внутри пересланной новости.
  const isCommand = !message.link && !(message.body.attachments || []).length;
  if (isCommand && ["/menu", "/start", "меню"].includes(command)) {
    await rememberComposerInput(message);
    await showAdminMenu(userId, true);
    return true;
  }
  if (isCommand && ["/drafts", "черновики"].includes(command)) {
    await rememberComposerInput(message);
    await listSavedDrafts(userId);
    return true;
  }
  if (isCommand && ["/newpost", "/new"].includes(command)) {
    await rememberComposerInput(message);
    await beginComposer(userId);
    return true;
  }

  const session = await getComposer(userId);
  if (!session) return false;
  if (isCommand && ["/cancel", "/отмена"].includes(command)) {
    await cancelComposer(session, message);
    return true;
  }
  if (session.stage === "choose_channel") {
    await rememberComposerInput(message, session);
    await notify(userId, "Сначала выберите канал кнопкой. Это сообщение не сохранено как пост.");
    await showChannelPicker(session);
    return true;
  }
  const row = await getOwnPost(session.post_id);
  if (!(await canUseOwnPost(row, userId)) || row.status !== "draft") {
    await rememberComposerInput(message, session);
    await resumeComposer(session);
    return true;
  }
  if (session.stage === "preview") {
    await rememberComposerInput(message, session);
    await notify(userId,
      `Для поста #${row.id} уже открыт предпросмотр. ` +
      "Используйте «Изменить текст» или «Заменить материал». " +
      "Новое сообщение не добавлено к посту и не отправлено в предложку.");
    return true;
  }

  let postBody;
  let source;
  try {
    if (session.stage === "waiting_text") {
      if (!text.trim()) throw new Error("Отправьте непустой текст одним сообщением.");
      if (message.link?.type === "forward") throw new Error("Нужен обычный текст, не пересылка.");
      if (message.body.attachments != null && !Array.isArray(message.body.attachments)) {
        throw new Error("Неизвестный формат вложений.");
      }
      if ((message.body.attachments || []).some(a => a?.type !== "share")) {
        throw new Error("Здесь меняется только текст. Для замены медиа используйте «Заменить материал».");
      }
      source = row.source_message;
      postBody = buildAnonymousPost(source, {
        text, markup: Array.isArray(message.body.markup) ? message.body.markup : []
      });
    } else {
      source = message;
      postBody = buildAnonymousPost(message);
    }
  } catch (error) {
    await rememberComposerInput(message, session);
    await notify(userId, `${error.message}\nПост не опубликован. Отправьте материал ещё раз или /cancel.`);
    return true;
  }

  const nextNonce = newEditNonce();
  const client = await pool.connect();
  let next;
  try {
    await client.query("BEGIN");
    const locked = await client.query(`
      SELECT * FROM ep_composer_sessions WHERE actor_user_id = $1 AND nonce = $2
        AND stage IN ('waiting_content', 'waiting_text') FOR UPDATE
    `, [userId, session.nonce]);
    if (locked.rowCount) {
      const inserted = await client.query(`
        INSERT INTO ep_composer_inputs(max_message_id, actor_user_id, session_nonce, post_id)
        VALUES ($1, $2, $3, $4) ON CONFLICT (max_message_id) DO NOTHING RETURNING max_message_id
      `, [mid, userId, nextNonce, row.id]);
      if (inserted.rowCount) {
        const changed = await client.query(`
          UPDATE ep_posts SET source_message = $3::jsonb, body = $4::jsonb, input_mid = $5,
            preview_mid = NULL, controls_mid = NULL, last_error = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'draft'
      AND (author_user_id = $2 OR EXISTS (
        SELECT 1 FROM channels c WHERE c.id = ep_posts.channel_id AND c.owner_user_id = $2))
    RETURNING id
        `, [row.id, userId, JSON.stringify(source), JSON.stringify(postBody), mid]);
        if (changed.rowCount) {
          next = await client.query(`
            UPDATE ep_composer_sessions SET nonce = $3, stage = 'preview', updated_at = NOW()
            WHERE actor_user_id = $1 AND nonce = $2 RETURNING *
          `, [userId, session.nonce, nextNonce]);
        }
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
  if (next?.rowCount) {
    console.log("POST CONTENT SAVED:", row.id);
    await showOwnPostPreview(next.rows[0]);
  }
  return true;
}

async function publishOwnPost(session, row, callbackId) {
  if (!(await canUseOwnPost(row, session.actor_user_id))) {
    await notify(session.actor_user_id, "Публикация остановлена: доступ к каналу изменился."); return;
  }
  const client = await pool.connect();
  let claimed;
  try {
    await client.query("BEGIN");
    claimed = await client.query(`
      UPDATE ep_posts SET status = 'publishing', published_body = body, updated_at = NOW()
      WHERE id = $1 AND status = 'draft' AND body IS NOT NULL
        AND preview_mid IS NOT NULL AND controls_mid IS NOT NULL
        AND (author_user_id = $2 OR EXISTS (
          SELECT 1 FROM channels c WHERE c.id = ep_posts.channel_id AND c.owner_user_id = $2))
        AND EXISTS (SELECT 1 FROM ep_composer_sessions e
          WHERE e.post_id = ep_posts.id AND e.actor_user_id = $2 AND e.nonce = $3 AND e.stage = 'preview')
        AND EXISTS (SELECT 1 FROM channels c WHERE c.id = ep_posts.channel_id
          AND c.active = TRUE AND c.moderation_mode = 'manual'
          AND (c.owner_user_id = $2 OR EXISTS (
            SELECT 1 FROM ep_channel_admins a WHERE a.channel_id = c.id AND a.max_user_id = $2
              AND a.active = TRUE AND (a.can_create_posts = TRUE OR ep_posts.source_submission_id IS NOT NULL))))
        AND (source_submission_id IS NULL OR EXISTS (
          SELECT 1 FROM submissions s WHERE s.id = ep_posts.source_submission_id AND s.status = 'drafted'))
      RETURNING *
    `, [row.id, session.actor_user_id, session.nonce]);
    if (claimed.rowCount && row.source_submission_id) {
      const sourceClaim = await client.query(`
        UPDATE submissions SET status = 'publishing', published_body = $2::jsonb
        WHERE id = $1 AND status = 'drafted' RETURNING id
      `, [row.source_submission_id, JSON.stringify(claimed.rows[0].published_body)]);
      if (!sourceClaim.rowCount) throw new Error("Source submission state changed before publishing");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {}); throw error;
  } finally { client.release(); }
  if (!claimed.rowCount) {
    await notify(session.actor_user_id, "Публикация не выполнена: версия, статус или доступ изменились. Откройте последний предпросмотр.");
    return;
  }
  let accepted = false;
  try {
    const sent = await sendMessage("chat_id", row.max_chat_id, claimed.rows[0].published_body);
    accepted = true;
    const mid = messageId(sent);
    const finish = await pool.connect();
    try {
      await finish.query("BEGIN");
      await finish.query(`UPDATE ep_posts SET status = 'published', published_mid = $2,
        last_error = NULL, updated_at = NOW() WHERE id = $1`, [row.id, mid]);
      if (row.source_submission_id) {
        await finish.query(`UPDATE submissions SET status = 'published', published_mid = $2,
          last_error = NULL, decision_actor_id = $3, decision_kind = 'human', decided_at = NOW()
          WHERE id = $1`, [row.source_submission_id, mid, session.actor_user_id]);
      }
      await finish.query("DELETE FROM ep_composer_sessions WHERE actor_user_id = $1 AND nonce = $2",
        [session.actor_user_id, session.nonce]);
      await audit(row.channel_id, session.actor_user_id,
        row.source_submission_id ? "submission_published" : "own_post_published",
        row.source_submission_id || row.id, { draft_id: row.id }, finish);
      await finish.query("COMMIT");
    } catch (error) {
      await finish.query("ROLLBACK").catch(() => {}); throw error;
    } finally { finish.release(); }
  } catch (error) {
    const definiteRejection = !accepted && error.status >= 400 && error.status < 500 && error.status !== 408;
    const failed = await pool.connect();
    try {
      await failed.query("BEGIN");
      await failed.query(`UPDATE ep_posts SET status = $2, last_error = $3, updated_at = NOW() WHERE id = $1`,
        [row.id, definiteRejection ? "draft" : "needs_check", error.message.slice(0, 1000)]);
      if (row.source_submission_id) await failed.query(
        "UPDATE submissions SET status = $2, last_error = $3 WHERE id = $1",
        [row.source_submission_id, definiteRejection ? "drafted" : "needs_check", error.message.slice(0, 1000)]);
      if (!definiteRejection) await failed.query(
        "DELETE FROM ep_composer_sessions WHERE actor_user_id = $1 AND nonce = $2", [session.actor_user_id, session.nonce]);
      await failed.query("COMMIT");
    } catch (e) {
      await failed.query("ROLLBACK").catch(() => {}); throw e;
    } finally { failed.release(); }
    await notify(session.actor_user_id, definiteRejection
      ? `MAX не принял пост #${row.id}. Черновик сохранён; причина есть в Logs.`
      : `Результат публикации #${row.id} не подтверждён. Проверьте канал. ` +
        "Повторная отправка остановлена, чтобы не создать дубль. Для меню отправьте /menu.");
    console.error("POST PUBLISH ERROR:", error.message); return;
  }
  await answerCallback(callbackId, `✅ Пост #${row.id} опубликован в канале «${shortTitle(row.title)}».`, true);
  await notify(session.actor_user_id, `✅ Пост #${row.id} опубликован в канале «${shortTitle(row.title)}».`);
  console.log(row.source_submission_id ? "DRAFT SUBMISSION PUBLISHED:" : "OWN POST PUBLISHED:", row.id);
  await showAdminMenu(session.actor_user_id, true);
}

async function handleAdminCallback(update) {
  const callback = update.callback;
  const userId = callback?.user?.user_id;
  const payload = typeof callback?.payload === "string" ? callback.payload : "";
  if (userId == null) return false;
  const menu = payload.match(/^menu_(main|create|channels_\d+|inbox_\d+)$/);
  const inbox = payload.match(/^inboxopen_(\d+)$/);
  const pick = payload.match(/^c(pick|page)_([a-f0-9]{24})_(\d+)$/);
  const action = payload.match(/^c(publish|text|replace|cancel|refresh|back|save)_([a-f0-9]{24})$/);
  if (!menu && !inbox && !pick && !action) return false;
  await answerCallback(callback.callback_id);

  if (menu) {
    if (menu[1] === "main") await showAdminMenu(userId, true);
    else if (menu[1] === "create") await beginComposer(userId);
    else if (menu[1].startsWith("channels_")) await listMyChannels(userId, Number(menu[1].split("_")[1]));
    else await listMySubmissions(userId, Number(menu[1].split("_")[1]));
    return true;
  }
  if (inbox) {
    const row = await getSubmission(inbox[1]);
    if (!(await canEdit(row, userId))) {
      await notify(userId, "Предложка недоступна или уже обработана.");
      return true;
    }
    await forwardMessage("user_id", userId, row.max_message_id);
    const access = await channelAccess(row.channel_id, userId, "moderate");
    if (access) await sendToUser(userId, controlsBody(row.id, row.title, access.version));
    return true;
  }

  const session = await getComposer(userId);
  const expected = (pick || action)[2];
  if (!session || session.nonce !== expected) {
    await notify(userId,
      "Эта карточка уже обработана или устарела. Используйте последний предпросмотр либо /menu.");
    return true;
  }
  if (action?.[1] === "cancel") {
    const savedPost = session.post_id ? await getOwnPost(session.post_id) : null;
    if (await cancelComposer(session)) {
      await answerCallback(callback.callback_id,
        savedPost?.is_saved ? "Правка закрыта. Сохранённый черновик не изменён."
          : "Создание поста отменено.", true);
    }
    return true;
  }
  if (pick) {
    if (session.stage !== "choose_channel") { await resumeComposer(session); return true; }
    if (pick[1] === "page") await showChannelPicker(session, Number(pick[3]));
    else await choosePostChannel(session, pick[3]);
    return true;
  }
  const row = await getOwnPost(session.post_id);
  if (!(await canUseOwnPost(row, userId)) || row.status !== "draft") {
    await resumeComposer(session);
    return true;
  }
  if (action[1] === "save") {
    await saveComposerDraft(session, row, callback.callback_id);
    return true;
  }
  if (action[1] === "publish") {
    if (session.stage !== "preview" || !row.preview_mid || !row.controls_mid || !row.body) {
      await notify(userId, "Сначала нужен полностью показанный предпросмотр. Пост не опубликован.");
    } else await publishOwnPost(session, row, callback.callback_id);
    return true;
  }
  if (action[1] === "refresh") {
    await showOwnPostPreview(session);
    return true;
  }
  if (action[1] === "back" && !row.body) return true;
  if (["text", "replace"].includes(action[1]) && session.stage !== "preview") {
    await resumeComposer(session);
    return true;
  }
  const stage = action[1] === "text" ? "waiting_text"
    : action[1] === "replace" ? "waiting_content" : "preview";
  const next = await pool.query(`
    UPDATE ep_composer_sessions SET nonce = $3, stage = $4, updated_at = NOW()
    WHERE actor_user_id = $1 AND nonce = $2 RETURNING *
  `, [userId, session.nonce, newEditNonce(), stage]);
  if (next.rowCount) {
    if (stage === "preview") {
      // Содержимое не менялось; показываем подтверждение с новым nonce.
      await pool.query("UPDATE ep_posts SET controls_mid = NULL WHERE id = $1", [row.id]);
      await showOwnPostPreview(next.rows[0]);
    } else await sendComposerPrompt(next.rows[0]);
  }
  return true;
}


// ---------- Сохранённые черновики ----------
// Черновик не является новой предложкой. Ссылка на исходную предложку
// нужна только в БД; в публичное сообщение она никогда не передаётся.

function composerSnapshot(row) {
  return { body: row.body, source_message: row.source_message, input_mid: row.input_mid ?? null };
}

async function restoreSavedComposer(session, client = pool) {
  await client.query(`
    UPDATE ep_posts AS p SET body = e.restore_snapshot->'body',
      source_message = e.restore_snapshot->'source_message',
      input_mid = e.restore_snapshot->>'input_mid', preview_mid = NULL,
      controls_mid = NULL, updated_at = NOW()
    FROM ep_composer_sessions e
    WHERE e.post_id = p.id AND e.actor_user_id = $1 AND e.nonce = $2
      AND p.status = 'draft' AND p.is_saved = TRUE AND e.restore_snapshot IS NOT NULL
  `, [session.actor_user_id, session.nonce]);
}

async function saveComposerDraft(session, row, callbackId) {
  if (!(await canUseOwnPost(row, session.actor_user_id))) {
    await notify(session.actor_user_id, "Доступ изменился. Черновик не сохранён.");
    return;
  }
  if (session.stage !== "preview" || !row.body || !row.preview_mid || !row.controls_mid) {
    await notify(session.actor_user_id, "Сначала завершите предпросмотр. В канал ничего не отправлено.");
    return;
  }
  const client = await pool.connect();
  let saved;
  try {
    await client.query("BEGIN");
    const locked = await client.query(`
      SELECT * FROM ep_composer_sessions WHERE actor_user_id = $1
        AND nonce = $2 AND post_id = $3 AND stage = 'preview' FOR UPDATE
    `, [session.actor_user_id, session.nonce, row.id]);
    if (locked.rowCount) {
      saved = await client.query(`
        UPDATE ep_posts SET is_saved = TRUE, saved_at = NOW(),
          draft_revision = draft_revision + 1, preview_mid = NULL,
          controls_mid = NULL, last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND status = 'draft' AND body IS NOT NULL
          AND preview_mid IS NOT NULL AND controls_mid IS NOT NULL
          AND (author_user_id = $2 OR EXISTS (
            SELECT 1 FROM channels c WHERE c.id = ep_posts.channel_id AND c.owner_user_id = $2))
        RETURNING *
      `, [row.id, session.actor_user_id]);
      if (saved.rowCount) {
        await client.query("DELETE FROM ep_composer_sessions WHERE actor_user_id = $1 AND nonce = $2",
          [session.actor_user_id, session.nonce]);
        await audit(row.channel_id, session.actor_user_id, "draft_saved", row.id, {}, client);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {}); throw error;
  } finally { client.release(); }
  if (!saved?.rowCount) {
    await notify(session.actor_user_id, "Карточка устарела. Откройте /menu; повторное сохранение не выполнено.");
    return;
  }
  await answerCallback(callbackId, `💾 Черновик #${row.id} сохранён. В канал ничего не отправлено.`, true);
  await notify(session.actor_user_id,
    `💾 Черновик #${row.id} сохранён для канала «${shortTitle(row.title)}».\n` +
    "Откройте /menu → «Черновики», когда будете готовы продолжить.");
  console.log("DRAFT SAVED:", row.id);
  await showAdminMenu(session.actor_user_id, true);
}

async function saveSubmissionDraft(row, userId, callbackId, session = null) {
  if (!(await canEdit(row, userId))) {
    await notify(userId, "Предложка недоступна или уже обработана."); return;
  }
  if (await getComposer(userId)) {
    await notify(userId, "Сначала сохраните или закройте открытый пост."); return;
  }
  const currentEditor = await getEditorSession(userId);
  if (currentEditor && (!session || currentEditor.nonce !== session.nonce)) {
    await notify(userId, "Завершите открытую правку. Для её сохранения используйте последний предпросмотр.");
    return;
  }
  if (session && (session.stage !== "preview" || !session.preview_mid || !session.draft_body)) {
    await notify(userId, "Сначала нужен предпросмотр исправленной предложки."); return;
  }
  let source, body;
  try {
    source = await loadSubmissionSource(row);
    body = session ? session.draft_body : buildAnonymousPost(source);
  } catch (error) {
    await notify(userId, `Не удалось сохранить черновик. ${error.message}`); return;
  }
  const client = await pool.connect();
  let post;
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM submissions WHERE id = $1 FOR UPDATE", [row.id]);
    const editLock = await client.query(
      "SELECT * FROM ep_editor_sessions WHERE submission_id = $1 FOR UPDATE", [row.id]);
    const validEdit = session
      ? editLock.rows[0]?.nonce === session.nonce &&
        String(editLock.rows[0]?.actor_user_id) === String(userId) &&
        editLock.rows[0]?.stage === "preview" && Boolean(editLock.rows[0]?.preview_mid)
      : editLock.rowCount === 0;
    if (locked.rows[0]?.status === "new" && validEdit) {
      const saved = await client.query(`
        INSERT INTO ep_posts(channel_id, author_user_id, status, source_message, body,
          source_submission_id, is_saved, saved_at, draft_revision)
        VALUES ($1, $2, 'draft', $3::jsonb, $4::jsonb, $5, TRUE, NOW(), 1) RETURNING *
      `, [row.channel_id, userId, JSON.stringify(source), JSON.stringify(body), row.id]);
      post = saved.rows[0];
      await client.query("UPDATE submissions SET status = 'drafted' WHERE id = $1 AND status = 'new'", [row.id]);
      if (session) await client.query(
        "DELETE FROM ep_editor_sessions WHERE actor_user_id = $1 AND nonce = $2", [userId, session.nonce]);
      await audit(row.channel_id, userId, "submission_draft_saved", row.id, { draft_id: post.id }, client);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {}); throw error;
  } finally { client.release(); }
  if (!post) {
    await notify(userId, "Предложка уже изменилась или её редактирует другой админ. Сохранение не выполнено.");
    return;
  }
  await answerCallback(callbackId, `💾 Сохранён черновик #${post.id}.`, true);
  await notify(userId,
    `💾 Черновик #${post.id} для канала «${shortTitle(row.title)}» сохранён.\n` +
    `Оригинал предложки #${row.id} не изменён. До решения по черновику её старые кнопки публикации заблокированы.\n` +
    "Продолжить: /menu → «Черновики».");
  console.log("SUBMISSION DRAFT SAVED:", row.id, "POST:", post.id);
  await showAdminMenu(userId, true);
}

async function listSavedDrafts(userId, page = 0) {
  page = pageNumber(page);
  const channels = await accessibleChannels(userId, "moderate");
  const ids = channels.map(c => c.id);
  const createIds = channels.filter(c => c.can_create).map(c => c.id);
  const result = await pool.query(`
    SELECT p.id, p.source_submission_id, p.saved_at, c.title,
      EXISTS (SELECT 1 FROM ep_composer_sessions e WHERE e.post_id = p.id) AS in_work
    FROM ep_posts p JOIN channels c ON c.id = p.channel_id
    WHERE p.channel_id = ANY($2::bigint[]) AND p.status = 'draft' AND p.is_saved = TRUE
      AND (p.author_user_id = $1 OR c.owner_user_id = $1)
      AND (p.source_submission_id IS NOT NULL OR p.channel_id = ANY($3::bigint[]))
    ORDER BY p.saved_at DESC NULLS LAST, p.id DESC LIMIT $4 OFFSET $5
  `, [userId, ids, createIds, ADMIN_PAGE_SIZE + 1, page * ADMIN_PAGE_SIZE]);
  const rows = result.rows.slice(0, ADMIN_PAGE_SIZE);
  const nav = [];
  if (page > 0) nav.push(button("◀️ Назад", `menu_drafts_${page - 1}`));
  if (result.rowCount > ADMIN_PAGE_SIZE) nav.push(button("Далее ▶️", `menu_drafts_${page + 1}`));
  await sendToUser(userId, {
    text: "📝 Черновики\n\n" + (rows.length
      ? "Выберите материал. Владелец видит черновики своих каналов; админ — свои в разрешённых ему каналах.\n" +
        "💬 — из предложки, ✍️ — собственный пост, 🔒 — сейчас в работе."
      : "На этой странице нет доступных сохранённых черновиков.\n" +
        "Подготовьте пост или откройте предложку и нажмите «Сохранить черновик»."),
    attachments: keyboard([
      ...rows.map(p => [button(`${p.in_work ? "🔒 " : ""}${p.source_submission_id ? "💬" : "✍️"} #${p.id} · ${shortTitle(p.title)}`,
        `dopen_${p.id}`)]),
      ...(nav.length ? [nav] : []), [button("↩️ Меню", "menu_main")]
    ])
  });
}

async function openSavedDraft(postId, userId) {
  const row = await getOwnPost(postId);
  if (!row?.is_saved || row.status !== "draft" || !(await canUseOwnPost(row, userId))) {
    await notify(userId, "Черновик недоступен, удалён или уже опубликован."); return;
  }
  const editing = await getEditorSession(userId);
  if (editing) {
    await notify(userId, "Сначала сохраните или отмените открытую правку предложки.");
    await resumeEditor(editing); return;
  }
  const current = await getComposer(userId);
  if (current) {
    if (String(current.post_id) !== String(postId)) {
      await notify(userId, "Сначала сохраните или закройте текущий пост. Одновременно открыт один редактор.");
    }
    await resumeComposer(current); return;
  }
  const client = await pool.connect();
  let session;
  try {
    await client.query("BEGIN");
    const locked = await client.query(`
      SELECT * FROM ep_posts WHERE id = $1 AND status = 'draft' AND is_saved = TRUE FOR UPDATE
    `, [postId]);
    const fresh = locked.rows[0];
    if (fresh && fresh.body) {
      const made = await client.query(`
        INSERT INTO ep_composer_sessions(actor_user_id, post_id, nonce, stage, restore_snapshot)
        VALUES ($1, $2, $3, 'preview', $4::jsonb)
        ON CONFLICT DO NOTHING RETURNING *
      `, [userId, postId, newEditNonce(), JSON.stringify(composerSnapshot(fresh))]);
      session = made.rows[0];
      if (session) {
        await client.query("UPDATE ep_posts SET preview_mid = NULL, controls_mid = NULL WHERE id = $1", [postId]);
        await client.query("DELETE FROM proposal_sessions WHERE max_user_id = $1", [userId]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {}); throw error;
  } finally { client.release(); }
  if (!session) {
    await notify(userId, "Черновик уже в работе у другого администратора или его статус изменился."); return;
  }
  await showOwnPostPreview(session);
}

async function requestDraftDeletion(session, row, callbackId) {
  // Удаление начинается из открытого предпросмотра, поэтому канал и материал
  // уже видны. До подтверждения не удаляем ни черновик, ни исходную предложку.
  if (!row?.is_saved || row.status !== "draft" || !(await canUseOwnPost(row, session.actor_user_id))) {
    await notify(session.actor_user_id, "Черновик недоступен."); return;
  }
  const access = await channelAccess(row.channel_id, session.actor_user_id,
    row.source_submission_id ? "moderate" : "create");
  if (!access) return;
  const nonce = newEditNonce();
  await pool.query(`
    INSERT INTO ep_draft_delete_intents(nonce, post_id, actor_user_id, expected_revision, access_version)
    VALUES ($1, $2, $3, $4, $5)
  `, [nonce, row.id, session.actor_user_id, row.draft_revision, access.version]);
  await sendToUser(session.actor_user_id, {
    text: `Удалить черновик #${row.id}?\nКанал: «${shortTitle(row.title)}»\n\n` +
      (row.source_submission_id
        ? `Правки этого черновика будут удалены. Исходная предложка #${row.source_submission_id} останется ` +
          "и вернётся в раздел «Предложки»."
        : "Будет удалён только этот неопубликованный черновик. Сообщения в канале не изменятся."),
    attachments: keyboard([
      [button("🗑 Удалить черновик", `dconfirm_${nonce}`)],
      [button("↩️ Не удалять", `dkeep_${nonce}`)]
    ])
  });
}

async function confirmDraftDeletion(nonce, userId, callbackId) {
  const intent = (await pool.query(`
    SELECT * FROM ep_draft_delete_intents WHERE nonce = $1 AND actor_user_id = $2
      AND used = FALSE AND expires_at > NOW()
  `, [nonce, userId])).rows[0];
  if (!intent) {
    await notify(userId, "Это подтверждение уже использовано или устарело."); return;
  }
  const row = await getOwnPost(intent.post_id);
  if (!row?.is_saved || row.status !== "draft" || !(await canUseOwnPost(row, userId))) {
    await notify(userId, "Нет доступа к удалению этого черновика."); return;
  }
  const access = await channelAccess(row.channel_id, userId,
    row.source_submission_id ? "moderate" : "create");
  if (!access || access.version !== Number(intent.access_version)) {
    await notify(userId, "Права изменились. Откройте черновик заново."); return;
  }
  const client = await pool.connect();
  let removed = false;
  try {
    await client.query("BEGIN");
    const consumed = await client.query(`
      UPDATE ep_draft_delete_intents SET used = TRUE WHERE nonce = $1 AND actor_user_id = $2
        AND used = FALSE AND expires_at > NOW() RETURNING *
    `, [nonce, userId]);
    const locked = await client.query("SELECT * FROM ep_posts WHERE id = $1 FOR UPDATE", [row.id]);
    const sessions = await client.query("SELECT * FROM ep_composer_sessions WHERE post_id = $1 FOR UPDATE", [row.id]);
    const fresh = locked.rows[0];
    const heldByOther = sessions.rows.some(e => String(e.actor_user_id) !== String(userId));
    if (consumed.rowCount && fresh?.status === "draft" && fresh.is_saved &&
        Number(fresh.draft_revision) === Number(intent.expected_revision) && !heldByOther) {
      await client.query(`
        UPDATE ep_posts SET status = 'deleted', is_saved = FALSE, draft_revision = draft_revision + 1,
          preview_mid = NULL, controls_mid = NULL, updated_at = NOW() WHERE id = $1
      `, [row.id]);
      await client.query("DELETE FROM ep_composer_sessions WHERE post_id = $1", [row.id]);
      if (row.source_submission_id) {
        await client.query("UPDATE submissions SET status = 'new' WHERE id = $1 AND status = 'drafted'",
          [row.source_submission_id]);
      }
      await audit(row.channel_id, userId, "draft_deleted", row.id,
        { source_submission_id: row.source_submission_id }, client);
      removed = true;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {}); throw error;
  } finally { client.release(); }
  if (!removed) {
    await notify(userId, "Черновик изменился или его открыл другой админ. Удаление не выполнено."); return;
  }
  await answerCallback(callbackId, `Черновик #${row.id} удалён.`, true);
  await notify(userId, `🗑 Черновик #${row.id} удалён.` +
    (row.source_submission_id ? ` Исходная предложка #${row.source_submission_id} снова доступна в «Предложках».` : ""));
  console.log("DRAFT DELETED:", row.id);
  await listSavedDrafts(userId);
}

async function handleSavedDraftCallback(update) {
  const cb = update.callback;
  const userId = cb?.user?.user_id;
  const value = typeof cb?.payload === "string" ? cb.payload : "";
  if (userId == null) return false;
  const listing = value.match(/^menu_drafts_(\d+)$/);
  const opening = value.match(/^dopen_(\d+)$/);
  const deletion = value.match(/^ddelete_([a-f0-9]{24})$/);
  const confirmation = value.match(/^(dconfirm|dkeep)_([a-f0-9]{24})$/);
  if (!listing && !opening && !deletion && !confirmation) return false;
  await answerCallback(cb.callback_id);
  if (listing) await listSavedDrafts(userId, listing[1]);
  else if (opening) await openSavedDraft(opening[1], userId);
  else if (deletion) {
    const session = await getComposer(userId);
    if (!session || session.nonce !== deletion[1]) {
      await notify(userId, "Карточка устарела. Откройте черновик заново.");
    } else await requestDraftDeletion(session, await getOwnPost(session.post_id), cb.callback_id);
  } else if (confirmation[1] === "dconfirm") {
    await confirmDraftDeletion(confirmation[2], userId, cb.callback_id);
  } else {
    await pool.query(`UPDATE ep_draft_delete_intents SET used = TRUE
      WHERE nonce = $1 AND actor_user_id = $2 AND used = FALSE`, [confirmation[2], userId]);
    await answerCallback(cb.callback_id, "Черновик не удалён.", true);
    const session = await getComposer(userId);
    if (session) await resumeComposer(session); else await listSavedDrafts(userId);
  }
  return true;
}


async function handleUpdate(update) {
  console.log("UPDATE TYPE:", update.update_type);
  switch (update.update_type) {
    case "bot_added": return handleBotAdded(update);
    case "bot_started": return handleStart(update);
    case "message_created": return handleMessage(update);
    case "message_callback": return handleCallback(update);
    case "bot_removed":
      await pool.query(
        "UPDATE channels SET active = FALSE, updated_at = NOW() WHERE max_chat_id = $1",
        [update.chat_id]);
      return;
  }
}

// ---------- Webhook: подтверждаем только после записи события в БД ----------

app.get("/", (req, res) => res.status(ready ? 200 : 503).json({
  service: "EveryPost MAX", version: VERSION, status: ready ? "running" : "starting"
}));
app.post("/webhook", async (req, res) => {
  const received = Buffer.from(req.get("X-Max-Bot-Api-Secret") || "");
  const expected = Buffer.from(SECRET);
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return res.sendStatus(403);
  }
  const update = req.body;
  if (!update || typeof update.update_type !== "string") return res.sendStatus(400);
  const identity = update.update_type === "message_created" ? update.message?.body?.mid
    : update.update_type === "message_callback" ? update.callback?.callback_id : null;
  const key = crypto.createHash("sha256")
    .update(identity ? `${update.update_type}:${identity}` : JSON.stringify(update)).digest("hex");
  try {
    await pool.query(`
      INSERT INTO ep_webhook_jobs(event_key, payload) VALUES ($1, $2::jsonb)
      ON CONFLICT (event_key) DO NOTHING
    `, [key, JSON.stringify(update)]);
    res.sendStatus(200);
    void runWorker();
  } catch (error) {
    console.error("WEBHOOK SAVE ERROR:", error.message);
    res.sendStatus(503);
  }
});

async function runWorker() {
  if (!ready || workerBusy) return;
  workerBusy = true;
  let job;
  let workerClient;
  let workerLocked = false;
  try {
    // Блокировка на PostgreSQL исключает одновременную обработку
    // двумя процессами этой версии во время перезапуска/развёртывания.
    workerClient = await pool.connect();
    const lock = await workerClient.query(
      "SELECT pg_try_advisory_lock(19471, 1) AS acquired"
    );
    workerLocked = lock.rows[0]?.acquired === true;
    if (!workerLocked) return;
    const result = await pool.query(`
      UPDATE ep_webhook_jobs SET state = 'processing', locked_at = NOW(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM ep_webhook_jobs
        WHERE (state = 'pending' AND next_at <= NOW())
           OR (state = 'processing' AND locked_at < NOW() - INTERVAL '5 minutes')
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) RETURNING *
    `);
    job = result.rows[0];
    if (!job) return;
    await handleUpdate(job.payload);
    await pool.query("UPDATE ep_webhook_jobs SET state = 'done', last_error = NULL WHERE id = $1", [job.id]);
  } catch (error) {
    console.error("Webhook error:", error.message);
    if (job) {
      await pool.query(`
        UPDATE ep_webhook_jobs SET state = $2, last_error = $3,
          next_at = NOW() + INTERVAL '30 seconds' WHERE id = $1
      `, [job.id, job.attempts >= 3 ? "failed" : "pending", error.message.slice(0, 1000)])
        .catch(e => console.error("JOB SAVE ERROR:", e.message));
    }
  } finally {
    if (workerClient) {
      let releaseError;
      if (workerLocked) {
        try { await workerClient.query("SELECT pg_advisory_unlock(19471, 1)"); }
        catch (error) { releaseError = error; }
      }
      workerClient.release(releaseError);
    }
    workerBusy = false;
  }
}

async function registerWebhook() {
  try {
    await maxRequest("/subscriptions", "POST", {
      url: WEBHOOK_URL,
      update_types: ["message_created", "message_callback", "bot_started", "bot_added", "bot_removed"],
      secret: SECRET
    });
    console.log("WEBHOOK READY");
  } catch (error) {
    console.error("WEBHOOK SETUP ERROR:", error.message);
    setTimeout(registerWebhook, 30000).unref();
  }
}

async function start() {
  await initDatabase();
  ready = true;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`EveryPost ${VERSION} started on port ${PORT}`);
    void registerWebhook();
  });
  setInterval(() => void runWorker(), 700).unref();
}
start().catch(error => {
  console.error("STARTUP ERROR:", error.message);
  process.exit(1);
});
