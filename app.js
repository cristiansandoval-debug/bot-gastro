const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT;

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_USER = process.env.GMAIL_USER;

const sessions = {};
const SESSION_TIMEOUT_HOURS = 12;

/* =========================
   SESIONES
========================= */

function createNewSession() {
  return {
    lastActivity: Date.now(),
    messages: [
      {
        role: "system",
        content:
          SYSTEM_PROMPT +
          `

IMPORTANTE:
- Si el paciente responde con un número, debes interpretarlo según el último menú mostrado.
- NO uses placeholders como [Nombre], [RUT], etc.
- Usa siempre los datos reales guardados.
- Si el paciente pide comenzar nuevamente, reinicia completamente el flujo.
`
      }
    ],
    data: {
      nombre: null,
      rut: null,
      telefono: null,
      correo: null,
      prevision: null,
      procedimiento: null,
      sede: null,
      fechaPreferida: null
    }
  };
}

function getSession(from) {
  const now = Date.now();

  if (!sessions[from]) {
    sessions[from] = createNewSession();
    return sessions[from];
  }

  const diffHours =
    (now - sessions[from].lastActivity) / (1000 * 60 * 60);

  if (diffHours >= SESSION_TIMEOUT_HOURS) {
    sessions[from] = createNewSession();
  }

  sessions[from].lastActivity = now;

  return sessions[from];
}

function resetSession(from) {
  sessions[from] = createNewSession();
  return sessions[from];
}

/* =========================
   FECHAS
========================= */

