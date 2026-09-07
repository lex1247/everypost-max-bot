import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN;

// Проверка, что сервер жив
app.get("/", (req, res) => {
  res.status(200).json({
    service: "EveryPost MAX",
    status: "running"
  });
});

// Webhook от MAX
app.post("/webhook", async (req, res) => {
  // MAX должен быстро получить 200 OK
  res.sendStatus(200);

  try {
    const update = req.body;

    console.log(
      "MAX update:",
      JSON.stringify(update)
    );

    // Пока только принимаем события.
    // Логику клиентов, каналов, предложок и постинга
    // будем добавлять следующим этапом.
  } catch (error) {
    console.error("Webhook error:", error);
  }
});

app.listen(PORT, () => {
  console.log(`EveryPost MAX started on port ${PORT}`);

  if (!MAX_BOT_TOKEN) {
    console.log(
      "MAX_BOT_TOKEN is not set yet. Waiting for bot moderation."
    );
  }
});
