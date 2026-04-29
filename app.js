const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT;

const sessions = {};

function getNextDatesByWeekday(targetWeekday, count = 4) {
  const dates = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  let date = new Date(today);

  while (dates.length < count) {
    const day = date.getDay(); // 0 domingo, 1 lunes, 2 martes, 3 miércoles

    if (day === targetWeekday && date >= today) {
      dates.push(
        date.toLocaleDateString("es-CL", {
          weekday: "long",
          day: "2-digit",
          month: "long",
          year: "numeric"
        })
      );
    }

    date.setDate(date.getDate() + 1);
  }

  return dates;
}

function getAvailableDatesText(sede) {
  let weekday;
  let horario;

  if (sede === "vitacura") {
    weekday = 2;
    horario = "martes 08:30 a 12:00";
  } else if (sede === "los_dominicos") {
    weekday = 1;
    horario = "lunes 08:30 a 13:00";
  } else if (sede === "bellavista") {
    weekday = 3;
    horario = "miércoles 14:00 a 19:00";
  } else {
    return "";
  }

  const dates = getNextDatesByWeekday(weekday, 4);

  return `
DATOS REALES CALCULADOS POR BACKEND.
Usa exactamente estas fechas. No inventes otras.

Horario base: ${horario}

Fechas disponibles para orientar la solicitud:

1. ${dates[0]}
2. ${dates[1]}
3. ${dates[2]}
4. ${dates[3]}
5. Otra fecha
6. Cualquiera
7. Atrás
`;
}

function detectSedeFromUserChoice(lastAssistantMessage, userText) {
  const text = userText.trim();

  if (!lastAssistantMessage) return null;

  const lower = lastAssistantMessage.toLowerCase();

  if (!lower.includes("sede prefieres")) return null;

  // Menú con Vitacura + Los Dominicos + Bellavista
  if (
    lower.includes("vitacura") &&
    lower.includes("los dominicos") &&
    lower.includes("bellavista")
  ) {
    if (text === "1") return "vitacura";
    if (text === "2") return "los_dominicos";
    if (text === "3") return "bellavista";
    return null;
  }

  // Menú solo Los Dominicos + Bellavista
  if (
    !lower.includes("vitacura") &&
    lower.includes("los dominicos") &&
    lower.includes("bellavista")
  ) {
    if (text === "1") return "los_dominicos";
    if (text === "2") return "bellavista";
    return null;
  }

  return null;
}

app.get("/", (req, res) => {
  res.status(200).send("Bot Gastro activo");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

function getSession(from) {
  if (!sessions[from]) {
    sessions[from] = {
      messages: [
        {
          role: "system",
          content:
            SYSTEM_PROMPT +
            "\n\nIMPORTANTE: Si el paciente responde con un número, debes interpretarlo según el último menú mostrado y no según el menú principal. Cuando recibas DATOS REALES CALCULADOS POR BACKEND, debes usar exactamente esas fechas y no inventar otras."
        }
      ]
    };
  }

  return sessions[from];
}

async function getOpenAIResponse(from, userMessage) {
  try {
    const session = getSession(from);

    const lastAssistantMessage = [...session.messages]
      .reverse()
      .find((m) => m.role === "assistant")?.content;

    const sedeDetectada = detectSedeFromUserChoice(
      lastAssistantMessage,
      userMessage
    );

    let finalUserMessage = userMessage;

    if (sedeDetectada) {
      const fechasReales = getAvailableDatesText(sedeDetectada);

      finalUserMessage =
        userMessage +
        "\n\n" +
        fechasReales +
        "\nResponde mostrando estas opciones de fecha al paciente de forma breve, clara y ordenada.";
    }

    session.messages.push({
      role: "user",
      content: finalUserMessage
    });

    if (session.messages.length > 20) {
      session.messages = [
        session.messages[0],
        ...session.messages.slice(-18)
      ];
    }

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: session.messages,
        temperature: 0.2
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reply = response.data.choices[0].message.content;

    session.messages.push({
      role: "assistant",
      content: reply
    });

    return reply;
  } catch (error) {
    console.error(
      "Error OpenAI:",
      error.response?.data || error.message
    );

    return "Lo siento, hubo un problema al procesar tu mensaje. Por favor intenta nuevamente.";
  }
}

async function sendWhatsAppMessage(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        text: {
          body: message
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (error) {
    console.error(
      "Error enviando WhatsApp:",
      error.response?.data || error.message
    );
  }
}
async function getGmailAccessToken() {
  const response = await axios.post("https://oauth2.googleapis.com/token", {
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });

  return response.data.access_token;
}

function makeEmailRaw({ from, to, subject, body }) {
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body
  ].join("\n");

  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sendGmail({ to, subject, body }) {
  const accessToken = await getGmailAccessToken();

  const raw = makeEmailRaw({
    from: process.env.GMAIL_USER,
    to,
    subject,
    body
  });

  await axios.post(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    { raw },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    }
  );
}

app.get("/test-email", async (req, res) => {
  try {
    if (req.query.token !== process.env.VERIFY_TOKEN) {
      return res.status(403).send("No autorizado");
    }

    await sendGmail({
      to: process.env.GMAIL_USER,
      subject: "Prueba Bot Procedimientos CSM",
      body: "Correo de prueba enviado correctamente desde Render usando Gmail API."
    });

    return res.status(200).send("Correo enviado correctamente");
  } catch (error) {
    console.error("Error enviando correo Gmail:", error.response?.data || error.message);
    return res.status(500).send("Error enviando correo");
  }
});
app.post("/webhook", async (req, res) => {
  try {
    const message =
      req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (message && message.type === "text") {
      const from = message.from;
      const userText = message.text.body;

      console.log("Mensaje recibido:", userText);

      const reply = await getOpenAIResponse(from, userText);

      await sendWhatsAppMessage(from, reply);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Error webhook:", error);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
