process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN;

if (!MAX_BOT_TOKEN) {
  throw new Error("MAX_BOT_TOKEN is not set");
}

async function maxGet(path) {
  const response = await fetch(`https://platform-api2.max.ru${path}`, {
    headers: {
      Authorization: MAX_BOT_TOKEN
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`MAX API ${response.status}: ${text}`);
  }

  return JSON.parse(text);
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

    // EveryPost добавили в канал
    if (update.update_type === "bot_added" && update.is_channel === true) {
      const chatId = update.chat_id;
      const addedByUserId = update.user?.user_id;

      console.log("CHANNEL DETECTED:", chatId);
      console.log("ADDED BY USER:", addedByUserId);

      // Получаем данные канала
      const channel = await maxGet(`/chats/${chatId}`);

      // Проверяем права EveryPost в этом канале
      const botMembership = await maxGet(`/chats/${chatId}/members/me`);

      console.log(
        "CONNECTED CHANNEL:",
        JSON.stringify({
          chat_id: chatId,
          title: channel.title ?? channel.name ?? null,
          added_by_user_id: addedByUserId,
          bot_permissions: botMembership.permissions ?? []
        })
      );

      // Пока НЕ сохраняем в БД.
      // На этом этапе проверяем корректность всей цепочки.
      return;
    }

    if (update.update_type === "bot_removed") {
      console.log("BOT REMOVED FROM:", update.chat_id);
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
      console.log("MESSAGE RECEIVED");
      return;
    }

  } catch (error) {
    console.error("Webhook error:", error);
  }
});

app.listen(PORT, () => {
  console.log(`EveryPost MAX started on port ${PORT}`);
});
