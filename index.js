import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import https from "node:https";
import tls from "node:tls";

// EveryPost: предложка, анонимная публикация, редактор, права, черновики и расписание.
// Версия menu-chat-1. Быстрые команды MAX и отдельный чат обсуждений для канала.
// Это не нативная привязка комментариев MAX: кнопка открывает общую группу.
// Автокопирование только новых постов EveryPost — по отдельному включению владельцем.
// Существующие черновики и отложенные сохраняют свои снимки оформления.
// PATCH /me/commands регистрирует список команд; расположение кнопки задаёт приложение.
// Основа: formatting-1. Автоподписи и URL-кнопки сохранены.
// Исходный материал и оформленный body хранятся отдельно. Отложенные сохраняют снимок.
// Основа: schedule-2. Системный планировщик работает только при запущенном процессе.
// На Free нет гарантии отправки в срок. Просроченные >5 минут задания удерживаются.
// Черновики сохраняются в PostgreSQL. Медиа остаются вложениями MAX по токенам;
// эта версия не создаёт собственную бессрочную резервную копию медиафайлов.
// Оригинальная предложка не удаляется при сохранении или удалении её черновика.
// Назначения относятся только к EveryPost, права в самом MAX не изменяются.
// ИИ не подключён. Режим модерации на этой версии только manual.
// Режим администратора открывается командой /menu в личном чате с ботом.
// Полный файл для существующего everypost-max-bot. Новые секреты не нужны.
// Контент предложки и редакторский черновик хранятся отдельно.
// Документация API: https://dev.max.ru/docs-api/methods/POST/messages
const VERSION = "menu-chat-1";
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
  const result = queueMaxWrite(`/messages?${kind}=${encodeURIComponent(id)}`, "POST", body);
  if (kind !== "chat_id") return result;
  return result.then(async sent => {
    await safeRememberDiscussion(id, body, sent);
    return sent;
  });
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

// ---------- Оформление: база отдельно от готового сообщения ----------
// Снимок настроек принадлежит конкретному посту. Мы не дописываем подпись
// к уже оформленному body и не меняем body_snapshot отложенных публикаций.
const MAX_CUSTOM_LINKS = 8; // Ограничение интерфейса EveryPost, не лимит MAX.
const SIGNATURE_LIMIT = 700;
const emptyPostStyle = () => ({ signature: null, signature_on: false,
  proposal_on: false, proposal_url: null, discussion_on: false, discussion_url: null,
  discussion_group_id: null, buttons: [] });
const copyJson = value => JSON.parse(JSON.stringify(value));

function normalizedLinkUrl(value) {
  if (typeof value !== "string") throw new Error("Пришлите ссылку текстом.");
  const text = value.trim();
  if (!text || text.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error("Ссылка должна быть без пробелов, не длиннее 2048 символов.");
  }
  if (!safeWebUrl(text)) throw new Error("Нужна полная ссылка с https:// или http://, без логина и пароля.");
  const url = new URL(text);
  if (!url.hostname) throw new Error("В ссылке отсутствует адрес.");
  return text;
}
function normalizedButtonLabel(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || [...text].length > 40 || /[\r\n\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error("Название кнопки: от 1 до 40 символов, одной строкой.");
  }
  return text;
}
function validateStyle(value) {
  const s = { ...emptyPostStyle(), ...copyJson(value || {}) };
  if (s.signature != null) {
    if (typeof s.signature.text !== "string" || s.signature.text.length > SIGNATURE_LIMIT ||
        ![undefined, null, "html"].includes(s.signature.format)) {
      throw new Error("Некорректный формат автоподписи.");
    }
  }
  s.signature_on = s.signature_on === true;
  s.proposal_on = s.proposal_on === true;
  if (s.proposal_on) s.proposal_url = normalizedLinkUrl(s.proposal_url);
  s.discussion_on = s.discussion_on === true;
  if (s.discussion_on) s.discussion_url = groupLink(s.discussion_url);
  if (!Array.isArray(s.buttons) || s.buttons.length > MAX_CUSTOM_LINKS) {
    throw new Error(`В этом редакторе доступно до ${MAX_CUSTOM_LINKS} своих кнопок.`);
  }
  s.buttons = s.buttons.map(b => ({ text: normalizedButtonLabel(b?.text), url: normalizedLinkUrl(b?.url) }));
  return s;
}
function styleForChannel(channel) {
  const c = channel.post_style || {};
  return validateStyle({ signature: c.signature || null,
    signature_on: c.signature_on === true, proposal_on: c.proposal_on === true,
    proposal_url: `https://max.ru/${BOT_USERNAME}?start=${encodeURIComponent(channel.proposal_code)}`,
    discussion_on: channel.discussion_enabled === true && !!channel.discussion_group_id,
    discussion_url: channel.discussion_url || null,
    discussion_group_id: channel.discussion_group_id || null,
    buttons: [] });
}
function composeStyledPost(base, inputStyle) {
  if (!base || typeof base !== "object" || Object.hasOwn(base,"link") || Object.hasOwn(base,"sender")) {
    throw new Error("Нельзя оформить пересылку. Нужен самостоятельный пост.");
  }
  const style = validateStyle(inputStyle);
  const body = copyJson(base);
  const media = Array.isArray(body.attachments) ? body.attachments : [];
  if (media.some(a => a?.type === "inline_keyboard")) {
    throw new Error("В базовом материале уже есть клавиатура. Откройте материал заново.");
  }
  if (style.signature_on && style.signature?.text?.trim()) {
    if (body.format && body.format !== "html") throw new Error("Этот формат текста пока нельзя объединить с подписью.");
    const formatted = body.format === "html" || style.signature.format === "html";
    const raw = typeof body.text === "string" ? body.text : "";
    const main = formatted && body.format !== "html" ? escapeHtml(raw) : raw;
    const tail = formatted && style.signature.format !== "html" ? escapeHtml(style.signature.text) : style.signature.text;
    body.text = main ? `${main}\n\n${tail}` : tail;
    if (formatted) body.format = "html";
  }
  if ((body.text || "").length > 4000) {
    throw new Error("Пост вместе с автоподписью длиннее 4000 символов. Отключите подпись для этого поста или сократите текст.");
  }
  const links = [...style.buttons];
  if (style.proposal_on && !links.some(b => b.url === style.proposal_url)) {
    links.push({ text: "📥 Предложить новость", url: style.proposal_url });
  }
  if (style.discussion_on && !links.some(b => b.url === style.discussion_url)) {
    links.push({ text: "💬 Чат канала", url: style.discussion_url });
  }
  if (links.length && media.length >= 12) {
    throw new Error("В посте уже 12 вложений. Для кнопок нужно одно свободное место: отключите кнопки либо оставьте не больше 11 вложений.");
  }
  if (links.length && media.some(a => a.type === "sticker")) {
    throw new Error("Кнопки со стикером в этом редакторе не поддержаны. Уберите кнопки или замените материал.");
  }
  if (links.length) body.attachments = [...media, { type: "inline_keyboard", payload: {
    buttons: links.map(b => [{ type: "link", text: b.text, url: b.url }])
  }}];
  if (!body.text?.trim() && !media.length) throw new Error("В посте нет текста или медиа.");
  return body;
}
function styleControls(kind, nonce, style) {
  const s = style || emptyPostStyle();
  return [
    [button(`Подпись: ${s.signature_on && s.signature?.text ? "вкл" : "выкл"}`, `fmt_sig_${kind}_${nonce}`),
     button(s.buttons?.length ? `🔗 Кнопки: ${s.buttons.length}` : "🔗 Добавить кнопку", `fmt_${s.buttons?.length ? "links" : "add"}_${kind}_${nonce}`)],
    [button(`Кнопка предложки: ${s.proposal_on ? "вкл" : "выкл"}`, `fmt_prop_${kind}_${nonce}`)],
    [button(`Чат канала: ${s.discussion_on ? "вкл" : "выкл"}`, `fmt_chat_${kind}_${nonce}`)]
  ];
}
async function submissionStyle(row) {
  if (row.post_style) return validateStyle(row.post_style);
  const channel = await getChannel(row.channel_id);
  if (!channel) throw new Error("Канал не найден.");
  const saved = await pool.query(`UPDATE submissions SET post_style=COALESCE(post_style,$2::jsonb)
    WHERE id=$1 RETURNING post_style`, [row.id,JSON.stringify(styleForChannel(channel))]);
  if (!saved.rowCount) throw new Error("Предложка не найдена.");
  return validateStyle(saved.rows[0].post_style);
}
async function styledSubmissionBody(row) {
  return composeStyledPost(buildAnonymousPost(await loadSubmissionSource(row)), await submissionStyle(row));
}

// ---------- Настройки владельца ----------
async function showStyleSettings(channelId, userId) {
  const c = await requireOwner(channelId,userId); if (!c) return;
  const s = c.post_style || {};
  if (s.signature?.text) await sendToUser(userId,copyJson(s.signature));
  await sendToUser(userId,{ text:`Автоподпись · «${shortTitle(c.title)}»\n\n`+
    (s.signature?.text ? "Выше показана сохранённая подпись." : "Автоподпись ещё не задана.")+"\n"+
    "Пришлите подпись с нужным оформлением и ссылками через кнопку «Изменить подпись».\n\n"+
    "Настройки применяются при подготовке новых постов. Существующие черновики, предпросмотры и отложенные не меняются.",
    attachments:keyboard([
      [button(s.signature?.text?"✏️ Изменить подпись":"✏️ Добавить подпись",`fmt_chinput_${c.id}_${c.style_version}`)],
      [button(`Автоподпись: ${s.signature_on?"вкл":"выкл"}`,`fmt_chsig_${c.id}_${c.style_version}_${s.signature_on?0:1}`)],
      [button(`Кнопка предложки: ${s.proposal_on?"вкл":"выкл"}`,`fmt_chprop_${c.id}_${c.style_version}_${s.proposal_on?0:1}`)],
      ...(s.signature?.text?[[button("🗑 Удалить подпись",`fmt_chdel_${c.id}_${c.style_version}`)]]:[]),
      [button("↩️ К каналу",`access_channel_${c.id}`)]
    ])});
}
async function saveChannelStyle(c,userId,next,expectedVersion) {
  const current=await requireOwner(c.id,userId);if(!current)return false;
  const result=await pool.query(`UPDATE channels SET post_style=$2::jsonb,style_version=style_version+1,
    updated_at=NOW() WHERE id=$1 AND style_version=$3 AND owner_user_id=$4 AND active=TRUE RETURNING *`,
    [c.id,JSON.stringify(next),expectedVersion,userId]);
  if(!result.rowCount){await notify(userId,"Настройки уже изменились. Откройте «Автоподпись» заново.");return false;}
  await audit(c.id,userId,"channel_style_changed",null,{signature_on:!!next.signature_on,proposal_on:!!next.proposal_on});
  return true;
}

