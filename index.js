import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import https from "node:https";
import tls from "node:tls";

// EveryPost: предложка, анонимная публикация, правка текста и предпросмотр.
// Полный файл для существующего everypost-max-bot. Новые секреты не нужны.
// Контент предложки и редакторский черновик хранятся отдельно.
// Документация API: https://dev.max.ru/docs-api/methods/POST/messages
const VERSION = "edit-preview-1";
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
  if (!callbackId) return;
  const body = removeButtons ? { message: { text, attachments: [] } } : {};
  try { await queueMaxWrite(`/answers?callback_id=${encodeURIComponent(callbackId)}`, "POST", body); }
  catch (error) { console.error("CALLBACK ANSWER ERROR:", error.message); }
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
    CREATE TABLE IF NOT EXISTS ep_editor_inputs (
      max_message_id TEXT PRIMARY KEY,
      actor_user_id BIGINT NOT NULL,
      session_nonce TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ep_submission_dedupe ON submissions(dedupe_key);
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
  const result = await maxRequest(`/chats/${encodeURIComponent(chatId)}/members/admins`);
  const member = result.members?.find(x => String(x.user_id) === String(userId));
  return Boolean(member && (member.is_owner || member.is_admin));
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
      `https://max.ru/${BOT_USERNAME}?start=${row.proposal_code}`
  });
  console.log("CHANNEL SAVED:", chatId);
}

