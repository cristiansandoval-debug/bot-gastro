const express = require("express");
const app = express();

app.use(express.json());

const VERIFY_TOKEN = "gastro_bot_2026";

app.get("/", (req, res) => {
  res.status(200).send("Bot Gastro activo");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("Webhook GET:", req.query);

  if (
    mode === "subscribe" &&
    token === VERIFY_TOKEN
  ) {
    return res.status(200).send(challenge);
  }

  return res.status(403).send("Token inválido");
});

app.post("/webhook", (req, res) => {
  console.log("Webhook recibido:", JSON.stringify(req.body, null, 2));
  return res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});