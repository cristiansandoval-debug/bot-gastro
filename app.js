const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "20mb" }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_USER = process.env.GMAIL_USER;

const TEST_DESTINATION_EMAIL = "contacto@gastroenterologos.cl";
const INTERNAL_BCC_EMAIL = "cristian.sandoval@gastroenterologos.cl";
const SESSION_TIMEOUT_MS = 12 * 60 * 60 * 1000;

const sessions = {};

function newSession() {
  return {
    lastActivity: Date.now(),
    step: "main_menu",
    dates: [],
    data: {
      flujo: null,
      procedimiento: null,
      ordenMedica: null,
      nombre: null,
      rut: null,
      telefono: null,
      correo: null,
      prevision: null,
      isapre: null,
      sede: null,
      fechaPreferida: null,
      latex: null,
      anticoagulantes: null,
      glp1: null,
      marcapasos: null,
      ordenMedicaMediaId: null,
      ordenMedicaBuffer: null,
      ordenMedicaMimeType: null
    }
  };
}

function getSession(from) {
  const now = Date.now();
  if (!sessions[from]) sessions[from] = newSession();

  if (now - sessions[from].lastActivity > SESSION_TIMEOUT_MS) {
    sessions[from] = newSession();
  }

  sessions[from].lastActivity = now;
  return sessions[from];
}

function resetSession(from) {
  sessions[from] = newSession();
  return sessions[from];
}

function isResetCommand(text) {
  const t = (text || "").toLowerCase().trim();
  return [
    "reiniciar",
    "reset",
    "comenzar de nuevo",
    "empezar de nuevo",
    "volver al inicio",
    "inicio",
    "partir de nuevo",
    "nuevo agendamiento"
  ].some(x => t.includes(x));
}

function onlyNumber(text) {
  return (text || "").trim();
}

function invalidOption(valid) {
  return `Por favor, responde solo con el número de una de las opciones: ${valid.join(", ")}.`;
}

function mainMenu() {
  return `Hola, soy el asistente virtual del Dr. Cristián Sandoval Vergés – Gastroenterólogo.

Te ayudaré a orientar tu solicitud.

Indícame qué necesitas:

1. Consulta médica
2. Procedimientos endoscópicos
3. Tengo otra duda`;
}

function consultasMenu() {
  return `¿Prefieres agendar tu consulta en:

1. Clínica Alemana Osorno (presencial)
2. Clínica Santa María (presencial)
3. gastroenterologos.cl (telemedicina)
4. Atrás`;
}

function procedimientosMenu() {
  return `¿Qué procedimiento necesitas?

1. Endoscopía digestiva alta
2. Colonoscopía completa
3. Colonoscopía larga + endoscopía digestiva alta
4. Otros
5. Atrás`;
}

function otrosMenu() {
  return `¿Qué procedimiento necesitas?

1. Polipectomía baja
2. Polipectomía alta
3. Colonoscopía corta
4. Ligadura de várices
5. Terapia argón plasma
6. Atrás`;
}

function ordenMedicaPregunta() {
  return `¿Tienes orden médica para el procedimiento?

1. Sí
2. No`;
}

function noOrdenMedicaMenu() {
  return `Para realizar el procedimiento generalmente se requiere evaluación médica previa y orden correspondiente.

Puedes agendar una consulta en:

1. Clínica Alemana Osorno (presencial)
2. Clínica Santa María (presencial)
3. gastroenterologos.cl (telemedicina)
4. Agendaré después cuando tenga mi orden médica`;
}

function previsionMenu() {
  return `Indícame tu previsión:

1. Fonasa
2. Isapre
3. Particular`;
}

function isapreMenu() {
  return `Selecciona tu Isapre:

1. Banmédica
2. Colmena
3. Consalud
4. Cruz Blanca
5. Nueva Masvida
6. Vida Tres
7. Esencial
8. Otra`;
}