async function handleStart(update) {
  const userId = update.user?.user_id;
  if (userId == null) return;
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

function controlsBody(submissionId, title) {
  return {
    text: `📥 Предложка #${submissionId}\nКанал: «${title}»`,
    attachments: [{
      type: "inline_keyboard",
      payload: { buttons: [
        [
          { type: "callback", text: "🚀 Опубликовать", payload: `publish_${submissionId}` },
          { type: "callback", text: "✏️ Редактировать", payload: `edit_${submissionId}` }
        ],
        [
          { type: "callback", text: "👁 Предпросмотр", payload: `preview_${submissionId}` },
          { type: "callback", text: "🗑 Отклонить", payload: `reject_${submissionId}` }
        ]
      ] }
    }]
  };
}

async function handleMessage(update) {
  const message = update.message;
  const sender = message?.sender;
  const mid = message?.body?.mid;
  if (!sender || sender.is_bot || sender.user_id == null || !mid) return;
  const chatType = message.recipient?.chat_type;
  if (chatType && chatType !== "dialog") return;
  // Сообщение редактора сначала направляем в его активную правку,
  // даже если у него осталась собственная сессия предложки.
  if (await handleEditorMessage(message)) return;
  // При повторной доставке используем уже сохранённый канал, не новую сессию.
  let found = await pool.query(`
    SELECT s.*, c.title, c.owner_user_id, c.max_chat_id, c.active
    FROM submissions s JOIN channels c ON c.id = s.channel_id
    WHERE s.max_message_id = $1 ORDER BY s.id LIMIT 1
  `, [mid]);
  if (!found.rowCount) {
    const sessionResult = await pool.query(`
      SELECT ps.channel_id FROM proposal_sessions ps
      JOIN channels c ON c.id = ps.channel_id
      WHERE ps.max_user_id = $1 AND c.active = TRUE
    `, [sender.user_id]);
    if (!sessionResult.rowCount) {
      await notify(sender.user_id, "Откройте ссылку предложки из нужного канала и отправьте сообщение ещё раз.");
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

  // Проверяем действующие права получателя, а не только старую запись в БД.
  if (!(await checkAdministrator(submission.max_chat_id, submission.owner_user_id))) {
    throw new Error("Channel account no longer has administrator rights");
  }
  if (!submission.owner_forward_mid) {
    const forwarded = await forwardMessage("user_id", submission.owner_user_id, mid);
    await pool.query("UPDATE submissions SET owner_forward_mid = $2 WHERE id = $1",
      [submission.id, messageId(forwarded)]);
  }
  if (!submission.controls_mid) {
    const controls = await sendToUser(submission.owner_user_id,
      controlsBody(submission.id, submission.title));
    await pool.query("UPDATE submissions SET controls_mid = $2 WHERE id = $1",
      [submission.id, messageId(controls)]);
    await notify(sender.user_id, "✅ Предложка передана администратору.");
  }
  console.log("SUBMISSION SENT TO OWNER:", submission.id);
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
  return Boolean(row && row.active && row.status === "new" &&
    String(row.owner_user_id) === String(userId) &&
    await checkAdministrator(row.max_chat_id, userId));
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
  // Заблаговременно сохраняем оригинал, в том числе для старых предложок.
  await loadSubmissionSource(row);
  const created = await pool.query(`
    INSERT INTO ep_editor_sessions(actor_user_id, submission_id, nonce, stage)
    VALUES ($1, $2, $3, 'waiting_text')
    ON CONFLICT (actor_user_id) DO NOTHING
    RETURNING *
  `, [userId, row.id, newEditNonce()]);
  session = created.rows[0] || await getEditorSession(userId);
  if (session) {
    console.log("EDIT STARTED:", session.submission_id);
    await resumeEditor(session);
  }
}

async function returnOriginalControls(submissionId, userId) {
  const row = await getSubmission(submissionId);
  if (await canEdit(row, userId)) {
    await sendToUser(userId, controlsBody(row.id, row.title));
  }
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
    console.log("EDIT DRAFT SAVED:", row.id);
    await showDraft(changed.rows[0]);
  }
  return true;
}

async function publishPrepared(row, userId, callbackId, body, session = null) {
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
      UPDATE submissions SET status = 'published', published_mid = $2, last_error = NULL
      WHERE id = $1
    `, [row.id, messageId(published)]);
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
  console.log("SUBMISSION PUBLISHED ANONYMOUSLY:", row.id);
}

async function handleCallback(update) {
  const callback = update.callback;
  const userId = callback?.user?.user_id;
  const payload = typeof callback?.payload === "string" ? callback.payload : "";
  const basic = payload.match(/^(publish|reject|edit|preview)_(\d+)$/);
  const draft = payload.match(/^(draftpublish|again|cancel|draftpreview)_(\d+)_([a-f0-9]{24})$/);
  if ((!basic && !draft) || userId == null) return;
  const [, action, id] = draft || basic;
  const row = await getSubmission(id);
  if (!row || String(row.owner_user_id) !== String(userId)) {
    await answerCallback(callback.callback_id);
    console.log("UNAUTHORIZED OR MISSING CALLBACK");
    return;
  }
  // Снимаем ожидание кнопки. Саму карточку уберём только после завершения.
  await answerCallback(callback.callback_id);
  if (!row.active || !(await checkAdministrator(row.max_chat_id, userId))) {
    await notify(userId, "Канал отключён или у вас больше нет прав администратора.");
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
      publishing: "публикуется", needs_check: "нужно проверить результат в канале"
    };
    await notify(userId,
      `Предложка #${id}: ${labels[row.status] || row.status}. Повторная публикация не выполнена.`);
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
    await publishPrepared(row, userId, callback.callback_id, session.draft_body, session);
    return;
  }

  if (action === "reject") {
    const changed = await pool.query(
      "UPDATE submissions SET status = 'rejected' WHERE id = $1 AND status = 'new' RETURNING id", [id]);
    if (!changed.rowCount) return;
    await pool.query("DELETE FROM ep_editor_sessions WHERE submission_id = $1", [id]);
    await answerCallback(callback.callback_id, `🗑 Предложка #${id} отклонена.`, true);
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
    const controls = controlsBody(id, row.title);
    controls.text = `👁 Предпросмотр предложки #${id}\nКанал: «${row.title}»\n\n` +
      `Выше исходный вариант без ссылки на отправителя. В канал он ещё не отправлен.`;
    await sendToUser(userId, controls);
    return;
  }
  await publishPrepared(row, userId, callback.callback_id, body);
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