// ---------- Доступ и изменения оформления конкретного предпросмотра ----------
async function formatTarget(kind,nonce,userId) {
  if(await getScheduleSession(userId))return null;
  const session=kind==="p"?await getComposer(userId):await getEditorSession(userId);
  if(!session||session.nonce!==nonce||session.stage!=="preview")return null;
  const row=kind==="p"?await getOwnPost(session.post_id):await getSubmission(session.submission_id);
  if(kind==="p" ? !row||row.status!=="draft"||!(await canUseOwnPost(row,userId)) : !(await canEdit(row,userId)))return null;
  const access=await channelAccess(row.channel_id,userId,kind==="e"||row.source_submission_id?"moderate":"create");
  if(!access)return null;
  return {kind,nonce,userId,session,row,access,
    base:kind==="p"?(row.base_body||row.body):(session.base_body||session.draft_body),
    style:validateStyle((kind==="p"?row.post_style:session.post_style)||emptyPostStyle())};
}
async function renderFormatTarget(target,force=false) {
  const current=await formatTarget(target.kind,target.nonce,target.userId);
  if(!current)return;
  if(force){
    if(current.kind==="p")await pool.query("UPDATE ep_posts SET preview_mid=NULL,controls_mid=NULL WHERE id=$1 AND status='draft'",[current.row.id]);
    else await pool.query("UPDATE ep_editor_sessions SET preview_mid=NULL,controls_mid=NULL WHERE actor_user_id=$1 AND nonce=$2",[current.userId,current.nonce]);
  }
  if(current.kind==="p")await showOwnPostPreview(await getComposer(current.userId));
  else await showDraft(await getEditorSession(current.userId));
}
async function changeTargetStyle(target,next,input=null) {
  const current=await formatTarget(target.kind,target.nonce,target.userId);
  if(!current||current.access.version!==target.access.version){
    await notify(target.userId,"Права или предпросмотр изменились. Оформление не сохранено.");return null;
  }
  const style=validateStyle(next),body=composeStyledPost(current.base,style),nonce=newEditNonce();
  const client=await pool.connect();let changed=false;
  try{
    await client.query("BEGIN");
    const table=target.kind==="p"?"ep_composer_sessions":"ep_editor_sessions";
    const lock=await client.query(`SELECT * FROM ${table} WHERE actor_user_id=$1 AND nonce=$2 AND stage='preview' FOR UPDATE`,[target.userId,target.nonce]);
    if(lock.rowCount){
      if(input){
        const receipt=await client.query(`INSERT INTO ep_style_inputs(max_message_id,actor_user_id)
          VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING max_message_id`,[input.mid,target.userId]);
        if(!receipt.rowCount){await client.query("ROLLBACK");return null;}
      }
      if(target.kind==="p"){
        const r=await client.query(`UPDATE ep_posts SET post_style=$2::jsonb,base_body=$3::jsonb,body=$4::jsonb,
          preview_mid=NULL,controls_mid=NULL,draft_revision=draft_revision+1,updated_at=NOW()
          WHERE id=$1 AND status='draft' RETURNING id`,[current.row.id,JSON.stringify(style),JSON.stringify(current.base),JSON.stringify(body)]);
        if(r.rowCount){
          await client.query("UPDATE ep_composer_sessions SET nonce=$3,updated_at=NOW() WHERE actor_user_id=$1 AND nonce=$2",[target.userId,target.nonce,nonce]);changed=true;
        }
      }else{
        const r=await client.query(`UPDATE ep_editor_sessions SET post_style=$3::jsonb,base_body=$4::jsonb,draft_body=$5::jsonb,
          nonce=$6,preview_mid=NULL,controls_mid=NULL,updated_at=NOW()
          WHERE actor_user_id=$1 AND nonce=$2 AND EXISTS(SELECT 1 FROM submissions s WHERE s.id=submission_id AND s.status='new') RETURNING *`,
          [target.userId,target.nonce,JSON.stringify(style),JSON.stringify(current.base),JSON.stringify(body),nonce]);changed=r.rowCount>0;
      }
      if(changed){
        if(input)await client.query("DELETE FROM ep_style_sessions WHERE actor_user_id=$1 AND nonce=$2",[target.userId,input.formNonce]);
        await audit(current.row.channel_id,target.userId,"post_style_changed",current.row.id,{kind:target.kind,links:style.buttons.length},client);
      }
    }
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
  if(!changed){await notify(target.userId,"Предпросмотр устарел. Изменение не применено.");return null;}
  return formatTarget(target.kind,nonce,target.userId);
}
async function showLinks(target) {
  const t=await formatTarget(target.kind,target.nonce,target.userId);
  if(!t){await notify(target.userId,"Предпросмотр устарел или права изменились. Откройте /menu.");return;}
  const links=t.style.buttons;
  await sendToUser(t.userId,{text:`🔗 Кнопки-ссылки · «${shortTitle(t.row.title)}»\n\n`+
    (links.length?links.map((b,i)=>`${i+1}. ${b.text}\n${b.url.slice(0,100)}${b.url.length>100?"…":""}`).join("\n\n"):"Своих кнопок пока нет.")+
    `\n\nКнопка предложки: ${t.style.proposal_on?"вкл":"выкл"}.\nКнопки будут показаны в предпросмотре.`,attachments:keyboard([
      ...links.map((b,i)=>[button(`✏️ ${b.text.slice(0,20)}`,`fmt_edit_${t.kind}_${t.nonce}_${i}`),button("🗑 Удалить",`fmt_del_${t.kind}_${t.nonce}_${i}`)]),
      ...(links.length<MAX_CUSTOM_LINKS?[[button("➕ Добавить кнопку",`fmt_add_${t.kind}_${t.nonce}`)]]:[]),
      [button("👁 К предпросмотру",`fmt_back_${t.kind}_${t.nonce}`)]
    ])});
}

// ---------- Короткие формы ввода: не смешиваются с текстом предложки ----------
async function getStyleInput(userId) {
  return (await pool.query("SELECT * FROM ep_style_sessions WHERE actor_user_id=$1",[userId])).rows[0]||null;
}
async function promptStyleInput(form) {
  const text=form.stage==="signature"
    ? `Пришлите подпись одним текстовым сообщением, до ${SIGNATURE_LIMIT} символов с оформлением. Можно выделить текст и вставить ссылки средствами MAX.\nВвод сохранит подпись и включит её для новых постов. HTML-код вручную писать не нужно.`
    : form.stage==="button_label"
      ? "Пришлите название кнопки одной строкой, например «Подробнее». До 40 символов."
      : `Кнопка «${form.label}». Пришлите полную ссылку, начиная с https:// или http://.`;
  await sendToUser(form.actor_user_id,{text:text+"\n\nОтмена этого ввода: /cancel.",attachments:keyboard([
    [button("↩️ Отменить ввод",`fmt_inputcancel_${form.nonce}`)]
  ])});
}
async function startStyleInput(c,userId,version,target=null,index=null) {
  const existing=await getStyleInput(userId);
  if(existing){await promptStyleInput(existing);return;}
  if(await getScheduleSession(userId)){await notify(userId,"Сначала завершите выбор времени.");return;}
  if(!target&&(await getComposer(userId)||await getEditorSession(userId))){
    await notify(userId,"Сначала сохраните или закройте текущий пост. Настройки подписи канала меняются отдельно.");return;
  }
  const access=target?.access||await channelAccess(c.id,userId,"manage");
  if(!access||(!target&&!access.owner))return;
  const made=await pool.query(`INSERT INTO ep_style_sessions(actor_user_id,channel_id,nonce,kind,target_id,
    target_nonce,access_version,stage,button_index,expected_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING *`,
    [userId,c.id,newEditNonce(),target?.kind||"channel",target?.row.id||null,target?.nonce||null,
      access.version,target?"button_label":"signature",index,version]);
  if(made.rowCount){
    await pool.query("DELETE FROM proposal_sessions WHERE max_user_id=$1",[userId]);
    await promptStyleInput(made.rows[0]);
  }
}
async function cancelStyleInput(form) {
  await pool.query("DELETE FROM ep_style_sessions WHERE actor_user_id=$1 AND nonce=$2",[form.actor_user_id,form.nonce]);
  await notify(form.actor_user_id,"Ввод отменён. Оформление не изменено.");
  if(form.kind==="channel")await showStyleSettings(form.channel_id,form.actor_user_id);
  else{
    const t=await formatTarget(form.kind,form.target_nonce,form.actor_user_id);
    if(t)await renderFormatTarget(t);
  }
}
async function rememberStyleInput(mid,userId) {
  await pool.query("INSERT INTO ep_style_inputs(max_message_id,actor_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",[mid,userId]);
}
async function handleStyleMessage(message) {
  const userId=message.sender.user_id,mid=message.body.mid;
  if((await pool.query("SELECT 1 FROM ep_style_inputs WHERE max_message_id=$1",[mid])).rowCount)return true;
  const form=await getStyleInput(userId);if(!form)return false;
  const text=typeof message.body.text==="string"?message.body.text:"";
  const command=!message.link&&!(message.body.attachments||[]).length?text.trim().toLowerCase():"";
  if(["/cancel","/отмена"].includes(command)){
    await rememberStyleInput(mid,userId);await cancelStyleInput(form);return true;
  }
  if(new Date(form.expires_at).getTime()<=Date.now()){
    await rememberStyleInput(mid,userId);
    await pool.query("DELETE FROM ep_style_sessions WHERE actor_user_id=$1 AND nonce=$2",[userId,form.nonce]);
    await notify(userId,"Время ввода истекло. Оформление не изменено, сообщение не отправлено в предложку. Откройте /menu.");return true;
  }
  let target=null,channel=null;
  if(form.kind==="channel")channel=await requireOwner(form.channel_id,userId);
  else target=await formatTarget(form.kind,form.target_nonce,userId);
  if(form.kind==="channel"?!channel:!target||target.access.version!==Number(form.access_version)){
    await rememberStyleInput(mid,userId);
    await pool.query("DELETE FROM ep_style_sessions WHERE actor_user_id=$1 AND nonce=$2",[userId,form.nonce]);
    await notify(userId,"Права или пост изменились. Ввод закрыт без сохранения. Сообщение не опубликовано.");return true;
  }
  if(["/menu","/start","меню"].includes(command)){
    await rememberStyleInput(mid,userId);await promptStyleInput(form);return true;
  }
  try{
    if(message.link||!text.trim()||(message.body.attachments||[]).some(a=>a?.type!=="share")){
      throw new Error("На этом шаге нужен обычный текст, без пересылки, фото и видео.");
    }
    if(form.stage==="signature"){
      const r=renderBodyText(message.body);
      const signature={text:r.formatted?r.html:r.text};if(r.formatted)signature.format="html";
      if(signature.text.length>SIGNATURE_LIMIT)throw new Error(`Подпись с оформлением длиннее ${SIGNATURE_LIMIT} символов.`);
      const next={...(channel.post_style||{}),signature,signature_on:true};
      const client=await pool.connect();let saved=false;
      try{
        await client.query("BEGIN");
        const receipt=await client.query("INSERT INTO ep_style_inputs(max_message_id,actor_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING max_message_id",[mid,userId]);
        if(receipt.rowCount){
          const updated=await client.query(`UPDATE channels SET post_style=$2::jsonb,style_version=style_version+1,updated_at=NOW()
            WHERE id=$1 AND owner_user_id=$3 AND style_version=$4 AND active=TRUE RETURNING id`,
            [channel.id,JSON.stringify(next),userId,form.expected_version]);
          saved=updated.rowCount>0;
          await client.query("DELETE FROM ep_style_sessions WHERE actor_user_id=$1 AND nonce=$2",[userId,form.nonce]);
          if(saved)await audit(channel.id,userId,"signature_saved",null,{},client);
        }
        await client.query("COMMIT");
      }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
      await notify(userId,saved?"✅ Автоподпись сохранена и включена для новых постов.":"Настройки уже изменились. Повторите ввод из новой карточки.");
      await showStyleSettings(channel.id,userId);return true;
    }
    if(form.stage==="button_label"){
      const label=normalizedButtonLabel(text);
      const client=await pool.connect();let changed;
      try{
        await client.query("BEGIN");
        const receipt=await client.query("INSERT INTO ep_style_inputs(max_message_id,actor_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING max_message_id",[mid,userId]);
        if(receipt.rowCount)changed=await client.query("UPDATE ep_style_sessions SET stage='button_url',label=$3 WHERE actor_user_id=$1 AND nonce=$2 AND stage='button_label' RETURNING *",[userId,form.nonce,label]);
        await client.query("COMMIT");
      }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
      if(changed?.rowCount)await promptStyleInput(changed.rows[0]);return true;
    }
    const url=normalizedLinkUrl(text),next=copyJson(target.style);
    if(form.button_index==null){
      if(next.buttons.length>=MAX_CUSTOM_LINKS)throw new Error(`Можно добавить до ${MAX_CUSTOM_LINKS} своих кнопок.`);
      next.buttons.push({text:form.label,url});
    }else{
      if(!next.buttons[Number(form.button_index)])throw new Error("Этой кнопки больше нет.");
      next.buttons[Number(form.button_index)]={text:form.label,url};
    }
    const changed=await changeTargetStyle(target,next,{mid,formNonce:form.nonce});
    if(changed){await renderFormatTarget(changed);console.log("POST LINK SAVED:",changed.row.id);}
    return true;
  }catch(error){
    // Неверный ввод не становится ни предложкой, ни текстом публикации.
    await rememberStyleInput(mid,userId);
    await notify(userId,`${error.message}\nИзменение не применено. Повторите ввод или /cancel.`);
    return true;
  }
}
async function handleStyleCallback(update) {
  const cb=update.callback,userId=cb?.user?.user_id,value=typeof cb?.payload==="string"?cb.payload:"";
  if(userId==null)return false;
  const form=await getStyleInput(userId);
  if(form){
    await answerCallback(cb.callback_id);
    if(value===`fmt_inputcancel_${form.nonce}`)await cancelStyleInput(form);
    else if(new Date(form.expires_at).getTime()<=Date.now())await cancelStyleInput(form);
    else await promptStyleInput(form);
    return true;
  }
  if(!value.startsWith("fmt_"))return false;
  await answerCallback(cb.callback_id);
  const timing=await getScheduleSession(userId);
  if(timing){await renderSchedulePicker(timing);return true;}
  const channelAction=value.match(/^fmt_ch(open|input|sig|prop|del)_(\d+)(?:_(\d+))?(?:_([01]))?$/);
  if(channelAction){
    const [,action,id,version,on]=channelAction;
    const c=await requireOwner(id,userId);if(!c)return true;
    if(action==="open"){await showStyleSettings(id,userId);return true;}
    if(Number(version)!==Number(c.style_version)){await notify(userId,"Настройки изменились. Используйте новую карточку.");await showStyleSettings(id,userId);return true;}
    if(action==="input"){await startStyleInput(c,userId,Number(version));return true;}
    const next=copyJson(c.post_style||{});
    if(action==="sig"){
      if(on==="1"&&!next.signature?.text){await notify(userId,"Сначала добавьте текст автоподписи.");await showStyleSettings(id,userId);return true;}
      next.signature_on=on==="1";
    }else if(action==="prop")next.proposal_on=on==="1";
    else {next.signature=null;next.signature_on=false;}
    await saveChannelStyle(c,userId,next,Number(version));await showStyleSettings(id,userId);return true;
  }
  const sub=value.match(/^fmt_sub_(\d+)(?:_a(\d+))?$/);
  if(sub){
    const row=await getSubmission(sub[1]);
    const access=row?await channelAccess(row.channel_id,userId,"moderate"):null;
    if(!access||(!access.owner&&access.version!==Number(sub[2]))){await notify(userId,"Нет доступа к предложке.");return true;}
    const saved=await saveSubmissionDraft(row,userId,cb.callback_id,null,true,true);
    if(saved)await openSavedDraft(saved.id,userId);
    return true;
  }
  const action=value.match(/^fmt_(sig|prop|chat|links|add|edit|del|back)_([pe])_([a-f0-9]{24})(?:_(\d+))?$/);
  if(!action){await notify(userId,"Карточка оформления устарела. Откройте последний предпросмотр.");return true;}
  const [,verb,kind,nonce,index]=action,t=await formatTarget(kind,nonce,userId);
  if(!t){await notify(userId,"Предпросмотр устарел или права изменились. Откройте /menu.");return true;}
  try{
    if(verb==="links"){await showLinks(t);return true;}
    if(verb==="back"){await renderFormatTarget(t,true);return true;}
    if(["add","edit"].includes(verb)){
      if(verb==="edit"&&!t.style.buttons[Number(index)])throw new Error("Кнопка не найдена.");
      if(verb==="add"&&t.style.buttons.length>=MAX_CUSTOM_LINKS)throw new Error(`Можно добавить до ${MAX_CUSTOM_LINKS} своих кнопок.`);
      await startStyleInput(t.access.channel,userId,0,t,verb==="edit"?Number(index):null);return true;
    }
    const next=copyJson(t.style);
    if(verb==="sig"){
      if(!next.signature?.text){
        const defaults=styleForChannel(t.access.channel);
        if(!defaults.signature?.text)throw new Error("Сначала сохраните или закройте пост, затем добавьте подпись: «Мои каналы» → канал → «Автоподпись».");
        next.signature=defaults.signature;next.signature_on=true;
      }else next.signature_on=!next.signature_on;
    }else if(verb==="prop"){
      next.proposal_on=!next.proposal_on;
      // URL всегда строит сервер для канала материала, его нельзя подменить callback.
      next.proposal_url=styleForChannel(t.access.channel).proposal_url;
    }else if(verb==="chat"){
      if(next.discussion_on) next.discussion_on=false;
      else {
        const defaults=styleForChannel(t.access.channel);
        if(!defaults.discussion_on||!defaults.discussion_url)throw new Error("Сначала подключите чат: «Мои каналы» → канал → «Чат канала».");
        next.discussion_on=true;next.discussion_url=defaults.discussion_url;
        next.discussion_group_id=defaults.discussion_group_id;
      }
    }else if(verb==="del"){
      if(!next.buttons[Number(index)])throw new Error("Кнопка не найдена.");
      next.buttons.splice(Number(index),1);
    }
    const changed=await changeTargetStyle(t,next);if(changed)await renderFormatTarget(changed);
  }catch(error){await notify(userId,`${error.message}\nПост не опубликован, прежнее оформление сохранено.`);}
  return true;
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
  await pool.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Europe/Moscow';
    CREATE TABLE IF NOT EXISTS ep_schedules (
      id BIGSERIAL PRIMARY KEY,
      post_id BIGINT UNIQUE NOT NULL REFERENCES ep_posts(id),
      status TEXT NOT NULL DEFAULT 'scheduled',
      due_at TIMESTAMPTZ NOT NULL,
      timezone TEXT NOT NULL,
      scheduled_by BIGINT NOT NULL,
      access_version INTEGER NOT NULL,
      body_snapshot JSONB NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMPTZ,
      dispatch_started_at TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      published_mid TEXT,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ep_schedules_due ON ep_schedules(due_at)
      WHERE status = 'scheduled';
    CREATE UNIQUE INDEX IF NOT EXISTS ep_post_source_schedule_once
      ON ep_posts(source_submission_id)
      WHERE source_submission_id IS NOT NULL
        AND status IN ('draft', 'scheduled', 'publishing', 'needs_check', 'published');
    CREATE TABLE IF NOT EXISTS ep_schedule_sessions (
      actor_user_id BIGINT PRIMARY KEY,
      post_id BIGINT UNIQUE NOT NULL REFERENCES ep_posts(id),
      nonce TEXT UNIQUE NOT NULL,
      schedule_id BIGINT REFERENCES ep_schedules(id),
      expected_revision INTEGER NOT NULL DEFAULT 0,
      draft_revision INTEGER NOT NULL,
      access_version INTEGER NOT NULL,
      timezone TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'day',
      day_key TEXT NOT NULL,
      month_key TEXT NOT NULL,
      hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
      minute INTEGER NOT NULL CHECK (minute BETWEEN 0 AND 59),
      card_mid TEXT,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes')
    );
    CREATE TABLE IF NOT EXISTS ep_schedule_inputs (
      max_message_id TEXT PRIMARY KEY,
      actor_user_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS post_style JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS style_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS post_style JSONB;
    ALTER TABLE ep_posts ADD COLUMN IF NOT EXISTS base_body JSONB;
    ALTER TABLE ep_posts ADD COLUMN IF NOT EXISTS post_style JSONB;
    ALTER TABLE ep_editor_sessions ADD COLUMN IF NOT EXISTS base_body JSONB;
    ALTER TABLE ep_editor_sessions ADD COLUMN IF NOT EXISTS post_style JSONB;
    CREATE TABLE IF NOT EXISTS ep_style_sessions (
      actor_user_id BIGINT PRIMARY KEY,
      channel_id BIGINT NOT NULL REFERENCES channels(id),
      nonce TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('channel','p','e')),
      target_id BIGINT,
      target_nonce TEXT,
      access_version INTEGER NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('signature','button_label','button_url')),
      button_index INTEGER,
      label TEXT,
      expected_version INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes')
    );
    CREATE TABLE IF NOT EXISTS ep_style_inputs (
      max_message_id TEXT PRIMARY KEY,
      actor_user_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Старые черновики и уже подготовленные редакторские варианты не меняют вид.
    UPDATE ep_posts SET base_body=body, post_style='{}'::jsonb
      WHERE body IS NOT NULL AND post_style IS NULL;
    UPDATE ep_editor_sessions SET base_body=draft_body, post_style='{}'::jsonb
      WHERE draft_body IS NOT NULL AND post_style IS NULL;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ep_command_inputs (
      max_message_id TEXT PRIMARY KEY,
      actor_user_id BIGINT NOT NULL,
      handled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ep_discussion_groups (
      chat_id BIGINT PRIMARY KEY,
      title TEXT NOT NULL,
      invite_url TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ep_group_registrations (
      chat_id BIGINT NOT NULL REFERENCES ep_discussion_groups(chat_id),
      user_id BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(chat_id,user_id)
    );
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS discussion_group_id BIGINT;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS discussion_url TEXT;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS discussion_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS discussion_copy BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS discussion_version INTEGER NOT NULL DEFAULT 0;
    CREATE UNIQUE INDEX IF NOT EXISTS ep_one_group_per_channel
      ON channels(discussion_group_id) WHERE discussion_group_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ep_discussion_intents (
      nonce TEXT PRIMARY KEY,
      channel_id BIGINT NOT NULL REFERENCES channels(id),
      owner_user_id BIGINT NOT NULL,
      group_id BIGINT NOT NULL REFERENCES ep_discussion_groups(chat_id),
      invite_url TEXT NOT NULL,
      expected_version INTEGER NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
    );
    CREATE TABLE IF NOT EXISTS ep_discussion_jobs (
      id BIGSERIAL PRIMARY KEY,
      channel_id BIGINT NOT NULL REFERENCES channels(id),
      group_id BIGINT NOT NULL REFERENCES ep_discussion_groups(chat_id),
      link_version INTEGER NOT NULL,
      channel_mid TEXT NOT NULL,
      body_snapshot JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      dispatch_started_at TIMESTAMPTZ,
      group_mid TEXT,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(channel_id,channel_mid)
    );
    CREATE INDEX IF NOT EXISTS ep_discussion_pending
      ON ep_discussion_jobs(id) WHERE status IN ('pending','sending');
  `);
  console.log("DATABASE READY");
}

async function checkAdministrator(chatId, userId) {
  const member = await maxAdministrator(chatId, userId);
  return Boolean(member && !member.is_bot && (member.is_owner || member.is_admin));
}

async function handleBotAdded(update) {
  if (update.is_channel === false) return handleDiscussionAdded(update);
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
  const styleInput=await getStyleInput(userId);
  if(styleInput){await promptStyleInput(styleInput);return;}
  const timing = await getScheduleSession(userId);
  if (timing) {
    await notify(userId, "Сначала завершите выбор времени или отправьте /cancel. Затем откройте ссылку предложки заново.");
    await renderSchedulePicker(timing); return;
  }
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
      [action("savedraft", "💾 Сохранить черновик"), action("schedule", "🕒 Отложить")],
      [button("🎨 Оформление и кнопки", `fmt_sub_${submissionId}${suffix}`)]
    ])
  };
}

async function handleMessage(update) {
  const message = update.message;
  const sender = message?.sender;
  const mid = message?.body?.mid;
  if (!sender || sender.is_bot || sender.user_id == null || !mid) return;
  const chatType = message.recipient?.chat_type;
  if (chatType === "chat") { await registerExistingGroupMessage(message); return; }
  if (chatType && chatType !== "dialog") return;
  await rememberUser(sender);
  if (await handleQuickCommand(message)) return;
  if(await handleStyleMessage(message))return;
  // Повторная доставка уже записанной предложки сохраняет прежнее назначение.
  let found = await pool.query(`
    SELECT s.*, c.title, c.owner_user_id, c.max_chat_id, c.active
    FROM submissions s JOIN channels c ON c.id = s.channel_id
    WHERE s.max_message_id = $1 ORDER BY s.id LIMIT 1
  `, [mid]);
  if (!found.rowCount) {
    // Собственные посты и правки обрабатываются до входящих предложок.
    if (await handleScheduleMessage(message)) return;
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
      ...styleControls("e", session.nonce, session.post_style),
      [editorButton("editsave", session, "💾 Сохранить черновик"),
       editorButton("editschedule", session, "🕒 Отложить")],
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
      // Собираем строго из базового текста: повторный просмотр не удваивает подпись.
      current.draft_body = composeStyledPost(current.base_body || current.draft_body, current.post_style);
      await pool.query(`UPDATE ep_editor_sessions SET draft_body=$3::jsonb
        WHERE actor_user_id=$1 AND nonce=$2 AND stage='preview'`,
        [current.actor_user_id,current.nonce,JSON.stringify(current.draft_body)]);
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
      text: `Не удалось полностью показать предпросмотр #${row.id}. ${error.message.slice(0,500)}\n` +
        `Материал сохранён, в канале ничего не опубликовано.`,
      attachments: keyboard([
        [editorButton("draftpreview", current, "🔄 Показать предпросмотр")],
        ...styleControls("e",current.nonce,current.post_style),
        [editorButton("again", current, "✏️ Изменить текст")],
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

  let draftBody, baseBody, postStyle;
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
    baseBody = buildAnonymousPost(source, {
      text,
      markup: Array.isArray(message.body.markup) ? message.body.markup : []
    });
    postStyle = session.post_style || await submissionStyle(row);
    // Оформление проверяется в showDraft до выдачи кнопки публикации.
    draftBody = baseBody;
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
          draft_text = $5, input_mid = $6, base_body = $7::jsonb, post_style = $8::jsonb, preview_mid = NULL,
          controls_mid = NULL, updated_at = NOW()
        WHERE actor_user_id = $1 AND nonce = $2 AND stage = 'waiting_text'
          AND EXISTS (SELECT 1 FROM submissions s
            WHERE s.id = ep_editor_sessions.submission_id AND s.status = 'new')
        RETURNING *
      `, [userId, session.nonce, nextNonce, JSON.stringify(draftBody), text, mid, JSON.stringify(baseBody), JSON.stringify(postStyle)]);
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
  if (await handleStyleCallback(update)) return;
  if (await handleDiscussionCallback(update)) return;
  if (await handleSchedulingCallback(update)) return;
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
    body = await styledSubmissionBody(row);
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
      [button("🕒 Часовой пояс канала", `tz_open_${c.id}`)],
      [button("Автоподпись", `fmt_chopen_${c.id}`)],
      [button("💬 Чат канала", `dc_open_${c.id}`)],
      [button(`Кнопка предложки: ${c.post_style?.proposal_on ? "вкл" : "выкл"}`,
        `fmt_chprop_${c.id}_${c.style_version}_${c.post_style?.proposal_on ? 0 : 1}`)],
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
  let pausedSchedules = 0;
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
      const pausedResult = await client.query(`
        UPDATE ep_schedules AS q SET status = 'paused', revision = q.revision + 1,
          last_error = 'Права назначившего публикацию админа отозваны. Владелец может назначить время заново.', updated_at = NOW()
        FROM ep_posts p WHERE q.post_id = p.id AND p.channel_id = $1
          AND q.scheduled_by = $2 AND q.status = 'scheduled'
          AND ($3 = 'revoke' OR p.source_submission_id IS NULL) RETURNING q.id
      `, [c.id, intent.target_user_id, intent.action]);
      pausedSchedules = pausedResult.rowCount;
      await client.query(`DELETE FROM ep_schedule_sessions WHERE actor_user_id = $1
        AND post_id IN (SELECT id FROM ep_posts WHERE channel_id = $2
          AND ($3 = 'revoke' OR source_submission_id IS NULL))`,
        [intent.target_user_id, c.id, intent.action]);
      // Сохранённый черновик возвращается к версии до незавершённой правки.
      await client.query(`
        UPDATE ep_posts AS p SET body = e.restore_snapshot->'body',
      base_body = COALESCE(e.restore_snapshot->'base_body',e.restore_snapshot->'body'),
      post_style = COALESCE(e.restore_snapshot->'post_style','{}'::jsonb),
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
    if (["allow_posts", "deny_posts"].includes(intent.action)) {
      // Версия общего доступа изменилась, но право на предложку осталось прежним.
      // При revoke старые задачи не возобновляются ни здесь, ни после повторного grant.
      await client.query(`UPDATE ep_schedules AS q SET access_version = $3
        FROM ep_posts p WHERE q.post_id = p.id AND p.channel_id = $1
          AND q.scheduled_by = $2 AND q.status = 'scheduled'
          AND ($4 = 'allow_posts' OR p.source_submission_id IS NOT NULL)`,
        [c.id, intent.target_user_id, changed.version, intent.action]);
    }
    await audit(c.id, ownerId, `access_${intent.action}`, intent.target_user_id,
      { version: changed.version, can_create_posts: changed.can_create_posts }, client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {}); throw error;
  } finally { client.release(); }
  const text = intent.action === "grant" ? "✅ Админ назначен."
    : intent.action === "revoke" ? "✅ Админ разжалован." : "✅ Разрешение обновлено.";
  await notify(ownerId, `${text}\n${changed.display_name} · «${shortTitle(c.title)}»` +
    (pausedSchedules ? `\nПриостановлено отложенных постов: ${pausedSchedules}. Откройте «Отложенные», чтобы назначить время заново.` : ""));
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
      [button("📝 Черновики", "menu_drafts_0"), button("🕒 Отложенные", "menu_scheduled_all_0")],
      [button("📥 Предложки", "menu_inbox_0"), button("📁 Мои каналы", "menu_channels_0")]
    ])
  };
}

async function showAdminMenu(userId, switchMode = false) {
  const styleInput=await getStyleInput(userId);
  if(styleInput){await promptStyleInput(styleInput);return;}
  const timing = await getScheduleSession(userId);
  if (timing) { await renderSchedulePicker(timing); return; }
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
      [button("🕒 Отложить", `cschedule_${session.nonce}`)],
      ...styleControls("p",session.nonce,row.post_style),
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
      row.body = composeStyledPost(row.base_body || row.body, row.post_style);
      await pool.query(`UPDATE ep_posts SET body=$2::jsonb WHERE id=$1 AND status='draft'
        AND EXISTS(SELECT 1 FROM ep_composer_sessions e WHERE e.post_id=ep_posts.id AND e.nonce=$3 AND e.stage='preview')`,
        [row.id,JSON.stringify(row.body),current.nonce]);
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
      text: `Предпросмотр поста #${row.id} не удалось показать полностью. ${error.message.slice(0,500)}\n` +
        "Материал сохранён, в канале ничего не опубликовано.",
      attachments: keyboard([
        [button("🔄 Показать предпросмотр", `crefresh_${current.nonce}`)],
        ...styleControls("p",current.nonce,row.post_style),
        [button("✏️ Изменить текст",`ctext_${current.nonce}`), button("📎 Заменить материал",`creplace_${current.nonce}`)],
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
  let source, postStyle;

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
    postStyle = row.post_style || styleForChannel(await getChannel(row.channel_id));
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
            base_body = $4::jsonb, post_style = $6::jsonb,
            preview_mid = NULL, controls_mid = NULL, last_error = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'draft'
      AND (author_user_id = $2 OR EXISTS (
        SELECT 1 FROM channels c WHERE c.id = ep_posts.channel_id AND c.owner_user_id = $2))
    RETURNING id
        `, [row.id, userId, JSON.stringify(source), JSON.stringify(postBody), mid, JSON.stringify(postStyle)]);
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
  return { body: row.body, source_message: row.source_message, input_mid: row.input_mid ?? null,
    base_body: row.base_body || row.body, post_style: row.post_style || emptyPostStyle() };
}

async function restoreSavedComposer(session, client = pool) {
  await client.query(`
    UPDATE ep_posts AS p SET body = e.restore_snapshot->'body',
      base_body = COALESCE(e.restore_snapshot->'base_body',e.restore_snapshot->'body'),
      post_style = COALESCE(e.restore_snapshot->'post_style','{}'::jsonb),
      source_message = e.restore_snapshot->'source_message',
      input_mid = e.restore_snapshot->>'input_mid', preview_mid = NULL,
      controls_mid = NULL, updated_at = NOW()
    FROM ep_composer_sessions e
    WHERE e.post_id = p.id AND e.actor_user_id = $1 AND e.nonce = $2
      AND p.status = 'draft' AND p.is_saved = TRUE AND e.restore_snapshot IS NOT NULL
  `, [session.actor_user_id, session.nonce]);
}

async function saveComposerDraft(session, row, callbackId, silent = false) {
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
  if (silent) return saved.rows[0];
  await answerCallback(callbackId, `💾 Черновик #${row.id} сохранён. В канал ничего не отправлено.`, true);
  await notify(session.actor_user_id,
    `💾 Черновик #${row.id} сохранён для канала «${shortTitle(row.title)}».\n` +
    "Откройте /menu → «Черновики», когда будете готовы продолжить.");
  console.log("DRAFT SAVED:", row.id);
  await showAdminMenu(session.actor_user_id, true);
}

async function saveSubmissionDraft(row, userId, callbackId, session = null, silent = false, allowStyleFix = false) {
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
  let source, body, baseBody, postStyle;
  try {
    source = await loadSubmissionSource(row);
    baseBody = session ? (session.base_body || session.draft_body) : buildAnonymousPost(source);
    postStyle = session ? (session.post_style || emptyPostStyle()) : await submissionStyle(row);
    try { body = composeStyledPost(baseBody,postStyle); }
    catch (error) {
      // Переход «Оформление» должен оставаться доступным даже при 12 медиа
      // или слишком длинной подписи. Сохраняем базу, но не даём кнопку отправки
      // до успешно показанного нового предпросмотра.
      if (!allowStyleFix) throw error;
      body = baseBody;
    }
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
          source_submission_id, is_saved, saved_at, draft_revision, base_body, post_style)
        VALUES ($1, $2, 'draft', $3::jsonb, $4::jsonb, $5, TRUE, NOW(), 1, $6::jsonb, $7::jsonb) RETURNING *
      `, [row.channel_id, userId, JSON.stringify(source), JSON.stringify(body), row.id, JSON.stringify(baseBody), JSON.stringify(postStyle)]);
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
  if (silent) return post;
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
  if (await schedulePostLocked(postId, userId)) return;
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
  if (row && await schedulePostLocked(row.id, session.actor_user_id)) return;
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
  if (row && await schedulePostLocked(row.id, userId)) return;
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


// ---------- Отложенные публикации: выбор в боте, время в PostgreSQL ----------
// Нет внешнего пингера. На Render Free фоновые задачи выполняются только пока
// процесс активен. Опоздание больше 5 минут удерживает материал, а не публикует его.
// При сетевой неопределённости публикацию автоматически не повторяем.
const SCHEDULE_GRACE_MS = 5 * 60 * 1000;
const SCHEDULE_HORIZON_DAYS = 366;
const CHANNEL_ZONES = [
  ["Europe/Kaliningrad", "Калининград"], ["Europe/Moscow", "Москва"],
  ["Europe/Samara", "Самара"], ["Asia/Yekaterinburg", "Екатеринбург"],
  ["Asia/Omsk", "Омск"], ["Asia/Krasnoyarsk", "Красноярск"],
  ["Asia/Irkutsk", "Иркутск"], ["Asia/Yakutsk", "Якутск"],
  ["Asia/Vladivostok", "Владивосток"], ["Asia/Magadan", "Магадан"],
  ["Asia/Kamchatka", "Камчатка"]
];
const ruMonths = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const pad2 = n => String(n).padStart(2, "0");
function zoneAllowed(zone) { return CHANNEL_ZONES.some(([z]) => z === zone); }
function localParts(instant, zone) {
  if (!zoneAllowed(zone)) throw new Error("Неизвестный часовой пояс канала.");
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
}
function dateKey(parts) { return `${parts.year}${pad2(parts.month)}${pad2(parts.day)}`; }
function validDay(key) {
  if (!/^\d{8}$/.test(String(key))) return false;
  const y = Number(key.slice(0,4)), m = Number(key.slice(4,6)), d = Number(key.slice(6,8));
  const x = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y < 2200 && x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d;
}
function shiftDay(key, days) {
  if (!validDay(key)) throw new Error("Некорректная дата.");
  const x = new Date(Date.UTC(Number(key.slice(0,4)), Number(key.slice(4,6)) - 1,
    Number(key.slice(6,8)) + days));
  return `${x.getUTCFullYear()}${pad2(x.getUTCMonth()+1)}${pad2(x.getUTCDate())}`;
}
function civilTime(key, hour, minute, zone) {
  if (!validDay(key) || !Number.isInteger(hour) || hour < 0 || hour > 23 ||
      !Number.isInteger(minute) || minute < 0 || minute > 59 || !zoneAllowed(zone)) {
    throw new Error("Выберите существующие дату и время.");
  }
  const target = Date.UTC(Number(key.slice(0,4)), Number(key.slice(4,6)) - 1,
    Number(key.slice(6,8)), hour, minute);
  let stamp = target;
  for (let i = 0; i < 4; i++) {
    const p = localParts(stamp, zone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    stamp += target - shown;
  }
  const p = localParts(stamp, zone);
  if (dateKey(p) !== key || p.hour !== hour || p.minute !== minute) {
    throw new Error("Это местное время не существует. Выберите другое.");
  }
  return stamp;
}
function zoneLabel(zone, instant = Date.now()) {
  const p = localParts(instant, zone);
  const base = new Date(instant); base.setUTCMilliseconds(0);
  const offset = Math.round((Date.UTC(p.year, p.month-1, p.day, p.hour, p.minute, p.second) - base.getTime()) / 60000);
  return `${CHANNEL_ZONES.find(([z]) => z === zone)[1]} · UTC${offset >= 0 ? "+" : "−"}` +
    `${Math.floor(Math.abs(offset)/60)}${Math.abs(offset)%60 ? ":"+pad2(Math.abs(offset)%60) : ""}`;
}
function timeLabel(instant, zone) {
  const p = localParts(instant, zone);
  return `${pad2(p.day)}.${pad2(p.month)}.${p.year}, ${pad2(p.hour)}:${pad2(p.minute)}`;
}
function choiceValid(session, now = Date.now()) {
  try {
    const due = civilTime(session.day_key, Number(session.hour), Number(session.minute), session.timezone);
    const today = dateKey(localParts(now, session.timezone));
    return due > now + 5000 && session.day_key <= shiftDay(today, SCHEDULE_HORIZON_DAYS);
  } catch { return false; }
}
function scheduleLabel(state) {
  return { scheduled: "ожидает", sending: "отправляется", paused: "приостановлен",
    needs_check: "нужна проверка канала", published: "опубликован", cancelled: "снят с расписания" }[state] || state;
}
async function getScheduleSession(userId) {
  await pool.query("DELETE FROM ep_schedule_sessions WHERE actor_user_id = $1 AND expires_at <= NOW()", [userId]);
  return (await pool.query(`SELECT * FROM ep_schedule_sessions WHERE actor_user_id = $1`, [userId])).rows[0] || null;
}
async function schedulePostLocked(postId, userId) {
  const r = await pool.query("SELECT actor_user_id FROM ep_schedule_sessions WHERE post_id = $1 AND expires_at > NOW()", [postId]);
  if (!r.rowCount) return false;
  await notify(userId, "Для этого материала выбирается время. Завершите выбор или отмените его в карточке отложки.");
  return true;
}
async function getSchedule(id) {
  return (await pool.query(`SELECT q.*, p.channel_id, p.author_user_id, p.source_submission_id,
    p.status AS post_status, c.title, c.max_chat_id, c.owner_user_id, c.active
    FROM ep_schedules q JOIN ep_posts p ON p.id = q.post_id JOIN channels c ON c.id = p.channel_id
    WHERE q.id = $1`, [id])).rows[0] || null;
}
async function scheduleAccess(row, userId) {
  if (!row) return null;
  const access = await channelAccess(row.channel_id, userId, row.source_submission_id ? "moderate" : "create");
  if (!access || (!access.owner && String(row.author_user_id) !== String(userId) &&
      String(row.scheduled_by) !== String(userId))) return null;
  return access;
}
function pickerButton(session, action, text) { return button(text, `sp_${session.nonce}_${action}`); }
function schedulePickerBody(session, title, now = Date.now()) {
  const rows = [], today = dateKey(localParts(now, session.timezone));
  const b = (action, text) => pickerButton(session, action, text);
  let text = `🕒 ${session.schedule_id ? "Перенести публикацию" : "Отложить пост"} #${session.post_id}\n` +
    `Канал: «${shortTitle(title)}»\n${zoneLabel(session.timezone)}\n\n`;
  if (session.schedule_id) text += "До подтверждения нового времени прежнее расписание действует.\n\n";
  if (session.stage === "day") {
    text += "Когда опубликовать?";
    rows.push([b("today", "Сегодня"), b("tomorrow", "Завтра")], [b("calendar", "📅 Выбрать дату")]);
  } else if (session.stage === "calendar") {
    const month = String(session.month_key || today.slice(0,6));
    const year = Number(month.slice(0,4)), m = Number(month.slice(4,6));
    const first = new Date(Date.UTC(year, m-1, 1));
    text += `${ruMonths[m-1]} ${year}\nВыберите день.`;
    rows.push([b("prevmonth", "◀"), b("noop", `${ruMonths[m-1]} ${year}`), b("nextmonth", "▶")]);
    rows.push(["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map(x => b("noop", x)));
    const offset = (first.getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const cells = Array.from({ length: Math.ceil((days+offset)/7)*7 }, (_, i) => {
      const d = i-offset+1, key = `${month}${pad2(d)}`;
      return d < 1 || d > days || key < today || key > shiftDay(today, SCHEDULE_HORIZON_DAYS)
        ? b("noop", "·") : b(`day${key}`, `${d}`);
    });
    for (let i=0;i<cells.length;i+=7) rows.push(cells.slice(i,i+7));
    rows.push([b("days", "Сегодня / завтра")]);
  } else {
    text += `Дата: ${session.day_key.slice(6,8)}.${session.day_key.slice(4,6)}.${session.day_key.slice(0,4)}\n` +
      `Время: ${pad2(session.hour)}:${pad2(session.minute)}\n\n`;
    if (session.stage === "hours") {
      text += "Выберите час.";
      for (let i=0;i<24;i+=4) rows.push(Array.from({length:4}, (_,j) => b(`h${i+j}`, pad2(i+j))));
    } else if (session.stage === "minutes") {
      text += "Выберите минуту.";
      for (let i=0;i<60;i+=6) rows.push(Array.from({length:6}, (_,j) => b(`m${i+j}`, pad2(i+j))));
    } else {
      text += "Нажмите на часы или минуты. Можно прислать время текстом: 18:30.";
      rows.push([b("hours", `Часы: ${pad2(session.hour)}`), b("minutes", `Минуты: ${pad2(session.minute)}`)]);
      if (choiceValid(session, now)) rows.push([b("confirm",
        `🕒 Отложить на ${session.day_key.slice(6,8)}.${session.day_key.slice(4,6)}, ${pad2(session.hour)}:${pad2(session.minute)}`)]);
      else text += "\n\n⚠️ Это время уже прошло или слишком близко. Выберите другое.";
      text += "\n\nЕсли сервис опоздает больше 5 минут, пост будет удержан для проверки.";
    }
    rows.push([b("days", "📅 Изменить дату")]);
  }
  rows.push([b("cancel", session.schedule_id ? "↩️ Оставить прежнее время" : "↩️ К предпросмотру")]);
  return { text, attachments: keyboard(rows) };
}
async function renderSchedulePicker(session, callbackId = null) {
  const current = await getScheduleSession(session.actor_user_id);
  if (!current || current.nonce !== session.nonce) return;
  const post = await getOwnPost(session.post_id);
  if (!(await canUseOwnPost(post, session.actor_user_id))) return;
  const body = schedulePickerBody(session, post.title);
  // Обновляем одну управляющую карточку. Никаких пустых callback-ответов.
  if (callbackId) {
    try {
      await queueMaxWrite(`/answers?callback_id=${encodeURIComponent(callbackId)}`, "POST", { message: body });
      return;
    } catch (error) { console.error("SCHEDULE CARD CALLBACK ERROR:", error.message); }
  }
  if (session.card_mid) {
    try {
      await queueMaxWrite(`/messages?message_id=${encodeURIComponent(session.card_mid)}`, "PUT", body);
      return;
    } catch (error) { console.error("SCHEDULE CARD EDIT ERROR:", error.message); }
  }
  const sent = await sendToUser(session.actor_user_id, body);
  await pool.query("UPDATE ep_schedule_sessions SET card_mid = $2 WHERE actor_user_id = $1 AND nonce = $3",
    [session.actor_user_id, messageId(sent), session.nonce]);
}
async function beginSchedulePicker(postId, userId, schedule = null) {
  const current = await getScheduleSession(userId);
  if (current) { await renderSchedulePicker(current); return; }
  if (await getComposer(userId) || await getEditorSession(userId)) {
    await notify(userId, "Сначала сохраните или закройте открытый редактор."); return;
  }
  const post = await getOwnPost(postId);
  const access = post ? await channelAccess(post.channel_id, userId, post.source_submission_id ? "moderate" : "create") : null;
  if (!access || !(await canUseOwnPost(post,userId)) || !post.body ||
      (!schedule && (post.status !== "draft" || !post.is_saved)) ||
      (schedule && (!["scheduled","paused"].includes(schedule.status) || post.status !== "scheduled"))) {
    await notify(userId, "Этот материал нельзя поставить в расписание."); return;
  }
  const timezone = schedule?.timezone || access.channel.timezone || "Europe/Moscow";
  const defaultAt = schedule ? new Date(schedule.due_at).getTime() : Math.ceil((Date.now()+10*60000)/60000)*60000;
  const initial = localParts(Math.max(defaultAt, Date.now()+60000), timezone);
  // Реальный предпросмотр: если медиа не отправляются, расписание не подтверждается вслепую.
  try { await sendToUser(userId, post.body); }
  catch (error) { await notify(userId, `Предпросмотр недоступен. Материал сохранён. ${error.message.slice(0,200)}`); return; }
  const made = await pool.query(`INSERT INTO ep_schedule_sessions(actor_user_id, post_id, nonce,
    schedule_id, expected_revision, draft_revision, access_version, timezone, stage, day_key, month_key, hour, minute)
    SELECT $1, p.id, $3, $4, $5, p.draft_revision, $6, $7, 'day', $8, $9, $10, $11
    FROM ep_posts p WHERE p.id = $2 AND p.status = $12
      AND NOT EXISTS (SELECT 1 FROM ep_composer_sessions e WHERE e.post_id = p.id)
    ON CONFLICT DO NOTHING RETURNING *`, [userId,post.id,newEditNonce(),schedule?.id || null,
    schedule?.revision ?? 0,access.version,timezone,dateKey(initial),dateKey(initial).slice(0,6),
    initial.hour,initial.minute,schedule ? "scheduled" : "draft"]);
  if (!made.rowCount) { await notify(userId, "Материал уже открыт другим админом или изменился."); return; }
  await pool.query("DELETE FROM proposal_sessions WHERE max_user_id = $1", [userId]);
  await renderSchedulePicker(made.rows[0]);
}
async function closeSchedulePicker(session, callbackId = null) {
  const r = await pool.query("DELETE FROM ep_schedule_sessions WHERE actor_user_id = $1 AND nonce = $2 RETURNING *",
    [session.actor_user_id,session.nonce]);
  if (!r.rowCount) return;
  if (callbackId) await answerCallback(callbackId, session.schedule_id ? "Прежнее расписание не изменено." : "Время не назначено. Материал сохранён в черновиках.", true);
  if (session.schedule_id) await showScheduledPost(session.schedule_id, session.actor_user_id);
  else await openSavedDraft(session.post_id, session.actor_user_id);
}
async function confirmSchedule(session, callbackId) {
  if (!choiceValid(session)) { await renderSchedulePicker(session,callbackId); return; }
  const post = await getOwnPost(session.post_id);
  const access = post ? await channelAccess(post.channel_id,session.actor_user_id,post.source_submission_id ? "moderate" : "create") : null;
  if (!access || access.version !== Number(session.access_version) || !(await canUseOwnPost(post,session.actor_user_id))) {
    await notify(session.actor_user_id,"Права изменились. Расписание не сохранено."); return;
  }
  const due = new Date(civilTime(session.day_key,Number(session.hour),Number(session.minute),session.timezone));
  const client = await pool.connect(); let saved;
  try {
    await client.query("BEGIN");
    const form = (await client.query("SELECT * FROM ep_schedule_sessions WHERE actor_user_id = $1 AND nonce = $2 AND expires_at > NOW() FOR UPDATE",
      [session.actor_user_id,session.nonce])).rows[0];
    const fresh = (await client.query("SELECT * FROM ep_posts WHERE id = $1 FOR UPDATE",[post.id])).rows[0];
    const old = (await client.query("SELECT * FROM ep_schedules WHERE post_id = $1 FOR UPDATE",[post.id])).rows[0];
    const valid = form && fresh && Number(fresh.draft_revision) === Number(session.draft_revision) &&
      (session.schedule_id ? old && ["scheduled","paused"].includes(old.status) && fresh.status === "scheduled" &&
         Number(old.revision) === Number(session.expected_revision)
       : fresh.status === "draft" && (!old || old.status === "cancelled"));
    if (valid && choiceValid(form)) {
      saved = (await client.query(`INSERT INTO ep_schedules(post_id,status,due_at,timezone,scheduled_by,access_version,body_snapshot)
        VALUES ($1,'scheduled',$2,$3,$4,$5,$6::jsonb)
        ON CONFLICT(post_id) DO UPDATE SET status = 'scheduled', due_at = EXCLUDED.due_at,
          timezone = EXCLUDED.timezone, scheduled_by = EXCLUDED.scheduled_by,
          access_version = EXCLUDED.access_version, body_snapshot = EXCLUDED.body_snapshot,
          revision = ep_schedules.revision + 1, attempts = 0, next_at = NOW(),
          locked_at = NULL, dispatch_started_at = NULL, last_error = NULL, updated_at = NOW()
        RETURNING *`,[post.id,due,session.timezone,session.actor_user_id,access.version,JSON.stringify(fresh.body)])).rows[0];
      await client.query("UPDATE ep_posts SET status = 'scheduled', is_saved = TRUE, saved_at = NOW(), updated_at = NOW() WHERE id = $1",[post.id]);
      await client.query("DELETE FROM ep_schedule_sessions WHERE actor_user_id = $1 AND nonce = $2",[session.actor_user_id,session.nonce]);
      await audit(post.channel_id,session.actor_user_id,session.schedule_id ? "schedule_moved" : "post_scheduled",post.id,
        { due_at: due.toISOString(), timezone: session.timezone },client);
    }
    await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK").catch(()=>{}); throw error; }
  finally { client.release(); }
  if (!saved) { await notify(session.actor_user_id,"Материал, права или время изменились. Откройте «Отложенные» или «Черновики» заново."); return; }
  await answerCallback(callbackId,`✅ Пост #${post.id} отложен.\nКанал: «${shortTitle(post.title)}»\n${timeLabel(due,session.timezone)} · ${zoneLabel(session.timezone,due)}`,true);
  console.log("POST SCHEDULED:",post.id,due.toISOString());
  await showScheduledPost(saved.id,session.actor_user_id,false);
}
async function handleScheduleMessage(message) {
  const userId = message.sender.user_id, mid = message.body.mid;
  if ((await pool.query("SELECT 1 FROM ep_schedule_inputs WHERE max_message_id = $1",[mid])).rowCount) return true;
  const session = await getScheduleSession(userId);
  const text = typeof message.body.text === "string" ? message.body.text.trim() : "";
  const ordinary = !message.link && !(message.body.attachments || []).length;
  if (!session) {
    if (!ordinary || !["/scheduled", "отложенные"].includes(text.toLowerCase())) return false;
    await pool.query("INSERT INTO ep_schedule_inputs(max_message_id,actor_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",[mid,userId]);
    await listScheduled(userId); return true;
  }
  await pool.query("INSERT INTO ep_schedule_inputs(max_message_id,actor_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",[mid,userId]);
  if (ordinary && ["/cancel","/отмена"].includes(text.toLowerCase())) {
    await closeSchedulePicker(session); return true;
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await notify(userId,"Время выбора истекло. Материал сохранён, расписание не изменено.");
    await closeSchedulePicker(session); return true;
  }
  const time = ordinary ? text.match(/^(\d{1,2}):(\d{2})$/) : null;
  if (time && Number(time[1]) < 24 && Number(time[2]) < 60) {
    const next = await pool.query(`UPDATE ep_schedule_sessions SET hour=$3,minute=$4,stage='time',nonce=$5
      WHERE actor_user_id=$1 AND nonce=$2 RETURNING *`,[userId,session.nonce,Number(time[1]),Number(time[2]),newEditNonce()]);
    if (next.rowCount) await renderSchedulePicker(next.rows[0]);
  } else {
    if (!["/menu","/start","меню"].includes(text.toLowerCase())) {
      await notify(userId,"Сейчас выбирается время. Нажмите кнопки или отправьте время, например 18:30. Для отмены: /cancel. Сообщение не опубликовано.");
    }
    await renderSchedulePicker(session);
  }
  return true;
}
async function handlePickerAction(session, action, callbackId) {
  if (action === "noop") { await answerCallback(callbackId,"Выберите доступное значение."); return; }
  if (action === "cancel") { await closeSchedulePicker(session,callbackId); return; }
  if (action === "confirm") {
    if (session.stage !== "time") return;
    await confirmSchedule(session,callbackId); return;
  }
  const next = { ...session }, today = dateKey(localParts(Date.now(),session.timezone));
  if (action === "days") next.stage = "day";
  else if (action === "today" || action === "tomorrow") {
    next.day_key = shiftDay(today,action === "today" ? 0 : 1); next.stage = "time";
  } else if (action === "calendar") { next.stage = "calendar"; next.month_key = next.day_key.slice(0,6); }
  else if (["prevmonth","nextmonth"].includes(action)) {
    const m = String(session.month_key), d = new Date(Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1+(action === "prevmonth" ? -1 : 1),1));
    const target = `${d.getUTCFullYear()}${pad2(d.getUTCMonth()+1)}`;
    if (target < today.slice(0,6) || target > shiftDay(today,SCHEDULE_HORIZON_DAYS).slice(0,6)) {
      await answerCallback(callbackId,"Выберите дату не дальше года вперёд."); return;
    }
    next.month_key=target; next.stage="calendar";
  } else if (/^day\d{8}$/.test(action)) {
    const d = action.slice(3);
    if (!validDay(d) || d < today || d > shiftDay(today,SCHEDULE_HORIZON_DAYS)) return;
    next.day_key=d; next.stage="time";
  } else if (["hours","minutes"].includes(action)) next.stage=action;
  else if (/^h\d{1,2}$/.test(action) && Number(action.slice(1))<24) { next.hour=Number(action.slice(1)); next.stage="time"; }
  else if (/^m\d{1,2}$/.test(action) && Number(action.slice(1))<60) { next.minute=Number(action.slice(1)); next.stage="time"; }
  else return;
  const changed=await pool.query(`UPDATE ep_schedule_sessions SET nonce=$3,stage=$4,day_key=$5,month_key=$6,hour=$7,minute=$8
    WHERE actor_user_id=$1 AND nonce=$2 AND expires_at>NOW() RETURNING *`,[session.actor_user_id,session.nonce,newEditNonce(),
    next.stage,next.day_key,next.month_key,next.hour,next.minute]);
  if (changed.rowCount) await renderSchedulePicker(changed.rows[0],callbackId);
}
async function listScheduled(userId,group="all",page=0) {
  page=pageNumber(page);
  const channels=await accessibleChannels(userId,"moderate"), ids=channels.map(c=>c.id), createIds=channels.filter(c=>c.can_create).map(c=>c.id);
  const result=await pool.query(`SELECT q.*,p.channel_id,p.source_submission_id,c.title FROM ep_schedules q
    JOIN ep_posts p ON p.id=q.post_id JOIN channels c ON c.id=p.channel_id
    WHERE p.channel_id=ANY($2::bigint[]) AND q.status IN ('scheduled','paused','sending','needs_check')
      AND (q.scheduled_by=$1 OR p.author_user_id=$1 OR c.owner_user_id=$1)
      AND (p.source_submission_id IS NOT NULL OR p.channel_id=ANY($3::bigint[]))
    ORDER BY q.due_at,q.id`,[userId,ids,createIds]);
  const filtered=result.rows.filter(q=>{
    const key=dateKey(localParts(q.due_at,q.timezone)), today=dateKey(localParts(Date.now(),q.timezone));
    return group==="all" || (group==="today" && key===today) || (group==="tomorrow" && key===shiftDay(today,1)) ||
      (group==="other" && key!==today && key!==shiftDay(today,1));
  });
  const rows=filtered.slice(page*ADMIN_PAGE_SIZE,(page+1)*ADMIN_PAGE_SIZE);
  const nav=pageButtons(`menu_scheduled_${group}`,page,filtered.length);
  const groups={all:"Все",today:"Сегодня",tomorrow:"Завтра",other:"Другие даты"};
  await sendToUser(userId,{text:`🕒 Отложенные · ${groups[group] || "Все"}\n\n`+(rows.length ?
    "Выберите пост. Дата и время показаны по часовому поясу его канала. ⚠️ — отправка остановлена." : "В этом разделе нет доступных материалов."),
    attachments:keyboard([
      [button("Сегодня","menu_scheduled_today_0"),button("Завтра","menu_scheduled_tomorrow_0")],
      [button("Другие даты","menu_scheduled_other_0"),button("Все","menu_scheduled_all_0")],
      ...rows.map(q=>[button(`${q.status==="scheduled" ? "🕒" : "⚠️"} ${timeLabel(q.due_at,q.timezone)} · #${q.post_id} · ${shortTitle(q.title)}`.slice(0,90),`so_${q.id}`)]),
      ...(nav.length?[nav]:[]),[button("↩️ Меню","menu_main")]
    ])});
}
async function showScheduledPost(id,userId,preview=true) {
  const q=await getSchedule(id);
  if (!(await scheduleAccess(q,userId))) { await notify(userId,"Нет доступа к этой отложенной публикации."); return; }
  if (preview) {
    try { await sendToUser(userId,q.body_snapshot); }
    catch(e) { await notify(userId,"Не удалось показать медиа. Расписание не изменено."); console.error("SCHEDULE PREVIEW ERROR:",e.message); }
  }
  const controls=[];
  if (["scheduled","paused"].includes(q.status)) {
    controls.push([button("🕒 Изменить время",`st_move_${q.id}_${q.revision}`)]);
    controls.push([button("✏️ Редактировать",`st_edit_${q.id}_${q.revision}`),button("🚀 Опубликовать сейчас",`st_now_${q.id}_${q.revision}`)]);
    controls.push([button("↩️ Снять с отложки",`st_cancel_${q.id}_${q.revision}`)]);
  }
  controls.push([button("🕒 Отложенные","menu_scheduled_all_0")]);
  await sendToUser(userId,{text:`🕒 Пост #${q.post_id}\nКанал: «${shortTitle(q.title)}»\n`+
    `${timeLabel(q.due_at,q.timezone)} · ${zoneLabel(q.timezone,q.due_at)}\nСтатус: ${scheduleLabel(q.status)}`+
    (q.last_error ? `\n\n${q.last_error.slice(0,350)}` : "")+
    (q.status==="needs_check" ? "\nПроверьте сам канал. Повторная отправка заблокирована, чтобы не создать дубль." : ""),attachments:keyboard(controls)});
}
async function changeScheduledPost(id,revision,userId,action,callbackId,confirmed=false) {
  const q=await getSchedule(id),access=await scheduleAccess(q,userId);
  if (!access || !["scheduled","paused"].includes(q.status) || Number(q.revision)!==Number(revision)) {
    await notify(userId,"Карточка устарела, публикация уже началась или нет доступа. Откройте «Отложенные»."); return;
  }
  if (action==="move") { await beginSchedulePicker(q.post_id,userId,q); return; }
  // «Опубликовать сейчас» запускается одним нажатием, без второго вопроса.
  // Проверки доступа, статуса и версии карточки выполняются независимо от подтверждения.
  if (!confirmed && action !== "now") {
    const questions={cancel:"Снять с расписания и сохранить в черновиках?",edit:"Снять с расписания и открыть редактор? После правки нужно заново нажать «Отложить»."};
    await sendToUser(userId,{text:`Пост #${q.post_id} · «${shortTitle(q.title)}»\n\n${questions[action]}`,attachments:keyboard([
      [button(action==="edit"?"✏️ Снять и редактировать":"↩️ Снять с отложки",`sx_${action}_${q.id}_${q.revision}`)],
      [button("Не менять",`so_${q.id}`)]])}); return;
  }
  if (action==="edit" && (await getComposer(userId)||await getEditorSession(userId))) {
    await notify(userId,"Сначала завершите открытую правку. Расписание не изменено."); return;
  }
  const client=await pool.connect(); let changed;
  try {
    await client.query("BEGIN");
    const fresh=(await client.query("SELECT * FROM ep_schedules WHERE id=$1 FOR UPDATE",[id])).rows[0];
    if (fresh && ["scheduled","paused"].includes(fresh.status) && Number(fresh.revision)===Number(revision)) {
      changed=await client.query(`UPDATE ep_schedules SET status=$2,revision=revision+1,updated_at=NOW(),last_error=NULL,
        due_at=CASE WHEN $2='scheduled' THEN NOW() ELSE due_at END,
        scheduled_by=CASE WHEN $2='scheduled' THEN $3 ELSE scheduled_by END,
        access_version=CASE WHEN $2='scheduled' THEN $4 ELSE access_version END,
        next_at=NOW(),attempts=0,dispatch_started_at=NULL,locked_at=NULL WHERE id=$1 RETURNING *`,
        [id,action==="now"?"scheduled":"cancelled",userId,access.version]);
      if (action!=="now") await client.query(`UPDATE ep_posts SET status='draft',is_saved=TRUE,saved_at=NOW(),body=$2::jsonb,
        draft_revision=draft_revision+1,preview_mid=NULL,controls_mid=NULL,updated_at=NOW() WHERE id=$1 AND status='scheduled'`,
        [q.post_id,JSON.stringify(fresh.body_snapshot)]);
      await client.query("DELETE FROM ep_schedule_sessions WHERE post_id=$1",[q.post_id]);
      await audit(q.channel_id,userId,action==="now"?"schedule_publish_now":"schedule_cancelled",q.post_id,{},client);
    }
    await client.query("COMMIT");
  } catch(e) { await client.query("ROLLBACK").catch(()=>{}); throw e; } finally {client.release();}
  if (!changed?.rowCount) {await notify(userId,"Статус уже изменился. Обновите «Отложенные».");return;}
  await answerCallback(callbackId,action==="now"?"Пост поставлен на немедленную отправку. Дождитесь результата.":"Расписание снято. Материал сохранён в черновиках.",true);
  if(action==="edit") await openSavedDraft(q.post_id,userId);
  else if(action!=="now") await listSavedDrafts(userId);
}
async function showTimezone(channelId,userId) {
  const channel=await requireOwner(channelId,userId); if(!channel)return;
  await sendToUser(userId,{text:`Часовой пояс канала «${shortTitle(channel.title)}»\nСейчас: ${zoneLabel(channel.timezone || "Europe/Moscow")}\n\n`+
    "Выберите пояс для новых публикаций. Уже отложенные посты сохранят прежние время и пояс.",attachments:keyboard([
    ...CHANNEL_ZONES.map(([zone],i)=>[button(zoneLabel(zone),`tz_set_${channelId}_${i}`)]),[button("↩️ Назад",`access_channel_${channelId}`)]])});
}
async function handleSchedulingCallback(update) {
  const cb=update.callback,userId=cb?.user?.user_id,value=typeof cb?.payload==="string"?cb.payload:"";
  if(userId==null)return false;
  const picker=value.match(/^sp_([a-f0-9]{24})_([a-z0-9]+)$/);
  const entry=value.match(/^cschedule_([a-f0-9]{24})$/);
  const sub=value.match(/^schedule_(\d+)(?:_a(\d+))?$/);
  const subEdit=value.match(/^editschedule_(\d+)_([a-f0-9]{24})$/);
  const listing=value.match(/^menu_scheduled_(all|today|tomorrow|other)_(\d+)$/);
  const open=value.match(/^so_(\d+)$/);
  const task=value.match(/^(st|sx)_(move|edit|cancel|now)_(\d+)_(\d+)$/);
  const zone=value.match(/^tz_(open|set)_(\d+)(?:_(\d+))?$/);
  const session=await getScheduleSession(userId);
  if(picker) {
    if(!session||session.nonce!==picker[1]||new Date(session.expires_at).getTime()<=Date.now()) {
      await answerCallback(cb.callback_id,"Карточка выбора времени устарела.");
      if(session)await renderSchedulePicker(session); else await notify(userId,"Откройте «Отложенные» или «Черновики» через /menu.");
      return true;
    }
    const post=await getOwnPost(session.post_id);
    const access=post?await channelAccess(post.channel_id,userId,post.source_submission_id?"moderate":"create"):null;
    if(!access||access.version!==Number(session.access_version)||!(await canUseOwnPost(post,userId))) {
      await pool.query("DELETE FROM ep_schedule_sessions WHERE actor_user_id=$1",[userId]);
      await answerCallback(cb.callback_id,"Права или материал изменились. Расписание не изменено.");return true;
    }
    await handlePickerAction(session,picker[2],cb.callback_id);return true;
  }
  if(session) {await answerCallback(cb.callback_id,"Сначала завершите выбор времени или нажмите «Назад».");await renderSchedulePicker(session);return true;}
  if(!entry&&!sub&&!subEdit&&!listing&&!open&&!task&&!zone)return false;
  await answerCallback(cb.callback_id);
  if(listing){await listScheduled(userId,listing[1],listing[2]);return true;}
  if(open){await showScheduledPost(open[1],userId);return true;}
  if(task){await changeScheduledPost(task[3],task[4],userId,task[2],cb.callback_id,task[1]==="sx");return true;}
  if(zone) {
    const channel=await requireOwner(zone[2],userId);if(!channel)return true;
    if(zone[1]==="open")await showTimezone(zone[2],userId);
    else {
      const selected=CHANNEL_ZONES[Number(zone[3])];if(!selected)return true;
      await pool.query("UPDATE channels SET timezone=$2,updated_at=NOW() WHERE id=$1",[channel.id,selected[0]]);
      await audit(channel.id,userId,"timezone_changed",channel.id,{timezone:selected[0]});
      await notify(userId,`Часовой пояс: ${zoneLabel(selected[0])}. Уже отложенные посты не перенесены.`);
      await showChannelAccess(channel.id,userId);
    }
    return true;
  }
  let saved;
  if(entry) {
    const composer=await getComposer(userId);
    if(!composer||composer.nonce!==entry[1]){await notify(userId,"Предпросмотр устарел. Откройте /menu.");return true;}
    saved=await saveComposerDraft(composer,await getOwnPost(composer.post_id),cb.callback_id,true);
  } else {
    const row=await getSubmission((sub||subEdit)[1]);
    const access=row?await channelAccess(row.channel_id,userId,"moderate"):null;
    if(!access||(sub&&!access.owner&&access.version!==Number(sub[2]))){await notify(userId,"Нет доступа к этой предложке.");return true;}
    let editing=null;
    if(subEdit){editing=await getEditorSession(userId);if(!editing||editing.nonce!==subEdit[2]||String(editing.submission_id)!==subEdit[1])return true;}
    saved=await saveSubmissionDraft(row,userId,cb.callback_id,editing,true);
  }
  if(saved)await beginSchedulePicker(saved.id,userId);
  return true;
}
// ---------- Выполнение расписания: под тем же advisory lock, что и webhook ----------
async function scheduledNotice(q,text) {
  const ids=new Set([String(q.scheduled_by),String(q.owner_user_id)]);
  for(const id of ids) await notify(id,text);
}
async function holdScheduled(q,reason,state="paused") {
  const client=await pool.connect();let changed;
  try{
    await client.query("BEGIN");
    changed=await client.query(`UPDATE ep_schedules SET status=$2,revision=revision+1,last_error=$3,updated_at=NOW()
      WHERE id=$1 AND status IN ('scheduled','sending') RETURNING id`,[q.id,state,reason.slice(0,1000)]);
    if(changed.rowCount){
      await client.query("UPDATE ep_posts SET status=$2,last_error=$3,updated_at=NOW() WHERE id=$1 AND status IN ('scheduled','publishing')",
        [q.post_id,state==="needs_check"?"needs_check":"scheduled",reason.slice(0,1000)]);
      if(q.source_submission_id)await client.query("UPDATE submissions SET status=$2,last_error=$3 WHERE id=$1 AND status IN ('drafted','publishing')",
        [q.source_submission_id,state==="needs_check"?"needs_check":"drafted",reason.slice(0,1000)]);
      await client.query("DELETE FROM ep_schedule_sessions WHERE post_id=$1",[q.post_id]);
      await audit(q.channel_id,q.scheduled_by,"schedule_held",q.post_id,{reason},client);
    }
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
  if(changed?.rowCount) await scheduledNotice(q,`⚠️ Отложенный пост #${q.post_id} · «${shortTitle(q.title)}»\n${reason}\nОткройте /scheduled.`);
}
async function dispatchScheduled(q) {
  // Ожидаем свою очередь, затем повторно проверяем права ПЕРЕД HTTP POST.
  const task=apiTail.catch(()=>{}).then(async()=>{
    await sleep(Math.max(0,650-(Date.now()-lastApiCall)));
    const fresh=await getSchedule(q.id);
    const access=await scheduleAccess(fresh,q.scheduled_by);
    if(!fresh||fresh.status!=="sending"||Number(fresh.revision)!==Number(q.revision)||
       !access||access.version!==Number(q.access_version)) {
      const e=new Error("Права или состояние изменились до отправки.");e.deliveryNotStarted=true;throw e;
    }
    if(Date.now()-new Date(q.due_at).getTime()>SCHEDULE_GRACE_MS){
      const e=new Error("Публикация опоздала больше чем на 5 минут. Нужен новый выбор времени.");e.deliveryNotStarted=true;throw e;
    }
    if(!q.body_snapshot||Object.hasOwn(q.body_snapshot,"link")||Object.hasOwn(q.body_snapshot,"sender")){
      const e=new Error("Небезопасный формат публикации. Отправка остановлена.");e.deliveryNotStarted=true;throw e;
    }
    await pool.query("UPDATE ep_schedules SET dispatch_started_at=NOW() WHERE id=$1 AND status='sending'",[q.id]);
    lastApiCall=Date.now();
    return maxRequest(`/messages?chat_id=${encodeURIComponent(q.max_chat_id)}`,"POST",q.body_snapshot);
  });
  apiTail=task.catch(()=>{});
  return task.then(async result=>{
    await safeRememberDiscussion(q.max_chat_id,q.body_snapshot,result);
    return result;
  });
}
async function processOneScheduled() {
  const candidate=await pool.query(`SELECT id FROM ep_schedules WHERE status='sending'
    OR (status='scheduled' AND due_at<=NOW() AND next_at<=NOW()) ORDER BY due_at,id LIMIT 1`);
  if(!candidate.rowCount)return;
  let q=await getSchedule(candidate.rows[0].id);if(!q)return;
  if(q.status==="sending"){
    // После сбоя процесса никакого слепого повтора, даже если HTTP-ответ не успели записать.
    await holdScheduled(q,q.dispatch_started_at?"Процесс остановился во время отправки. Проверьте канал; автоматический повтор запрещён.":
      "Процесс остановился до отправки. Материал сохранён; назначьте время заново.",q.dispatch_started_at?"needs_check":"paused");return;
  }
  if(Date.now()-new Date(q.due_at).getTime()>SCHEDULE_GRACE_MS){await holdScheduled(q,"Сервис опоздал больше чем на 5 минут. Пост НЕ опубликован; выберите новое время.");return;}
  let access;
  try{access=await scheduleAccess(q,q.scheduled_by);}
  catch(e){await holdScheduled(q,"Не удалось проверить права в MAX. Публикация удержана.");console.error("SCHEDULE RIGHTS ERROR:",e.message);return;}
  if(!access||access.version!==Number(q.access_version)){await holdScheduled(q,"Права назначившего публикацию админа изменились. Владелец может назначить время заново.");return;}
  const post=await getOwnPost(q.post_id);
  if(!post||post.status!=="scheduled"||!post.body){await holdScheduled(q,"Состояние материала изменилось. Отправка остановлена.");return;}
  if(q.source_submission_id){
    const source=await getSubmission(q.source_submission_id);
    if(source?.status!=="drafted"){await holdScheduled(q,"Исходная предложка уже обработана. Отправка остановлена.");return;}
  }
  const client=await pool.connect();let claimed;
  try{
    await client.query("BEGIN");
    claimed=await client.query(`UPDATE ep_schedules SET status='sending',locked_at=NOW(),dispatch_started_at=NULL,
      attempts=attempts+1,updated_at=NOW() WHERE id=$1 AND status='scheduled' AND revision=$2 AND due_at<=NOW() RETURNING *`,[q.id,q.revision]);
    if(claimed.rowCount){
      const changed=await client.query("UPDATE ep_posts SET status='publishing',published_body=$2::jsonb,updated_at=NOW() WHERE id=$1 AND status='scheduled' RETURNING id",[q.post_id,JSON.stringify(q.body_snapshot)]);
      if(!changed.rowCount)throw new Error("Scheduled post state changed");
      if(q.source_submission_id){
        const source=await client.query("UPDATE submissions SET status='publishing',published_body=$2::jsonb WHERE id=$1 AND status='drafted' RETURNING id",[q.source_submission_id,JSON.stringify(q.body_snapshot)]);
        if(!source.rowCount)throw new Error("Scheduled submission state changed");
      }
    }
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
  if(!claimed.rowCount)return;
  q={...q,...claimed.rows[0]};let accepted=false;
  try{
    const sent=await dispatchScheduled(q);accepted=true;const mid=messageId(sent);
    const finish=await pool.connect();
    try{
      await finish.query("BEGIN");
      await finish.query("UPDATE ep_posts SET status='published',published_mid=$2,last_error=NULL,updated_at=NOW() WHERE id=$1",[q.post_id,mid]);
      await finish.query("UPDATE ep_schedules SET status='published',published_mid=$2,published_at=NOW(),last_error=NULL,revision=revision+1,updated_at=NOW() WHERE id=$1",[q.id,mid]);
      if(q.source_submission_id)await finish.query(`UPDATE submissions SET status='published',published_mid=$2,last_error=NULL,
        decision_actor_id=$3,decision_kind='human',decided_at=NOW() WHERE id=$1`,[q.source_submission_id,mid,q.scheduled_by]);
      await finish.query("DELETE FROM ep_schedule_sessions WHERE post_id=$1",[q.post_id]);
      await audit(q.channel_id,q.scheduled_by,"scheduled_published",q.post_id,{schedule_id:q.id},finish);
      await finish.query("COMMIT");
    }catch(e){await finish.query("ROLLBACK").catch(()=>{});throw e;}finally{finish.release();}
  }catch(e){
    const definite=!accepted&&(e.deliveryNotStarted||(e.status>=400&&e.status<500&&e.status!==408));
    await holdScheduled(q,definite?`Пост не отправлен. ${e.message}`:"Результат отправки не подтверждён. Проверьте канал; автоматический повтор запрещён.",definite?"paused":"needs_check");
    console.error("SCHEDULE PUBLISH ERROR:",e.message);return;
  }
  console.log("SCHEDULED POST PUBLISHED:",q.post_id);
  await scheduledNotice(q,`✅ Отложенный пост #${q.post_id} опубликован в канале «${shortTitle(q.title)}».`);
}

async function handleUpdate(update) {
  console.log("UPDATE TYPE:", update.update_type);
  switch (update.update_type) {
    case "bot_added": return handleBotAdded(update);
    case "bot_started": return handleStart(update);
    case "message_created": return handleMessage(update);
    case "message_callback": return handleCallback(update);
    case "bot_removed":
      await disableDiscussionGroup(update.chat_id);
      await pool.query(
        "UPDATE channels SET active = FALSE, updated_at = NOW() WHERE max_chat_id = $1",
        [update.chat_id]);
      return;
  }
}

// ---------- Быстрые команды MAX ----------
// PATCH /me/commands регистрирует подсказки. Расположением меню управляет клиент MAX.
const QUICK_COMMANDS = [
  { name: "menu", description: "Главное меню" },
  { name: "newpost", description: "Создать пост" },
  { name: "inbox", description: "Предложки" },
  { name: "drafts", description: "Черновики" },
  { name: "scheduled", description: "Отложенные" },
  { name: "channels", description: "Мои каналы" },
  { name: "cancel", description: "Отменить текущий ввод" },
  { name: "help", description: "Помощь и команды" }
];
let commandsReady = false;
async function registerCommands() {
  try {
    const result = await queueMaxWrite("/me/commands", "PATCH", { commands: QUICK_COMMANDS });
    if (Array.isArray(result.commands) && QUICK_COMMANDS.some(c =>
      !result.commands.some(r => typeof r.name === "string" && r.name.replace(/^\//, "") === c.name))) throw new Error("MAX did not return all commands");
    commandsReady = true;
    console.log("COMMAND MENU READY");
  } catch (e) {
    commandsReady = false;
    console.error("COMMAND MENU ERROR:", e.message);
    setTimeout(registerCommands, 60000).unref();
  }
}
function plainCommand(message) {
  if (message?.link || (message?.body?.attachments || []).length ||
      typeof message?.body?.text !== "string") return null;
  const match = message.body.text.trim().match(/^\/([a-z_]+|отмена)(?:@([a-z0-9_]+))?$/iu);
  if (!match || (match[2] && match[2].toLowerCase() !== BOT_USERNAME.toLowerCase())) return null;
  return match[1].toLowerCase();
}
async function quickHelp(userId) {
  await sendToUser(userId, { text:
    "EveryPost · Быстрые команды\n\n" + QUICK_COMMANDS.map(c => `/${c.name} — ${c.description}`).join("\n") +
    "\n\nСписок команд доступен в меню клиента MAX или при вводе /. " +
    "Команды не публикуются как пост и не становятся текстом правки.\n\n" +
    "Для подписчика: откройте персональную ссылку из канала и пришлите новость. " +
    "Доступ к чужим каналам и материалам через команды не выдаётся.\n\n" +
    "Чат канала: это отдельная группа для обсуждений, не встроенные комментарии MAX." });
}
async function handleQuickCommand(message) {
  const value = plainCommand(message);
  const action = ({start:"menu", new:"newpost", отмена:"cancel"})[value] || value;
  if (!QUICK_COMMANDS.some(c => c.name === action)) return false;
  const userId = message.sender.user_id, mid = message.body.mid;
  const receipt = await pool.query("SELECT handled FROM ep_command_inputs WHERE max_message_id=$1", [mid]);
  if (receipt.rows[0]?.handled) return true;
  await pool.query(`INSERT INTO ep_command_inputs(max_message_id,actor_user_id)
    VALUES ($1,$2) ON CONFLICT DO NOTHING`, [mid,userId]);
  const style = await getStyleInput(userId), timing = await getScheduleSession(userId);
  const composing = await getComposer(userId), editing = await getEditorSession(userId);
  if (action === "help") {
    await quickHelp(userId);
  } else if (action === "cancel") {
    if (style) await cancelStyleInput(style);
    else if (timing) await closeSchedulePicker(timing);
    else if (composing) await cancelComposer(composing, message);
    else if (editing) await cancelEditor(editing, mid);
    else { await notify(userId,"Незавершённого ввода нет. Отложенные посты не изменены."); await showAdminMenu(userId); }
  } else if (style || timing || composing || editing) {
    // Не теряем несохранённую правку при навигации, не подставляем /drafts в текст поста.
    if (action !== "menu") await notify(userId,"Сначала завершите текущую правку или /cancel. Она не потеряна.");
    if (style) await promptStyleInput(style);
    else if (timing) await renderSchedulePicker(timing);
    else if (composing) await resumeComposer(composing);
    else await resumeEditor(editing);
  } else if (!(await hasOwnChannel(userId))) {
    await showAdminMenu(userId);
  } else {
    await pool.query("DELETE FROM proposal_sessions WHERE max_user_id=$1", [userId]);
    if (action === "menu") await showAdminMenu(userId, true);
    else if (action === "newpost") await beginComposer(userId);
    else if (action === "inbox") await listMySubmissions(userId);
    else if (action === "drafts") await listSavedDrafts(userId);
    else if (action === "scheduled") await listScheduled(userId);
    else if (action === "channels") await listMyChannels(userId);
  }
  await pool.query("UPDATE ep_command_inputs SET handled=TRUE WHERE max_message_id=$1", [mid]);
  return true;
}

// ---------- Связанный групповой чат ----------
// Это наша связка «канал -> группа», не включение нативных комментариев MAX.
// Кнопка ведёт в общую группу. Комментарии разных устройств не синхронизируются.
function groupLink(value) {
  const normalized = normalizedLinkUrl(value);
  const url = new URL(normalized);
  if (url.protocol !== "https:" || !["max.ru","www.max.ru"].includes(url.hostname.toLowerCase()) ||
      !url.pathname || url.pathname === "/" || url.hash || url.port) {
    throw new Error("Нужна действующая HTTPS-ссылка на групповой чат в MAX.");
  }
  return normalized;
}
async function verifiedGroup(chatId, userId) {
  if (!/^-?\d+$/.test(String(chatId))) throw new Error("Неверный ID группы.");
  const chat = await maxRequest(`/chats/${encodeURIComponent(chatId)}`);
  if (chat.type !== "chat" || chat.status !== "active") throw new Error("Нужна действующая группа, не канал и не личный диалог.");
  if (!(await checkAdministrator(chatId,userId))) throw new Error("Вы должны быть администратором этой группы в MAX.");
  const me = await maxRequest(`/chats/${encodeURIComponent(chatId)}/members/me`);
  if (!(me.is_admin || me.is_owner)) throw new Error("Назначьте EveryPost администратором группы и повторите выбор.");
  if (typeof chat.link !== "string" || !chat.link.trim()) {
    throw new Error("MAX не вернул ссылку группы. Создайте действующую ссылку-приглашение в настройках группы и повторите подключение.");
  }
  const invite = groupLink(chat.link);
  return { chat_id:String(chatId), title:chat.title || "Группа без названия", invite_url:invite };
}
async function registerDiscussionGroup(chatId,userId) {
  // Регистрация группы сама НЕ подключает её к какому-либо каналу.
  const group = await verifiedGroup(chatId,userId);
  await pool.query(`INSERT INTO ep_discussion_groups(chat_id,title,invite_url,active)
    VALUES ($1,$2,$3,TRUE) ON CONFLICT(chat_id) DO UPDATE SET
      title=EXCLUDED.title,invite_url=EXCLUDED.invite_url,active=TRUE,updated_at=NOW()`,
    [group.chat_id,group.title,group.invite_url]);
  await pool.query(`INSERT INTO ep_group_registrations(chat_id,user_id) VALUES ($1,$2)
    ON CONFLICT(chat_id,user_id) DO UPDATE SET updated_at=NOW()`,[group.chat_id,userId]);
  await notify(userId,`💬 Группа «${shortTitle(group.title)}» доступна для подключения.\n`+
    "В личном чате с EveryPost: /channels → канал → «Чат канала» → «Подключить чат».\n"+
    "Пока ничего в группу не публикуется, её ссылка не добавлена под постами.");
  console.log("DISCUSSION GROUP READY:",group.chat_id);
}
async function handleDiscussionAdded(update) {
  const id=update.chat_id, userId=update.user?.user_id ?? update.user_id;
  if (id==null || userId==null || update.user?.is_bot) return;
  await registerDiscussionGroup(id,userId);
}
async function registerExistingGroupMessage(message) {
  if (message?.recipient?.chat_type !== "chat" || message?.sender?.is_bot ||
      plainCommand(message) !== "registerchat") return false;
  const id=message.recipient.chat_id, userId=message.sender?.user_id;
  if (id!=null && userId!=null) await registerDiscussionGroup(id,userId);
  return true;
}
async function showDiscussionSettings(channelId,userId) {
  const c=await requireOwner(channelId,userId);if(!c)return;
  let g=null;
  if(c.discussion_group_id)g=(await pool.query("SELECT * FROM ep_discussion_groups WHERE chat_id=$1",[c.discussion_group_id])).rows[0];
  const rows=[[button(c.discussion_group_id?"Заменить чат":"Подключить чат",`dc_list_${c.id}_0`)]];
  if(c.discussion_group_id){
    rows.push([button(`Кнопка чата: ${c.discussion_enabled?"вкл":"выкл"}`,`dc_button_${c.id}_${c.discussion_version}_${c.discussion_enabled?0:1}`)]);
    rows.push([button(`Копировать посты: ${c.discussion_copy?"вкл":"выкл"}`,`dc_copy_${c.id}_${c.discussion_version}_${c.discussion_copy?0:1}`)]);
    rows.push([button("Проверить чат / обновить ссылку",`dc_check_${c.id}_${c.discussion_version}`)]);
    rows.push([button("Последние копии",`dc_jobs_${c.id}`)]);
    rows.push([button("Отключить чат",`dc_unlink_${c.id}_${c.discussion_version}`)]);
  }
  rows.push([button("↩️ К каналу",`access_channel_${c.id}`)]);
  await sendToUser(userId,{text:`💬 Чат канала «${shortTitle(c.title)}»\n\n`+
    (g?`Группа: «${shortTitle(g.title)}»${g.active?"":" (бот удалён)"}\n`:"Чат ещё не подключён.\n")+
    "\nЭто отдельная общая группа для обсуждений, не встроенные комментарии к каждому посту MAX.\n"+
    "Кнопка «💬 Чат канала» добавляется при подготовке новых постов. Ссылка видна читателям.\n"+
    "Копирование выключено по умолчанию. При включении опубликованный через EveryPost пост с кнопкой этого чата " +
    "дополнительно появится в группе без автора предложки. Обсуждать его можно обычным ответом в группе.\n\n"+
    "Уже опубликованные посты, черновики и отложенные автоматически не меняются. Сообщения участников группы бот не публикует в канал.",
    attachments:keyboard(rows)});
}
async function listDiscussionGroups(channelId,userId,page=0) {
  const c=await requireOwner(channelId,userId);if(!c)return;
  page=pageNumber(page);
  // Только группы, которые этот владелец сам зарегистрировал, не список чужих групп.
  const candidates=await pool.query(`SELECT g.* FROM ep_discussion_groups g JOIN ep_group_registrations r ON r.chat_id=g.chat_id
    WHERE r.user_id=$1 AND g.active=TRUE ORDER BY g.chat_id LIMIT $2 OFFSET $3`,[userId,ADMIN_PAGE_SIZE+1,page*ADMIN_PAGE_SIZE]);
  const rows=[];
  for(const g of candidates.rows.slice(0,ADMIN_PAGE_SIZE)){
    try{
      if(await checkAdministrator(g.chat_id,userId))rows.push([button(shortTitle(g.title),`dc_select_${c.id}_${g.chat_id}_${c.discussion_version}`)]);
    }catch(e){console.error("DISCUSSION CANDIDATE CHECK:",e.message);}
  }
  const nav=[];
  if(page>0)nav.push(button("◀️ Назад",`dc_list_${c.id}_${page-1}`));
  if(candidates.rows.length>ADMIN_PAGE_SIZE)nav.push(button("Далее ▶️",`dc_list_${c.id}_${page+1}`));
  if(nav.length)rows.push(nav);
  rows.push([button("Обновить список",`dc_list_${c.id}_${page}`)]);
  rows.push([button("↩️ К настройкам чата",`dc_open_${c.id}`)]);
  await sendToUser(userId,{text:`Подключить чат · «${shortTitle(c.title)}»\n\n`+
    "Выберите группу для читателей, не служебный чат редакции.\n"+
    "Если группы нет: разрешите добавление EveryPost в группы в настройках MAX для бизнеса, затем добавьте его " +
    "администратором в нужную группу со своего аккаунта. Вы тоже должны быть её администратором.\n\n"+
    `Если бот уже был в группе, отправьте внутри неё /registerchat@${BOT_USERNAME}, затем обновите этот список.`,
    attachments:keyboard(rows)});
}
async function proposeDiscussionConnection(channelId,groupId,userId,version) {
  const c=await requireOwner(channelId,userId);if(!c)return;
  if(Number(c.discussion_version)!==Number(version)){await notify(userId,"Настройки уже изменены. Откройте «Чат канала» заново.");return;}
  const registration=await pool.query("SELECT 1 FROM ep_group_registrations WHERE chat_id=$1 AND user_id=$2",[groupId,userId]);
  if(!registration.rowCount){await notify(userId,"Группа не зарегистрирована вами. Сначала добавьте EveryPost в неё.");return;}
  const other=await pool.query("SELECT id FROM channels WHERE discussion_group_id=$1 AND id<>$2",[groupId,channelId]);
  if(other.rowCount){await notify(userId,"Эта группа уже связана с другим каналом. Для каждого канала используйте отдельную группу.");return;}
  const group=await verifiedGroup(groupId,userId), nonce=newEditNonce();
  await pool.query(`INSERT INTO ep_discussion_intents(nonce,channel_id,owner_user_id,group_id,invite_url,expected_version)
    VALUES($1,$2,$3,$4,$5,$6)`,[nonce,c.id,userId,group.chat_id,group.invite_url,version]);
  await sendToUser(userId,{text:`Канал: «${shortTitle(c.title)}»\nГруппа: «${shortTitle(group.title)}»\n\n`+
    `Ссылка группы:\n${group.invite_url}\n\n`+
    "При подключении ссылка будет добавляться под НОВЫМИ постами для читателей. Не подключайте закрытый чат редакции. " +
    "Доступ по ссылке определяется настройками группы MAX. Автокопирование пока выключено.",attachments:keyboard([
      [button("Подключить этот чат",`dc_confirm_${nonce}`)],
      [button("↩️ Другой чат",`dc_list_${c.id}_0`)]])});
}
async function confirmDiscussionConnection(nonce,userId) {
  const intent=(await pool.query("SELECT * FROM ep_discussion_intents WHERE nonce=$1 AND owner_user_id=$2",[nonce,userId])).rows[0];
  if(!intent||intent.used||new Date(intent.expires_at).getTime()<=Date.now()){await notify(userId,"Эта карточка подключения устарела. Откройте «Чат канала».");return;}
  const c=await requireOwner(intent.channel_id,userId);if(!c)return;
  if(Number(c.discussion_version)!==Number(intent.expected_version)){await notify(userId,"Настройки уже изменены. Повторите выбор чата.");return;}
  const group=await verifiedGroup(intent.group_id,userId);
  if(group.invite_url!==intent.invite_url){await notify(userId,"Ссылка группы изменилась. Выберите чат заново, чтобы проверить новую ссылку.");return;}
  const db=await pool.connect();let changed;
  try{
    await db.query("BEGIN");
    const claim=await db.query("UPDATE ep_discussion_intents SET used=TRUE WHERE nonce=$1 AND owner_user_id=$2 AND used=FALSE AND expires_at>NOW() RETURNING nonce",[nonce,userId]);
    if(claim.rowCount){
      changed=await db.query(`UPDATE channels SET discussion_group_id=$2,discussion_url=$3,discussion_enabled=TRUE,
        discussion_copy=FALSE,discussion_version=discussion_version+1,updated_at=NOW()
        WHERE id=$1 AND owner_user_id=$4 AND discussion_version=$5 AND active=TRUE RETURNING *`,
        [c.id,group.chat_id,group.invite_url,userId,intent.expected_version]);
      if(changed.rowCount){
        await db.query("UPDATE ep_discussion_jobs SET status='cancelled',last_error='Настройки чата изменились' WHERE channel_id=$1 AND status='pending'",[c.id]);
        await audit(c.id,userId,"discussion_connected",group.chat_id,{},db);
      }
    }
    await db.query("COMMIT");
  }catch(e){await db.query("ROLLBACK").catch(()=>{});
    if(e.code==="23505"){await notify(userId,"Эта группа уже подключена к другому каналу. Выберите другую.");return;}
    throw e;
  }finally{db.release();}
  await notify(userId,changed?.rowCount?"✅ Чат подключён. Кнопка добавится к новым постам. Копирование постов пока выключено.":"Подключение уже обработано или настройки изменились.");
  await showDiscussionSettings(c.id,userId);
}
async function changeDiscussionSetting(channelId,userId,version,action,on) {
  const c=await requireOwner(channelId,userId);if(!c)return;
  if(!c.discussion_group_id||Number(c.discussion_version)!==Number(version)){await notify(userId,"Настройки изменились. Откройте «Чат канала» заново.");return;}
  const value=on==="1";
  let group=null;
  if(action==="check"||((action==="button"||action==="copy")&&value)){
    group=await verifiedGroup(c.discussion_group_id,userId);
    if(action!=="check"&&group.invite_url!==c.discussion_url){await notify(userId,"Ссылка в MAX изменилась. Нажмите «Проверить чат / обновить ссылку».");return;}
  }
  if(action==="copy"&&value&&!c.discussion_enabled){await notify(userId,"Сначала включите кнопку чата. Копируются только посты с этой кнопкой.");return;}
  const next={group:c.discussion_group_id,url:c.discussion_url,enabled:c.discussion_enabled,copy:c.discussion_copy};
  if(action==="unlink"){next.group=null;next.url=null;next.enabled=false;next.copy=false;}
  else if(action==="button"){next.enabled=value;if(!value)next.copy=false;}
  else if(action==="copy")next.copy=value;
  else if(action==="check")next.url=group.invite_url;
  else return;
  const db=await pool.connect();let result;
  try{
    await db.query("BEGIN");
    result=await db.query(`UPDATE channels SET discussion_group_id=$2,discussion_url=$3,discussion_enabled=$4,discussion_copy=$5,
      discussion_version=discussion_version+1,updated_at=NOW() WHERE id=$1 AND owner_user_id=$6 AND discussion_version=$7 AND active=TRUE RETURNING id`,
      [c.id,next.group,next.url,next.enabled,next.copy,userId,version]);
    if(result.rowCount){
      await db.query("UPDATE ep_discussion_jobs SET status='cancelled',last_error='Настройки чата изменились' WHERE channel_id=$1 AND status='pending'",[c.id]);
      await audit(c.id,userId,`discussion_${action}`,next.group,{enabled:next.enabled,copy:next.copy},db);
    }
    await db.query("COMMIT");
  }catch(e){await db.query("ROLLBACK").catch(()=>{});throw e;}finally{db.release();}
  if(result.rowCount)await notify(userId,action==="unlink"?"Чат отключён. Старые посты и ссылки не удалены.":
    action==="check"?"✅ Ссылка проверена. Новые посты получат актуальную ссылку; сохранённые материалы не меняются.":
    "✅ Настройка сохранена. Старые публикации и их оформление не изменены.");
  await showDiscussionSettings(c.id,userId);
}
async function showDiscussionJobs(channelId,userId) {
  const c=await requireOwner(channelId,userId);if(!c)return;
  const r=await pool.query("SELECT id,status,last_error FROM ep_discussion_jobs WHERE channel_id=$1 ORDER BY id DESC LIMIT 5",[c.id]);
  const names={pending:"ожидает копирования",sending:"отправляется",sent:"скопирован",cancelled:"отменён",failed:"не отправлен",needs_check:"нужно проверить чат"};
  await sendToUser(userId,{text:`Копии в чат · «${shortTitle(c.title)}»\n\n`+(r.rowCount?r.rows.map(j=>`#${j.id}: ${names[j.status]||j.status}`+
    (j.last_error?`\n${j.last_error.slice(0,160)}`:"")).join("\n\n"):"Копий пока нет.")+
    "\n\nОшибка копирования не переотправляет пост в канал. При неопределённом результате повтор отключён.",
    attachments:keyboard([[button("↩️ Чат канала",`dc_open_${c.id}`)]])});
}
async function handleDiscussionCallback(update) {
  const cb=update.callback,userId=cb?.user?.user_id,value=typeof cb?.payload==="string"?cb.payload:"";
  if(userId==null||!value.startsWith("dc_"))return false;
  await answerCallback(cb.callback_id);
  if(await getStyleInput(userId)||await getScheduleSession(userId)||await getComposer(userId)||await getEditorSession(userId)){
    await notify(userId,"Сначала завершите текущую правку или /cancel. Настройки чата не изменены.");await showAdminMenu(userId);return true;
  }
  try{
    let m;
    if((m=value.match(/^dc_open_(\d+)$/)))await showDiscussionSettings(m[1],userId);
    else if((m=value.match(/^dc_jobs_(\d+)$/)))await showDiscussionJobs(m[1],userId);
    else if((m=value.match(/^dc_list_(\d+)_(\d+)$/)))await listDiscussionGroups(m[1],userId,m[2]);
    else if((m=value.match(/^dc_select_(\d+)_(-?\d+)_(\d+)$/)))await proposeDiscussionConnection(m[1],m[2],userId,m[3]);
    else if((m=value.match(/^dc_confirm_([a-f0-9]{24})$/)))await confirmDiscussionConnection(m[1],userId);
    else if((m=value.match(/^dc_(button|copy)_(\d+)_(\d+)_([01])$/)))await changeDiscussionSetting(m[2],userId,m[3],m[1],m[4]);
    else if((m=value.match(/^dc_(check|unlink)_(\d+)_(\d+)$/)))await changeDiscussionSetting(m[2],userId,m[3],m[1]);
    else await notify(userId,"Карточка устарела. Откройте /channels → канал → «Чат канала».");
  }catch(e){console.error("DISCUSSION SETTINGS ERROR:",e.message);await notify(userId,`Не удалось изменить чат. ${e.message.slice(0,200)}`);}
  return true;
}

// ---------- Копирование опубликованных постов в связанный чат ----------
// Отдельная очередь: сбой группы не повторяет публикацию в канале.
// Публикации вне EveryPost, черновики и входящие предложки сюда не попадают.
function hasDiscussionLink(body,url) {
  return (body?.attachments||[]).some(a=>a.type==="inline_keyboard"&&
    (a.payload?.buttons||[]).some(r=>r.some(b=>b.type==="link"&&b.url===url)));
}
function discussionCopyBody(body,discussionUrl,publicationUrl) {
  if(!body||Object.hasOwn(body,"link")||Object.hasOwn(body,"sender"))throw new Error("Unsafe discussion copy");
  const copy=copyJson(body);
  const media=(copy.attachments||[]).filter(a=>a.type!=="inline_keyboard");
  const rows=(copy.attachments||[]).filter(a=>a.type==="inline_keyboard").flatMap(a=>a.payload?.buttons||[])
    .map(row=>row.filter(b=>b.type==="link"&&b.url!==discussionUrl)).filter(row=>row.length);
  if(typeof publicationUrl==="string"&&safeWebUrl(publicationUrl)&&new URL(publicationUrl).hostname==="max.ru"){
    rows.push([{type:"link",text:"Открыть пост в канале",url:publicationUrl}]);
  }
  copy.attachments=rows.length?[...media,{type:"inline_keyboard",payload:{buttons:rows}}]:media;
  if(!copy.attachments.length)delete copy.attachments;
  // Не подставляем source_message: только уже отправленное публичное содержание.
  return copy;
}
async function rememberDiscussionPublication(chatId,body,result) {
  const channel=(await pool.query("SELECT * FROM channels WHERE max_chat_id=$1 AND active=TRUE",[chatId])).rows[0];
  if(!channel?.discussion_group_id||!channel.discussion_enabled||!channel.discussion_copy||
    !hasDiscussionLink(body,channel.discussion_url))return;
  const mid=messageId(result),copy=discussionCopyBody(body,channel.discussion_url,result.message?.url);
  await pool.query(`INSERT INTO ep_discussion_jobs(channel_id,group_id,link_version,channel_mid,body_snapshot)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(channel_id,channel_mid) DO NOTHING`,
    [channel.id,channel.discussion_group_id,channel.discussion_version,mid,JSON.stringify(copy)]);
}
async function safeRememberDiscussion(chatId,body,result) {
  try{await rememberDiscussionPublication(chatId,body,result);}
  catch(e){
    console.error("DISCUSSION QUEUE ERROR:",e.message);
    // Главный пост уже опубликован. Сбой необязательной копии не меняет его статус.
    try{
      const c=(await pool.query("SELECT owner_user_id FROM channels WHERE max_chat_id=$1",[chatId])).rows[0];
      if(c)await notify(c.owner_user_id,"Пост в канале опубликован, но копия в чат не поставлена в очередь. Проверьте Logs; канал повторно не публикуйте.");
    }catch{}
  }
}
async function discussionJobAllowed(job) {
  const c=await getChannel(job.channel_id);
  if(!c?.active||!c.discussion_enabled||!c.discussion_copy||
    String(c.discussion_group_id)!==String(job.group_id)||Number(c.discussion_version)!==Number(job.link_version))return null;
  const registered=(await pool.query("SELECT active FROM ep_discussion_groups WHERE chat_id=$1",[job.group_id])).rows[0];
  if(!registered?.active)return null;
  if(!(await checkAdministrator(c.max_chat_id,c.owner_user_id)))return null;
  const group=await verifiedGroup(job.group_id,c.owner_user_id);
  if(group.invite_url!==c.discussion_url)return null;
  return c;
}
async function dispatchDiscussion(job) {
  const task=apiTail.catch(()=>{}).then(async()=>{
    await sleep(Math.max(0,650-(Date.now()-lastApiCall)));
    const c=await discussionJobAllowed(job);
    if(!c){const e=new Error("Связка, права или ссылка чата изменились.");e.deliveryNotStarted=true;throw e;}
    const claim=await pool.query("UPDATE ep_discussion_jobs SET dispatch_started_at=NOW() WHERE id=$1 AND status='sending' RETURNING id",[job.id]);
    if(!claim.rowCount){const e=new Error("Задание отменено.");e.deliveryNotStarted=true;throw e;}
    if(Object.hasOwn(job.body_snapshot,"sender")||Object.hasOwn(job.body_snapshot,"link")){
      const e=new Error("Небезопасный формат копии.");e.deliveryNotStarted=true;throw e;
    }
    lastApiCall=Date.now();
    return maxRequest(`/messages?chat_id=${encodeURIComponent(job.group_id)}`,"POST",job.body_snapshot);
  });
  apiTail=task.catch(()=>{});return task;
}
async function processOneDiscussion() {
  const result=await pool.query(`SELECT * FROM ep_discussion_jobs WHERE status IN ('sending','pending') ORDER BY id LIMIT 1`);
  let job=result.rows[0];if(!job)return;
  if(job.status==="sending"){
    await pool.query("UPDATE ep_discussion_jobs SET status='needs_check',last_error='Процесс перезапустился во время копирования; проверьте чат' WHERE id=$1",[job.id]);
    const c=await getChannel(job.channel_id);if(c)await notify(c.owner_user_id,"Проверьте копию в чате: сервер перезапустился во время отправки. Автоповтора нет, пост канала не изменён.");return;
  }
  let allowed;
  try{allowed=await discussionJobAllowed(job);}
  catch(e){console.error("DISCUSSION CHECK ERROR:",e.message);}
  if(!allowed){
    await pool.query("UPDATE ep_discussion_jobs SET status='failed',last_error='Проверьте связь группы, актуальную ссылку и права владельца/бота' WHERE id=$1",[job.id]);
    const c=await getChannel(job.channel_id);if(c)await notify(c.owner_user_id,"Пост в канале опубликован, но копия в чат удержана: не удалось подтвердить связку или права. Откройте «Чат канала». Канал повторно не публикуйте.");return;
  }
  const claimed=await pool.query("UPDATE ep_discussion_jobs SET status='sending',dispatch_started_at=NULL WHERE id=$1 AND status='pending' RETURNING *",[job.id]);
  if(!claimed.rowCount)return;job=claimed.rows[0];
  let accepted=false;
  try{
    const sent=await dispatchDiscussion(job);accepted=true;
    await pool.query("UPDATE ep_discussion_jobs SET status='sent',group_mid=$2,last_error=NULL,updated_at=NOW() WHERE id=$1",[job.id,messageId(sent)]);
    console.log("DISCUSSION COPY SENT:",job.id);
  }catch(e){
    const definite=!accepted&&(e.deliveryNotStarted||(e.status>=400&&e.status<500&&e.status!==408));
    await pool.query("UPDATE ep_discussion_jobs SET status=$2,last_error=$3,updated_at=NOW() WHERE id=$1",[job.id,definite?"failed":"needs_check",e.message.slice(0,500)]);
    console.error("DISCUSSION COPY ERROR:",e.message);
    await notify(allowed.owner_user_id,"Основной пост в канале опубликован. "+(definite?"Копия в чат не отправлена.":"Результат копирования в чат не подтверждён. Проверьте группу; повтор отключён.")+" Подробности: «Чат канала» → «Последние копии».");
  }
}
async function disableDiscussionGroup(chatId) {
  await pool.query("UPDATE ep_discussion_groups SET active=FALSE,updated_at=NOW() WHERE chat_id=$1",[chatId]);
  const rows=await pool.query(`UPDATE channels SET discussion_enabled=FALSE,discussion_copy=FALSE,
    discussion_version=discussion_version+1,updated_at=NOW() WHERE discussion_group_id=$1 RETURNING id,owner_user_id`,[chatId]);
  await pool.query("UPDATE ep_discussion_jobs SET status='cancelled',last_error='Бот удалён из группы' WHERE group_id=$1 AND status='pending'",[chatId]);
  for(const c of rows.rows)await notify(c.owner_user_id,"EveryPost удалён из связанного чата. Копирование остановлено, кнопка отключена для новых постов. Старые опубликованные ссылки не меняются.");
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
  // Участники группы не являются авторами предложек. Их обычную переписку
  // не записываем в очередь; из группы обрабатываем только /registerchat.
  if (update.update_type === "message_created" && update.message?.recipient?.chat_type === "chat" &&
      plainCommand(update.message) !== "registerchat") return res.sendStatus(200);
  if (update.update_type === "message_callback" && update.message?.recipient?.chat_type &&
      update.message.recipient.chat_type !== "dialog") return res.sendStatus(200);
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
    if (job) {
      await handleUpdate(job.payload);
      await pool.query("UPDATE ep_webhook_jobs SET state = 'done', last_error = NULL WHERE id = $1", [job.id]);
    }
    // Ошибка фоновой отправки не переоткрывает успешно обработанный webhook.
    try { await processOneScheduled(); }
    catch (error) { console.error("SCHEDULE WORKER ERROR:", error.message); }
    try { await processOneDiscussion(); }
    catch (error) { console.error("DISCUSSION WORKER ERROR:", error.message); }
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
    void registerCommands();
  });
  setInterval(() => void runWorker(), 700).unref();
}
start().catch(error => {
  console.error("STARTUP ERROR:", error.message);
  process.exit(1);
});