function sedeMenu(data) {
  if (data.procedimiento === "Endoscopía digestiva alta") {
    return `¿Qué sede prefieres?

1. Vitacura
2. Los Dominicos
3. Bellavista
4. Cualquiera
5. Atrás

Horario base:
Vitacura → martes 08:30 a 12:00
Los Dominicos → lunes 08:30 a 13:00
Bellavista → miércoles 14:00 a 19:00`;
  }

  return `¿Qué sede prefieres?

1. Los Dominicos
2. Bellavista
3. Cualquiera
4. Atrás

Horario base:
Los Dominicos → lunes 08:30 a 13:00
Bellavista → miércoles 14:00 a 19:00`;
}

function getNextDatesByWeekday(targetWeekday, count = 4) {
  const dates = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  const d = new Date(today);
  while (dates.length < count) {
    if (d.getDay() === targetWeekday) {
      dates.push(new Date(d));
    }
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function formatDateCL(date) {
  return date.toLocaleDateString("es-CL", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
}

function weekdayForSede(sede) {
  if (sede === "Vitacura") return 2;
  if (sede === "Los Dominicos") return 1;
  if (sede === "Bellavista") return 3;
  return null;
}

function horarioForSede(sede) {
  if (sede === "Vitacura") return "martes 08:30 a 12:00";
  if (sede === "Los Dominicos") return "lunes 08:30 a 13:00";
  if (sede === "Bellavista") return "miércoles 14:00 a 19:00";
  return "";
}

function fechasMenu(session) {
  const weekday = weekdayForSede(session.data.sede);
  if (weekday === null) {
    session.dates = [];
    return `Elegiste sede flexible.

1. Cualquiera
2. Otra fecha
3. Atrás`;
  }

  const dates = getNextDatesByWeekday(weekday, 4);
  session.dates = dates.map(formatDateCL);

  return `Horario base: ${horarioForSede(session.data.sede)}

Fechas disponibles para orientar la solicitud:

1. ${session.dates[0]}
2. ${session.dates[1]}
3. ${session.dates[2]}
4. ${session.dates[3]}
5. Otra fecha
6. Cualquiera
7. Atrás`;
}

function siNoPregunta(text) {
  return `${text}

1. Sí
2. No`;
}

function resumenFinal(data) {
  return `He recibido la foto de la orden médica.

Resumen de tu solicitud:

- Nombre completo: ${data.nombre || "-"}
- RUT: ${data.rut || "-"}
- Teléfono: ${data.telefono || "-"}
- Correo electrónico: ${data.correo || "-"}
- Previsión: ${data.prevision || "-"}${data.isapre ? ` (${data.isapre})` : ""}
- Procedimiento solicitado: ${data.procedimiento || "-"}
- Sede: ${data.sede || "-"}
- Fecha preferida: ${data.fechaPreferida || "-"}
- Alérgico al látex: ${data.latex || "-"}
- Usa anticoagulantes: ${data.anticoagulantes || "-"}
- Usa GLP-1: ${data.glp1 || "-"}
- Tiene marcapasos: ${data.marcapasos || "-"}

Esto NO constituye un agendamiento definitivo.

Este asistente solo ayuda a orientar tu solicitud y dejarla preparada. Se enviará un correo al equipo humano correspondiente para que puedan contactarte y confirmar disponibilidad final, presupuesto, preparación y agendamiento definitivo.

El paciente recibirá una copia de su solicitud en su correo.

¿Está seguro que desea enviar su solicitud de agendamiento?

1. Sí, enviar
2. No`;
}
async function getGmailAccessToken() {
  const response = await axios.post("https://oauth2.googleapis.com/token", {
    client_id: GMAIL_CLIENT_ID,
    client_secret: GMAIL_CLIENT_SECRET,
    refresh_token: GMAIL_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });

  return response.data.access_token;
}

function encodeSubject(subject) {
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildEmailBody(data) {
  return `Nueva solicitud de procedimiento endoscópico

DATOS DEL PACIENTE
Nombre completo: ${data.nombre || "-"}
RUT: ${data.rut || "-"}
Teléfono: ${data.telefono || "-"}
Correo: ${data.correo || "-"}
Previsión: ${data.prevision || "-"}${data.isapre ? ` (${data.isapre})` : ""}

PROCEDIMIENTO
Procedimiento: ${data.procedimiento || "-"}
Sede: ${data.sede || "-"}
Fecha preferida: ${data.fechaPreferida || "-"}

ENCUESTA CLÍNICA
Alérgico al látex: ${data.latex || "-"}
Usa anticoagulantes: ${data.anticoagulantes || "-"}
Usa GLP-1: ${data.glp1 || "-"}
Tiene marcapasos: ${data.marcapasos || "-"}

IMPORTANTE
Esta solicitud no constituye agendamiento definitivo.
Debe ser revisada y confirmada por el equipo humano correspondiente.

Modo actual: PRUEBA
Correo centralizado: ${TEST_DESTINATION_EMAIL}`;
}

function buildRawEmailWithAttachment({
  from,
  to,
  cc,
  bcc,
  subject,
  body,
  attachment
}) {
  const boundary = `boundary_${Date.now()}`;

  const headers = [
    `From: No Reply Gastroenterologos.cl <${from}>`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ].filter(Boolean);

  const parts = [];

  parts.push(
`--${boundary}
Content-Type: text/plain; charset="UTF-8"
Content-Transfer-Encoding: 7bit

${body}`
  );

  if (attachment && attachment.buffer) {
    const filename = attachment.filename || "orden_medica.jpg";
    const mimeType = attachment.mimeType || "image/jpeg";
    const encoded = attachment.buffer.toString("base64");

    parts.push(
`--${boundary}
Content-Type: ${mimeType}; name="${filename}"
Content-Disposition: attachment; filename="${filename}"
Content-Transfer-Encoding: base64

${encoded}`
    );
  }

  parts.push(`--${boundary}--`);

  return base64Url(
    Buffer.from(
      headers.join("\n") + "\n\n" + parts.join("\n\n"),
      "utf8"
    )
  );
}

async function sendGmailWithAttachment({
  to,
  cc,
  bcc,
  subject,
  body,
  attachment
}) {
  const accessToken = await getGmailAccessToken();

  const raw = buildRawEmailWithAttachment({
    from: GMAIL_USER,
    to,
    cc,
    bcc,
    subject,
    body,
    attachment
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

async function downloadWhatsAppMedia(mediaId) {
  const mediaInfo = await axios.get(
    `https://graph.facebook.com/v18.0/${mediaId}`,
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`
      }
    }
  );

  const mediaUrl = mediaInfo.data.url;
  const mimeType = mediaInfo.data.mime_type || "image/jpeg";

  const fileResponse = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`
    }
  });

  return {
    buffer: Buffer.from(fileResponse.data),
    mimeType
  };
}

async function sendSolicitudEmail(session) {
  const data = session.data;

  await sendGmailWithAttachment({
    to: TEST_DESTINATION_EMAIL,
    cc: data.correo || undefined,
    bcc: INTERNAL_BCC_EMAIL,
    subject: `Nueva solicitud - ${data.procedimiento || "Procedimiento"}`,
    body: buildEmailBody(data),
    attachment: data.ordenMedicaBuffer
      ? {
          buffer: data.ordenMedicaBuffer,
          mimeType: data.ordenMedicaMimeType || "image/jpeg",
          filename: "orden_medica.jpg"
        }
      : null
  });
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

function handleText(from, text) {
  const session = getSession(from);
  const value = onlyNumber(text);

  if (isResetCommand(value)) {
    resetSession(from);
    return mainMenu();
  }

  switch (session.step) {
    case "main_menu": {
      if (!["1", "2", "3"].includes(value)) {
        return invalidOption(["1", "2", "3"]);
      }

      if (value === "1") {
        session.step = "consulta_menu";
        return consultasMenu();
      }

      if (value === "2") {
        session.step = "procedimiento_menu";
        return procedimientosMenu();
      }

      session.step = "otra_duda";

      return `Puedes escribir a info@gastroenterologos.cl y nuestro equipo te ayudará.

Si deseas volver al inicio, escribe: comenzar de nuevo`;
    }

    default:
      return "Parte 2 continúa exactamente como la versión anterior que te envié. Si al pegar aparece truncado, me dices 'seguir parte 2' y continúo desde aquí exacto.";
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
      const reply = handleText(from, message.text.body);
      await sendWhatsAppMessage(from, reply);
    }

    if (message.type === "image") {
      await sendWhatsAppMessage(
        from,
        "Imagen recibida correctamente."
      );
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
