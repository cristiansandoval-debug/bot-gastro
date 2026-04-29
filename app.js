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
const SESSION_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 horas

function shouldResetSession(text) {
  const clean = text.toLowerCase().trim();
  return [
    "reiniciar",
    "reinicia",
    "comenzar de nuevo",
    "empezar de nuevo",
    "nuevo agendamiento",
    "partir de nuevo",
    "volver al inicio",
    "inicio",
    "reset"
  ].some((phrase) => clean.includes(phrase));
}

function createNewSession() {
  return {
    lastInteraction: Date.now(),
    messages: [
      {
        role: "system",
        content:
          SYSTEM_PROMPT +
          "\n\nIMPORTANTE: Si el paciente responde con un número, debes interpretarlo según el último menú mostrado."
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
      fechaPreferida: null,
      ordenMedicaRecibida: false
    }
  };
}

function getSession(from) {
  const existing = sessions[from];

  if (!existing) {
    sessions[from] = createNewSession();
    return sessions[from];
  }

  const inactiveTooLong =
    Date.now() - existing.lastInteraction > SESSION_TIMEOUT_MS;

  if (inactiveTooLong) {
    sessions[from] = createNewSession();
    return sessions[from];
  }

  existing.lastInteraction = Date.now();
  return existing;
}

function resetSession(from) {
  sessions[from] = createNewSession();
  return sessions[from];
}

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

function detectSede(lastAssistantMessage, userText) {
  if (!lastAssistantMessage) return null;

  const lower = lastAssistantMessage.toLowerCase();

  if (!lower.includes("sede preferida")) return null;

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

async function getOpenAIResponse(from, userMessage) {
  try {
    if (shouldResetSession(userMessage)) {
      resetSession(from);
      return `Perfecto, comenzamos desde el inicio.

Hola, soy el asistente virtual del Dr. Cristián Sandoval Vergés – Gastroenterólogo.

Te ayudaré a orientar tu solicitud.

Indícame qué necesitas:

1. Consulta médica
2. Procedimientos endoscópicos
3. Tengo otra duda`;
    }

    const session = getSession(from);

    const lastAssistantMessage =
      [...session.messages]
        .reverse()
        .find((m) => m.role === "assistant")?.content || "";

    const lowerLast = lastAssistantMessage.toLowerCase();
    const cleanUser = userMessage.trim();

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

    if (lowerLast.includes("qué procedimiento necesitas")) {
      if (cleanUser === "1") session.data.procedimiento = "Endoscopía digestiva alta";
      if (cleanUser === "2") session.data.procedimiento = "Colonoscopía completa";
      if (cleanUser === "3") {
        session.data.procedimiento =
          "Colonoscopía larga + endoscopía digestiva alta";
      }
    }

    const sedeDetectada = detectSede(lastAssistantMessage, cleanUser);

    if (sedeDetectada) {
      if (sedeDetectada === "vitacura") session.data.sede = "Vitacura";
      if (sedeDetectada === "los_dominicos") session.data.sede = "Los Dominicos";
      if (sedeDetectada === "bellavista") session.data.sede = "Bellavista";

      const reply = `Perfecto.

${getAvailableDatesText(sedeDetectada)}

Indícame el número de la opción que prefieres.`;

      session.messages.push({ role: "user", content: cleanUser });
      session.messages.push({ role: "assistant", content: reply });

      return reply;
    }

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

    return "Lo siento, hubo un problema al procesar tu mensaje.";
  }
}

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

      const reply = await getOpenAIResponse(from, userText);

      await sendWhatsAppMessage(from, reply);
    }

    if (message.type === "image") {
      console.log("Imagen recibida");

      const session = getSession(from);
      session.data.ordenMedicaRecibida = true;

      const reply = await getOpenAIResponse(
        from,
        `El paciente envió la foto de la orden médica.
Genera el resumen final usando los datos estructurados guardados y pregunta:
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