function getNextDatesByWeekday(targetWeekday, count = 4) {
  const dates = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  let date = new Date(today);

  while (dates.length < count) {
    if (date.getDay() === targetWeekday && date >= today) {
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

  return `Horario base: ${horario}

Fechas disponibles para orientar la solicitud:

1. ${dates[0]}
2. ${dates[1]}
3. ${dates[2]}
4. ${dates[3]}
5. Otra fecha
6. Cualquiera
7. Atrás`;
}

/* =========================
   DETECTORES
========================= */

function detectSede(lastAssistantMessage, userText) {
  if (!lastAssistantMessage) return null;

  const lower = lastAssistantMessage.toLowerCase();

  if (!lower.includes("sede")) return null;

  if (
    lower.includes("vitacura") &&
    lower.includes("los dominicos") &&
    lower.includes("bellavista")
  ) {
    if (userText === "1") return "vitacura";
    if (userText === "2") return "los_dominicos";
    if (userText === "3") return "bellavista";
  }

  if (
    !lower.includes("vitacura") &&
    lower.includes("los dominicos") &&
    lower.includes("bellavista")
  ) {
    if (userText === "1") return "los_dominicos";
    if (userText === "2") return "bellavista";
  }

  return null;
}

function isFinalConfirmation(lastAssistantMessage) {
  if (!lastAssistantMessage) return false;

  const lower = lastAssistantMessage.toLowerCase();

  return (
    lower.includes("¿está seguro que desea enviar") ||
    lower.includes("esta seguro que desea enviar")
  );
}

/* =========================
   GMAIL API
========================= */

async function getGmailAccessToken() {
  const response = await axios.post(
    "https://oauth2.googleapis.com/token",
    {
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token"
    }
  );

  return response.data.access_token;
}

function makeEmailRaw({ from, to, cc, subject, body }) {
  const email = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
   `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body
  ]
    .filter(Boolean)
    .join("\n");

  return Buffer.from(email)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sendGmail({ to, cc, subject, body }) {
  const accessToken = await getGmailAccessToken();

  const raw = makeEmailRaw({
    from: GMAIL_USER,
    to,
    cc,
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

function buildEmailBody(data) {
  return `Nueva solicitud de procedimiento endoscópico

Nombre completo: ${data.nombre || "-"}
RUT: ${data.rut || "-"}
Teléfono: ${data.telefono || "-"}
Correo: ${data.correo || "-"}
Previsión: ${data.prevision || "-"}
Procedimiento: ${data.procedimiento || "-"}
Sede: ${data.sede || "-"}
Fecha preferida: ${data.fechaPreferida || "-"}

Solicitud generada desde Bot Procedimientos CSM.`;
}

/* =========================
   OPENAI
========================= */

async function getOpenAIResponse(from, userMessage) {
  try {
    if (
      userMessage.toLowerCase().includes("comenzar desde el principio") ||
      userMessage.toLowerCase().includes("empezar de nuevo")
    ) {
      resetSession(from);

      return "Perfecto. Reiniciamos desde el comienzo.\n\n1. Consulta médica\n2. Procedimientos endoscópicos\n3. Tengo otra duda";
    }

    const session = getSession(from);

    const lastAssistantMessage =
      [...session.messages]
        .reverse()
        .find((m) => m.role === "assistant")?.content || "";

    const lowerLast = lastAssistantMessage.toLowerCase();
    const cleanUser = userMessage.trim();

    /* Guardado estructurado */

    if (lowerLast.includes("nombre completo")) {
      session.data.nombre = cleanUser;
    }

    if (lowerLast.includes("rut")) {
      session.data.rut = cleanUser;
    }

    if (
      lowerLast.includes("teléfono") ||
      lowerLast.includes("telefono")
    ) {
      session.data.telefono = cleanUser;
    }

    if (
      lowerLast.includes("correo electrónico") ||
      lowerLast.includes("correo electronico")
    ) {
      session.data.correo = cleanUser;
    }

    if (
      lowerLast.includes("previsión") ||
      lowerLast.includes("prevision")
    ) {
      session.data.prevision = cleanUser;
    }

    /* Procedimiento */

    if (lowerLast.includes("qué procedimiento")) {
      if (cleanUser === "1") {
        session.data.procedimiento = "Endoscopía digestiva alta";
      }
      if (cleanUser === "2") {
        session.data.procedimiento = "Colonoscopía completa";
      }
      if (cleanUser === "3") {
        session.data.procedimiento =
          "Colonoscopía larga + endoscopía digestiva alta";
      }
    }

    /* Sede -> backend directo */

    const sedeDetectada = detectSede(
      lastAssistantMessage,
      cleanUser
    );

    if (sedeDetectada) {
      if (sedeDetectada === "vitacura") {
        session.data.sede = "Vitacura";
      }

      if (sedeDetectada === "los_dominicos") {
        session.data.sede = "Los Dominicos";
      }

      if (sedeDetectada === "bellavista") {
        session.data.sede = "Bellavista";
      }

      const reply = `Perfecto.

${getAvailableDatesText(sedeDetectada)}

Indícame el número de la opción que prefieres.`;

      session.messages.push({
        role: "assistant",
        content: reply
      });

      return reply;
    }

    /* Confirmación final + envío real */

    if (
      isFinalConfirmation(lastAssistantMessage) &&
      cleanUser === "1"
    ) {
      const emailBody = buildEmailBody(session.data);

      await sendGmail({
        to: "contacto@gastroenterologos.cl",
        cc: `cristian.sandoval@gastroenterologos.cl, ${session.data.correo || ""}`,
subject: `Nueva solicitud - ${session.data.procedimiento || "Procedimiento"}`
         body: emailBody
      });

      return `Tu solicitud fue enviada correctamente.

Recibirás una copia en tu correo electrónico: ${session.data.correo || "-"}

El equipo humano se pondrá en contacto contigo para confirmar disponibilidad final, presupuesto, preparación y agendamiento definitivo.`;
    }

    /* OpenAI normal */

    const finalUserMessage = `${cleanUser}

DATOS DEL PACIENTE:
${JSON.stringify(session.data, null, 2)}

Usa estos datos reales.
NO uses placeholders.`;

    session.messages.push({
      role: "user",
      content: finalUserMessage
    });

    if (session.messages.length > 30) {
      session.messages = [
        session.messages[0],
        ...session.messages.slice(-28)
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

    const reply =
      response.data.choices[0].message.content;

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

    return "Lo siento, hubo un problema al procesar tu solicitud.";
  }
}

/* =========================
   WHATSAPP
========================= */

async function sendWhatsAppMessage(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
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

/* =========================
   ROUTES
========================= */

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

app.post("/webhook", async (req, res) => {
  try {
    const message =
      req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;

    if (message.type === "text") {
      const userText = message.text.body;

      console.log("Mensaje recibido:", userText);

      const reply = await getOpenAIResponse(
        from,
        userText
      );

      await sendWhatsAppMessage(from, reply);
    }

    if (message.type === "image") {
      console.log("Imagen recibida");

      const reply = await getOpenAIResponse(
        from,
        `El paciente envió la foto de la orden médica. Genera el resumen final y pregunta:
1. Sí, enviar
2. No`
      );

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
