// ============================================================
// BOT WHATSAPP - Dr. Cristián Sandoval Vergés – Gastroenterólogo
// Arquitectura: Steps fijos en código + GPT para respuestas naturales
// ============================================================

const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// ============================================================
// VARIABLES DE ENTORNO (configurar en Render)
// ============================================================
const WHATSAPP_TOKEN       = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID      = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN         = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY       = process.env.OPENAI_API_KEY;
const GMAIL_CLIENT_ID      = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET  = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN  = process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_USER           = process.env.GMAIL_USER;
const DESTINATION_EMAIL    = process.env.DESTINATION_EMAIL    || "contacto@gastroenterologos.cl";
const INTERNAL_BCC_EMAIL   = process.env.INTERNAL_BCC_EMAIL   || "cristian.sandoval@clinicasantamaria.cl";
const GOOGLE_SHEET_ID      = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY   = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

// ============================================================
// DEFINICIÓN DE STEPS
// ============================================================
const STEPS = {
  MENU_PRINCIPAL:        "menu_principal",
  // Flujo consulta médica
  SEDE_CONSULTA:         "sede_consulta",
  // Flujo procedimientos
  TIPO_PROCEDIMIENTO:    "tipo_procedimiento",
  TIPO_PROCEDIMIENTO_OTROS: "tipo_procedimiento_otros",
  TIENE_ORDEN:           "tiene_orden",
  SIN_ORDEN_CONSULTA:    "sin_orden_consulta",
  NOMBRE:                "nombre",
  EDAD:                  "edad",
  RUT:                   "rut",
  TELEFONO:              "telefono",
  CORREO:                "correo",
  PREVISION:             "prevision",
  ISAPRE:                "isapre",
  SEDE_PROCEDIMIENTO:    "sede_procedimiento",
  FECHA:                 "fecha",
  LATEX:                 "latex",
  ANTICOAGULANTES:       "anticoagulantes",
  GLP1:                  "glp1",
  MARCAPASOS:            "marcapasos",
  ESPERANDO_ORDEN_FOTO:  "esperando_orden_foto",
  CONFIRMAR_ENVIO:       "confirmar_envio",
  // Flujo otra duda
  OTRA_DUDA:             "otra_duda",
  OTRA_DUDA_MENU:        "otra_duda_menu",
  OTRA_DUDA_CONTACTO:    "otra_duda_contacto",
  OTRA_DUDA_SOBRECUPO:   "otra_duda_sobrecupo",
  // Confirmaciones inline
  CONFIRMAR_TELEFONO:    "confirmar_telefono",
  CONFIRMAR_CORREO:      "confirmar_correo",
};

// ============================================================
// SEDES Y DISPONIBILIDAD BASE
// ============================================================
const DISPONIBILIDAD_BASE = {
  vitacura:      { dia: "martes",    horario: "08:30 a 12:00" },
  los_dominicos: { dia: "lunes",     horario: "08:30 a 13:00" },
  bellavista:    { dia: "miércoles", horario: "14:00 a 19:00" },
};

// Procedimientos disponibles por sede
const SEDES_POR_PROCEDIMIENTO = {
  endoscopia:     ["vitacura", "los_dominicos", "bellavista"],
  colonoscopia:   ["los_dominicos", "bellavista"],
  ambos:          ["los_dominicos", "bellavista"],
  polipectomia_baja:  ["los_dominicos", "bellavista"],
  polipectomia_alta:  ["bellavista"],
  colonoscopia_corta: ["los_dominicos", "bellavista"],
  ligadura_varices:   ["bellavista"],
  argon_plasma:       ["bellavista"],
};

// ============================================================
// SESIONES EN MEMORIA
// ============================================================
const sessions = {};

function getSession(from) {
  if (!sessions[from]) {
    sessions[from] = {
      step: STEPS.MENU_PRINCIPAL,
      data: {},
      history: [], // historial para GPT
    };
  }
  return sessions[from];
}

function resetSession(from) {
  sessions[from] = {
    step: STEPS.MENU_PRINCIPAL,
    data: {},
    history: [],
  };
}

// ============================================================
// UTILIDADES
// ============================================================
function cleanText(text) {
  return text?.trim().toLowerCase().replace(/[.,!?]/g, "") || "";
}

function isResetCommand(text) {
  return ["reiniciar", "comenzar de nuevo", "inicio", "menu", "menú", "reset", "volver", "salir"].includes(text);
}

// Formatea teléfono chileno a +56 9 XXXX XXXX
function formatearTelefono(raw) {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("56")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 9) {
    return `+56 ${digits.slice(0,1)} ${digits.slice(1,5)} ${digits.slice(5)}`;
  }
  if (digits.length === 8) {
    return `+56 ${digits.slice(0,2)} ${digits.slice(2,6)} ${digits.slice(6)}`;
  }
  return null;
}

// Calcula los próximos N días de la semana, devuelve {label, fecha}
function proximosDias(diaNombre, cantidad = 4) {
  const diasMap = {
    domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3,
    jueves: 4, viernes: 5, sabado: 6, sábado: 6
  };
  const nombresCapitalizados = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  const diaNum = diasMap[diaNombre.toLowerCase()];
  const hoy = new Date();
  const fechas = [];
  let fecha = new Date(hoy);

  while (fechas.length < cantidad) {
    fecha.setDate(fecha.getDate() + 1);
    if (fecha.getDay() === diaNum) {
      const d = fecha.getDate().toString().padStart(2, "0");
      const m = (fecha.getMonth() + 1).toString().padStart(2, "0");
      const y = fecha.getFullYear();
      fechas.push({
        label: `${nombresCapitalizados[fecha.getDay()]} ${d}/${m}/${y}`,
        fecha: `${d}/${m}/${y}`
      });
    }
  }
  return fechas;
}

// Devuelve todas las fechas disponibles en los próximos 30 días para todas las sedes dadas
function todasLasFechas30Dias(sedesKeys) {
  const diasMap = {
    domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3,
    jueves: 4, viernes: 5, sabado: 6, sábado: 6
  };
  const nombresCapitalizados = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  const hoy = new Date();
  const limite = new Date(hoy);
  limite.setDate(limite.getDate() + 30);

  const resultados = [];
  let fecha = new Date(hoy);
  fecha.setDate(fecha.getDate() + 1);

  while (fecha <= limite) {
    for (const sedeKey of sedesKeys) {
      const info = DISPONIBILIDAD_BASE[sedeKey];
      if (!info) continue;
      const diaNum = diasMap[info.dia.toLowerCase()];
      if (fecha.getDay() === diaNum) {
        const d = fecha.getDate().toString().padStart(2, "0");
        const m = (fecha.getMonth() + 1).toString().padStart(2, "0");
        const y = fecha.getFullYear();
        resultados.push({
          label: `${nombresCapitalizados[fecha.getDay()]} ${d}/${m}/${y} — ${nombreSede(sedeKey)}`,
          fecha: `${d}/${m}/${y}`,
          sede: nombreSede(sedeKey),
          sedeKey
        });
      }
    }
    fecha.setDate(fecha.getDate() + 1);
  }

  // Ordenar por fecha
  return resultados.sort((a, b) => {
    const [da, ma, ya] = a.fecha.split("/").map(Number);
    const [db, mb, yb] = b.fecha.split("/").map(Number);
    return new Date(ya, ma-1, da) - new Date(yb, mb-1, db);
  });
}

function nombreSede(key) {
  const nombres = {
    vitacura: "Vitacura",
    los_dominicos: "Los Dominicos",
    bellavista: "Bellavista",
  };
  return nombres[key] || key;
}

// ============================================================
// GOOGLE SHEETS - Leer disponibilidad real
// ============================================================
async function getDisponibilidadSheet() {
  if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    return null; // Si no está configurado, retorna null (usa solo base)
  }
  try {
    const auth = new google.auth.JWT(
      GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      GOOGLE_PRIVATE_KEY,
      ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    );
    const sheets = google.sheets({ version: "v4", auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "A:Z", // Ajusta el rango según tu hoja
    });
    return response.data.values || [];
  } catch (err) {
    console.error("Error Google Sheets:", err.message);
    return null;
  }
}

// ============================================================
// GPT - Respuestas naturales
// ============================================================
const SYSTEM_PROMPT = `Eres la secretaria virtual del Dr. Cristián Sandoval Vergés – Gastroenterólogo.
Tu función es responder con tono cálido, profesional, breve y claro, en español.
NO tomas decisiones de flujo. Solo redactas la respuesta al paciente según la instrucción que recibes.
NO inventes información médica, horarios ni fechas.
NO digas que agendas definitivamente. Siempre aclara que es una orientación/solicitud.
Responde siempre en máximo 3-4 líneas, sin listas largas innecesarias.`;

async function gptResponde(instruccion, historial = []) {
  try {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...historial.slice(-6), // últimas 6 interacciones para contexto
      { role: "user", content: instruccion },
    ];

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini", // Buena relación calidad/precio
        max_tokens: 300,
        temperature: 0.4,
        messages,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.choices[0].message.content.trim();
  } catch (err) {
    console.error("Error GPT:", err.response?.data || err.message);
    return null;
  }
}

// ============================================================
// GMAIL - Envío de correo
// ============================================================
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

async function getGmailAccessToken() {
  const response = await axios.post("https://oauth2.googleapis.com/token", {
    client_id: GMAIL_CLIENT_ID,
    client_secret: GMAIL_CLIENT_SECRET,
    refresh_token: GMAIL_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  return response.data.access_token;
}

function buildEmailBody(data) {
  return `Nueva solicitud de procedimiento endoscópico — Dr. Cristián Sandoval Vergés
${"=".repeat(50)}

DATOS DEL PACIENTE
Nombre completo : ${data.nombre     || "-"}
Edad            : ${data.edad       ? `${data.edad} años` : "-"}
RUT             : ${data.rut        || "-"}
Teléfono        : ${data.telefono   || "-"}
Correo          : ${data.correo     || "-"}
Previsión       : ${data.prevision  || "-"}${data.isapre ? ` (${data.isapre})` : ""}

PROCEDIMIENTO
Procedimiento   : ${data.procedimiento  || "-"}
Sede            : ${data.sede           || "-"}
Fecha preferida : ${data.fechaPreferida || "-"}

ENCUESTA CLÍNICA
Alérgico al látex    : ${data.latex           || "-"}
Usa anticoagulantes  : ${data.anticoagulantes  || "-"}
Usa GLP-1            : ${data.glp1            || "-"}
Tiene marcapasos     : ${data.marcapasos      || "-"}

${"=".repeat(50)}
IMPORTANTE
Esta solicitud NO constituye agendamiento definitivo.
Debe ser revisada y confirmada por el equipo humano correspondiente.`;
}

function buildRawEmail({ from, to, cc, bcc, subject, body, attachment }) {
  const boundary = `boundary_${Date.now()}`;
  const headers = [
    `From: No Reply Gastroenterologos.cl <${from}>`,
    `To: ${to}`,
    cc  ? `Cc: ${cc}`   : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean);

  const parts = [
    `--${boundary}\nContent-Type: text/plain; charset="UTF-8"\nContent-Transfer-Encoding: 7bit\n\n${body}`,
  ];

  if (attachment?.buffer) {
    parts.push(
      `--${boundary}\nContent-Type: ${attachment.mimeType || "image/jpeg"}; name="orden_medica.jpg"\nContent-Disposition: attachment; filename="orden_medica.jpg"\nContent-Transfer-Encoding: base64\n\n${attachment.buffer.toString("base64")}`
    );
  }

  parts.push(`--${boundary}--`);

  return base64Url(
    Buffer.from(headers.join("\n") + "\n\n" + parts.join("\n\n"), "utf8")
  );
}

async function sendSolicitudEmail(session) {
  const accessToken = await getGmailAccessToken();
  const raw = buildRawEmail({
    from:       GMAIL_USER,
    to:         DESTINATION_EMAIL,
    cc:         session.data.correo || undefined,
    bcc:        INTERNAL_BCC_EMAIL,
    subject:    `Nueva solicitud - ${session.data.procedimiento || "Procedimiento"} - ${session.data.nombre || "Paciente"}`,
    body:       buildEmailBody(session.data),
    attachment: session.data.ordenMedicaBuffer
      ? { buffer: session.data.ordenMedicaBuffer, mimeType: session.data.ordenMedicaMimeType }
      : null,
  });

  await axios.post(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    { raw },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ============================================================
// WHATSAPP - Enviar mensaje
// ============================================================
async function sendWhatsAppMessage(to, message) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ============================================================
// DESCARGAR MEDIA DE WHATSAPP
// ============================================================
async function downloadWhatsAppMedia(mediaId) {
  const mediaInfo = await axios.get(
    `https://graph.facebook.com/v18.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
  const file = await axios.get(mediaInfo.data.url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  return {
    buffer:   Buffer.from(file.data),
    mimeType: mediaInfo.data.mime_type || "image/jpeg",
  };
}

// ============================================================
// MENSAJES FIJOS DEL FLUJO
// ============================================================
function msgMenuPrincipal() {
  return `👋 Hola, soy el asistente virtual del *Dr. Cristián Sandoval Vergés – Gastroenterólogo*.

Te ayudaré a orientar tu solicitud.

¿Qué necesitas?

1️⃣ Consulta médica
2️⃣ Procedimientos endoscópicos
3️⃣ Tengo otra duda`;
}

function msgSedeConsulta() {
  return `¿Prefieres agendar tu consulta en:

1️⃣ Clínica Alemana Osorno (presencial)
2️⃣ Clínica Santa María (presencial)
3️⃣ gastroenterologos.cl (telemedicina)
4️⃣ Volver al menú principal`;
}

function msgInfoClinicaAlemana() {
  return `Puedes agendar tu consulta presencial en *Clínica Alemana Osorno* por:

📞 Call center: 600 401 5007
🌐 Web: https://www.clinicaalemanaosorno.cl/informacion-al-paciente/reserva-hora/

¿Necesitas algo más? Escribe *menú* para volver al inicio.`;
}

function msgInfoClinicaSantaMaria() {
  return `Puedes agendar tu consulta presencial en *Clínica Santa María* por:

📞 Call center: +56 2 2913 0000
💬 WhatsApp: +56 2 2914 2472
🌐 Web: https://www.clinicasantamaria.cl/reserva-de-horas
🏥 También puedes ir directamente de forma presencial

¿Necesitas algo más? Escribe *menú* para volver al inicio.`;
}

function msgInfoGastroWeb() {
  return `Puedes agendar tu consulta de *telemedicina* (primera consulta o control) directamente en:

🌐 https://gastroenterologos.cl/dr-cristian-sandoval-verges/

Esta modalidad es externa a Clínica Santa María.

¿Necesitas algo más? Escribe *menú* para volver al inicio.`;
}

function msgTipoProcedimiento() {
  return `Te ayudaremos a encontrar una fecha disponible para iniciar tu *solicitud de agendamiento*.

_Ten en cuenta que esto no constituye un agendamiento definitivo. El equipo humano confirmará disponibilidad, presupuesto y preparación una vez recibida tu solicitud._

¿Qué procedimiento necesitas?

1️⃣ Endoscopía digestiva alta
2️⃣ Colonoscopía completa
3️⃣ Colonoscopía larga + endoscopía digestiva alta
4️⃣ Otros procedimientos`;
}

function msgOtrosProcedimientos() {
  return `Selecciona el procedimiento:

1️⃣ Polipectomía baja
2️⃣ Polipectomía alta
3️⃣ Colonoscopía corta
4️⃣ Ligadura de várices
5️⃣ Terapia argón plasma
6️⃣ Volver`;
}

function msgTieneOrden() {
  return `¿Tienes *orden médica* para el procedimiento?

1️⃣ Sí
2️⃣ No

_Te recomendamos tener tu orden a mano, ya que más adelante deberás fotografiarla o adjuntarla para completar tu solicitud._`;
}

function msgSinOrden() {
  return `Para realizar este procedimiento necesitas primero una *orden médica*.

Debes agendar una consulta médica para evaluación:

1️⃣ Clínica Alemana Osorno (presencial)
2️⃣ Clínica Santa María (presencial)
3️⃣ gastroenterologos.cl (telemedicina)
4️⃣ Agendaré cuando tenga mi orden médica`;
}

function msgSedeProcedimiento(sedesDisponibles) {
  const opciones = sedesDisponibles.map((s, i) => {
    const info = DISPONIBILIDAD_BASE[s];
    return `${i + 1}️⃣ ${nombreSede(s)} → ${info.dia} ${info.horario}`;
  });
  opciones.push(`${sedesDisponibles.length + 1}️⃣ Ver todos los días disponibles (próximos 30 días)`);

  return `¿En qué sede prefieres el procedimiento?\n\n${opciones.join("\n")}`;
}

async function msgFechas(sede) {
  const info = DISPONIBILIDAD_BASE[sede];
  if (!info) return "No hay disponibilidad base para esa sede.";

  const fechas = proximosDias(info.dia, 4);

  // Intentar cruzar con Google Sheet
  let notaSheet = "";
  const sheetData = await getDisponibilidadSheet();
  if (sheetData && sheetData.length > 0) {
    notaSheet = "\n\n_Disponibilidad confirmada según agenda actualizada._";
  }

  const opciones = fechas.map((f, i) => `${i + 1}️⃣ ${f.label}`).join("\n");

  return `Estas son las próximas fechas disponibles en *${nombreSede(sede)}*:

${opciones}
5️⃣ Otra fecha${notaSheet}

Elige una opción:`;
}

function msgTodasLasFechas(sedesKeys) {
  const fechas = todasLasFechas30Dias(sedesKeys);
  if (fechas.length === 0) return "No hay fechas disponibles en los próximos 30 días.";

  const opciones = fechas.map((f, i) => `${i + 1}️⃣ ${f.label}`).join("\n");

  return `Fechas disponibles en los *próximos 30 días*:\n\n${opciones}\n\nElige una opción:`;
}

function msgResumenFinal(data) {
  return `📋 *Resumen de tu solicitud:*

👤 *Paciente:* ${data.nombre || "-"}
🎂 *Edad:* ${data.edad ? `${data.edad} años` : "-"}
🪪 *RUT:* ${data.rut || "-"}
📞 *Teléfono:* ${data.telefono || "-"}
📧 *Correo:* ${data.correo || "-"}
🏥 *Previsión:* ${data.prevision || "-"}${data.isapre ? ` (${data.isapre})` : ""}

🔬 *Procedimiento:* ${data.procedimiento || "-"}
📍 *Sede:* ${data.sede || "-"}
📅 *Fecha preferida:* ${data.fechaPreferida || "-"}

⚠️ _Esta solicitud NO constituye un agendamiento definitivo._
El equipo humano se contactará contigo para confirmar disponibilidad, presupuesto y preparación.

¿Deseas *enviar tu solicitud*?

1️⃣ Sí, enviar
2️⃣ No, cancelar`;
}

// ============================================================
// LÓGICA DE FLUJO PRINCIPAL
// ============================================================
async function procesarMensaje(from, text, session) {
  const t = cleanText(text);

  // ── MENÚ PRINCIPAL ──────────────────────────────────────
  if (session.step === STEPS.MENU_PRINCIPAL) {
    if (t === "1") {
      session.step = STEPS.SEDE_CONSULTA;
      return msgSedeConsulta();
    }
    if (t === "2") {
      session.step = STEPS.TIPO_PROCEDIMIENTO;
      return msgTipoProcedimiento();
    }
    if (t === "3") {
      session.step = STEPS.OTRA_DUDA_MENU;
      return `¿En qué puedo ayudarte?\n\n1️⃣ Deseo contactarme\n2️⃣ Solicitar sobrecupo\n3️⃣ Cambiar horas\n4️⃣ Consultar perfil Dr. Sandoval`;
    }
    return msgMenuPrincipal();
  }

  // ── SEDE CONSULTA ────────────────────────────────────────
  if (session.step === STEPS.SEDE_CONSULTA) {
    if (t === "1") { session.step = STEPS.MENU_PRINCIPAL; return msgInfoClinicaAlemana(); }
    if (t === "2") { session.step = STEPS.MENU_PRINCIPAL; return msgInfoClinicaSantaMaria(); }
    if (t === "3") { session.step = STEPS.MENU_PRINCIPAL; return msgInfoGastroWeb(); }
    if (t === "4") { session.step = STEPS.MENU_PRINCIPAL; return msgMenuPrincipal(); }
    return msgSedeConsulta();
  }

  // ── TIPO PROCEDIMIENTO ───────────────────────────────────
  if (session.step === STEPS.TIPO_PROCEDIMIENTO) {
    const procedimientos = {
      "1": { nombre: "Endoscopía digestiva alta",                      key: "endoscopia" },
      "2": { nombre: "Colonoscopía completa",                           key: "colonoscopia" },
      "3": { nombre: "Colonoscopía larga + endoscopía digestiva alta",  key: "ambos" },
    };
    if (procedimientos[t]) {
      session.data.procedimiento = procedimientos[t].nombre;
      session.data.procedimientoKey = procedimientos[t].key;
      session.step = STEPS.TIENE_ORDEN;
      return msgTieneOrden();
    }
    if (t === "4") {
      session.step = STEPS.TIPO_PROCEDIMIENTO_OTROS;
      return msgOtrosProcedimientos();
    }
    return msgTipoProcedimiento();
  }

  // ── TIPO PROCEDIMIENTO OTROS ─────────────────────────────
  if (session.step === STEPS.TIPO_PROCEDIMIENTO_OTROS) {
    const otros = {
      "1": { nombre: "Polipectomía baja",     key: "polipectomia_baja"  },
      "2": { nombre: "Polipectomía alta",     key: "polipectomia_alta"  },
      "3": { nombre: "Colonoscopía corta",    key: "colonoscopia_corta" },
      "4": { nombre: "Ligadura de várices",   key: "ligadura_varices"   },
      "5": { nombre: "Terapia argón plasma",  key: "argon_plasma"       },
    };
    if (otros[t]) {
      session.data.procedimiento = otros[t].nombre;
      session.data.procedimientoKey = otros[t].key;
      session.step = STEPS.TIENE_ORDEN;
      return msgTieneOrden();
    }
    if (t === "6") {
      session.step = STEPS.TIPO_PROCEDIMIENTO;
      return msgTipoProcedimiento();
    }
    return msgOtrosProcedimientos();
  }

  // ── TIENE ORDEN ──────────────────────────────────────────
  if (session.step === STEPS.TIENE_ORDEN) {
    if (t === "1") {
      session.step = STEPS.NOMBRE;
      return "¿Cuál es tu *nombre completo*?";
    }
    if (t === "2") {
      session.step = STEPS.SIN_ORDEN_CONSULTA;
      return msgSinOrden();
    }
    return msgTieneOrden();
  }

  // ── SIN ORDEN ────────────────────────────────────────────
  if (session.step === STEPS.SIN_ORDEN_CONSULTA) {
    if (t === "1") { session.step = STEPS.MENU_PRINCIPAL; return msgInfoClinicaAlemana(); }
    if (t === "2") { session.step = STEPS.MENU_PRINCIPAL; return msgInfoClinicaSantaMaria(); }
    if (t === "3") { session.step = STEPS.MENU_PRINCIPAL; return msgInfoGastroWeb(); }
    if (t === "4") { session.step = STEPS.MENU_PRINCIPAL; return "Perfecto. Cuando tengas tu orden médica, escribe *menú* para comenzar de nuevo. ¡Que te mejores pronto! 🙏"; }
    return msgSinOrden();
  }

  // ── DATOS PERSONALES ─────────────────────────────────────
  if (session.step === STEPS.NOMBRE) {
    if (text.trim().length < 3) return "Por favor ingresa tu *nombre completo*.";
    session.data.nombre = text.trim();
    session.step = STEPS.EDAD;
    return "¿Cuál es tu *edad*?";
  }

  if (session.step === STEPS.EDAD) {
    const edad = parseInt(text.trim());
    if (isNaN(edad) || edad < 1 || edad > 120) return "Por favor ingresa tu *edad* en años (solo número).";
    session.data.edad = edad;
    session.step = STEPS.RUT;
    return "¿Cuál es tu *RUT*? (ej: 12.345.678-9)";
  }

  if (session.step === STEPS.RUT) {
    if (text.trim().length < 7) return "Por favor ingresa un *RUT válido*.";
    session.data.rut = text.trim();
    session.step = STEPS.TELEFONO;
    return "¿Cuál es tu *número de teléfono*?";
  }

  if (session.step === STEPS.TELEFONO) {
    const formateado = formatearTelefono(text.trim());
    if (!formateado) return "Por favor ingresa un *teléfono válido* (ej: 9 9783 0139).";
    session.data.telefonoTemp = formateado;
    session.step = STEPS.CONFIRMAR_TELEFONO;
    return `¿Tu número es *${formateado}*?\n\n1️⃣ Sí, es correcto\n2️⃣ No, corregir`;
  }

  if (session.step === STEPS.CONFIRMAR_TELEFONO) {
    if (t === "1") {
      session.data.telefono = session.data.telefonoTemp;
      session.step = STEPS.CORREO;
      return "¿Cuál es tu *correo electrónico*?";
    }
    if (t === "2") {
      session.step = STEPS.TELEFONO;
      return "Ingresa tu *número de teléfono* nuevamente:";
    }
    return `¿Tu número es *${session.data.telefonoTemp}*?\n\n1️⃣ Sí, es correcto\n2️⃣ No, corregir`;
  }

  if (session.step === STEPS.CORREO) {
    if (!text.includes("@") || !text.includes(".")) return "Por favor ingresa un *correo electrónico válido*.";
    session.data.correoTemp = text.trim().toLowerCase();
    session.step = STEPS.CONFIRMAR_CORREO;
    return `¿Tu correo es *${session.data.correoTemp}*?\n\n1️⃣ Sí, es correcto\n2️⃣ No, corregir`;
  }

  if (session.step === STEPS.CONFIRMAR_CORREO) {
    if (t === "1") {
      session.data.correo = session.data.correoTemp;
      session.step = STEPS.PREVISION;
      return `¿Cuál es tu *previsión*?\n\n1️⃣ Fonasa\n2️⃣ Isapre\n3️⃣ Particular`;
    }
    if (t === "2") {
      session.step = STEPS.CORREO;
      return "Ingresa tu *correo electrónico* nuevamente:";
    }
    return `¿Tu correo es *${session.data.correoTemp}*?\n\n1️⃣ Sí, es correcto\n2️⃣ No, corregir`;
  }

  // ── PREVISIÓN ────────────────────────────────────────────
  if (session.step === STEPS.PREVISION) {
    if (t === "1") { session.data.prevision = "Fonasa"; session.step = STEPS.LATEX; }
    else if (t === "2") { session.data.prevision = "Isapre"; session.step = STEPS.ISAPRE; }
    else if (t === "3") { session.data.prevision = "Particular"; session.step = STEPS.LATEX; }
    else return `¿Cuál es tu *previsión*?\n\n1️⃣ Fonasa\n2️⃣ Isapre\n3️⃣ Particular`;

    if (session.step === STEPS.ISAPRE) {
      return `Selecciona tu *Isapre*:

1️⃣ Banmédica
2️⃣ Colmena
3️⃣ Consalud
4️⃣ Cruz Blanca
5️⃣ Nueva Masvida
6️⃣ Vida Tres
7️⃣ Esencial
8️⃣ Fundación
9️⃣ Otra`;
    }
    return `¿Eres *alérgico al látex*?\n\n1️⃣ Sí\n2️⃣ No`;
  }

  // ── ISAPRE ───────────────────────────────────────────────
  if (session.step === STEPS.ISAPRE) {
    const isapres = { "1":"Banmédica","2":"Colmena","3":"Consalud","4":"Cruz Blanca","5":"Nueva Masvida","6":"Vida Tres","7":"Esencial","8":"Fundación","9":"Otra" };
    if (isapres[t]) {
      session.data.isapre = isapres[t];
      session.step = STEPS.LATEX;
      return `¿Eres *alérgico al látex*?\n\n1️⃣ Sí\n2️⃣ No`;
    }
    return `Selecciona tu Isapre (1-9):`;
  }

  // ── SEDE PROCEDIMIENTO ───────────────────────────────────
  if (session.step === STEPS.SEDE_PROCEDIMIENTO) {
    let sedes = SEDES_POR_PROCEDIMIENTO[session.data.procedimientoKey] || Object.keys(DISPONIBILIDAD_BASE);

    // Si tiene marcapasos, excluir Vitacura
    if (session.data.marcapasos === "Sí") {
      sedes = sedes.filter(s => s !== "vitacura");
    }

    const verTodosIdx = (sedes.length + 1).toString();

    if (t === verTodosIdx) {
      session.data.sede = "Cualquiera";
      session.data.sedeKey = "todas";
      session.data.sedesDisponibles = sedes;
      session.step = STEPS.FECHA;
      return msgTodasLasFechas(sedes);
    }

    const idx = parseInt(t) - 1;
    if (idx >= 0 && idx < sedes.length) {
      session.data.sedeKey = sedes[idx];
      session.data.sede = nombreSede(sedes[idx]);
      session.data.sedesDisponibles = [sedes[idx]];
      session.step = STEPS.FECHA;
      return await msgFechas(sedes[idx]);
    }

    return msgSedeProcedimiento(sedes);
  }

  // ── FECHA ────────────────────────────────────────────────
  if (session.step === STEPS.FECHA) {
    const sedeKey = session.data.sedeKey;
    const esTodasLasSedes = sedeKey === "todas";
    const sedes = session.data.sedesDisponibles || [sedeKey];

    if (esTodasLasSedes) {
      // Modo "ver todos los días" — lista completa de 30 días
      const fechas = todasLasFechas30Dias(sedes);
      const idx = parseInt(t) - 1;
      if (idx >= 0 && idx < fechas.length) {
        session.data.fechaPreferida = `${fechas[idx].label}`;
        session.data.sede = fechas[idx].sede;
      } else if (text.trim().length >= 8) {
        session.data.fechaPreferida = text.trim();
      } else {
        return msgTodasLasFechas(sedes);
      }
    } else {
      // Modo sede específica — próximas 4 fechas
      const fechas = proximosDias(DISPONIBILIDAD_BASE[sedeKey]?.dia || "lunes", 4);
      const otraIdx = "5";

      if (t === otraIdx) {
        session.data.fechaPreferida = "A coordinar";
      } else {
        const idx = parseInt(t) - 1;
        if (idx >= 0 && idx < fechas.length) {
          session.data.fechaPreferida = fechas[idx].label;
        } else if (text.trim().length >= 8) {
          session.data.fechaPreferida = text.trim();
        } else {
          return await msgFechas(sedeKey);
        }
      }
    }

    session.step = STEPS.ESPERANDO_ORDEN_FOTO;
    return `Por favor, envía una *foto clara de tu orden médica* 📷\n\n_La imagen se adjuntará a tu solicitud como respaldo._`;
  }
  if (session.step === STEPS.LATEX) {
    if (t === "1") { session.data.latex = "Sí"; session.step = STEPS.ANTICOAGULANTES; }
    else if (t === "2") { session.data.latex = "No"; session.step = STEPS.ANTICOAGULANTES; }
    else return `¿Eres *alérgico al látex*?\n\n1️⃣ Sí\n2️⃣ No`;
    return `¿Usas *anticoagulantes*?\n\n1️⃣ Sí\n2️⃣ No`;
  }

  if (session.step === STEPS.ANTICOAGULANTES) {
    if (t === "1") { session.data.anticoagulantes = "Sí"; session.step = STEPS.GLP1; }
    else if (t === "2") { session.data.anticoagulantes = "No"; session.step = STEPS.GLP1; }
    else return `¿Usas *anticoagulantes*?\n\n1️⃣ Sí\n2️⃣ No`;
    return `¿Usas medicamentos *GLP-1* (como Ozempic o Saxenda)?\n\n1️⃣ Sí\n2️⃣ No`;
  }

  if (session.step === STEPS.GLP1) {
    if (t === "1") { session.data.glp1 = "Sí"; session.step = STEPS.MARCAPASOS; }
    else if (t === "2") { session.data.glp1 = "No"; session.step = STEPS.MARCAPASOS; }
    else return `¿Usas medicamentos *GLP-1* (como Ozempic o Saxenda)?\n\n1️⃣ Sí\n2️⃣ No`;
    return `¿Tienes *marcapasos*?\n\n1️⃣ Sí\n2️⃣ No`;
  }

  if (session.step === STEPS.MARCAPASOS) {
    if (t === "1") { session.data.marcapasos = "Sí"; }
    else if (t === "2") { session.data.marcapasos = "No"; }
    else return `¿Tienes *marcapasos*?\n\n1️⃣ Sí\n2️⃣ No`;

    // Ahora sí podemos filtrar sedes con info de marcapasos
    session.step = STEPS.SEDE_PROCEDIMIENTO;
    let sedes = SEDES_POR_PROCEDIMIENTO[session.data.procedimientoKey] || Object.keys(DISPONIBILIDAD_BASE);
    if (session.data.marcapasos === "Sí") {
      sedes = sedes.filter(s => s !== "vitacura");
    }
    return msgSedeProcedimiento(sedes);
  }

  // ── OTRA DUDA - MENÚ ─────────────────────────────────────
  if (session.step === STEPS.OTRA_DUDA || session.step === STEPS.OTRA_DUDA_MENU) {
    if (t === "1") {
      session.step = STEPS.OTRA_DUDA_CONTACTO;
      return `¿Con cuál de estas instituciones deseas contactarte?\n\n1️⃣ Clínica Alemana Osorno\n2️⃣ Clínica Santa María\n3️⃣ gastroenterologos.cl\n4️⃣ Volver`;
    }
    if (t === "2") {
      session.step = STEPS.OTRA_DUDA_SOBRECUPO;
      return `Los sobrecupos se gestionan de la siguiente forma:\n\n🏥 *Clínica Santa María:* solo de forma *presencial* en la clínica.\n\n🌐 *gastroenterologos.cl (telemedicina):* escribe a 📧 info@gastroenterologos.cl solicitando el sobrecupo.\n\n¿Necesitas algo más? Escribe *menú* para volver al inicio.`;
    }
    if (t === "3") {
      session.step = STEPS.MENU_PRINCIPAL;
      return `Para *cambios de hora* o cancelaciones:\n\n🏥 *Clínica Alemana Osorno:* 📞 600 401 5007 o presencial.\n\n🏥 *Clínica Santa María:* 📞 +56 2 2913 0000, 💬 WhatsApp +56 2 2914 2472 o presencial.\n\n🌐 *gastroenterologos.cl:* 📧 info@gastroenterologos.cl\n\nEscribe *menú* para volver al inicio.`;
    }
    if (t === "4") {
      session.step = STEPS.MENU_PRINCIPAL;
      return `Aquí puedes revisar el perfil del *Dr. Cristián Sandoval Vergés*:\n\n🌐 https://gastroenterologos.cl/dr-cristian-sandoval-verges/\n\nEscribe *menú* si necesitas algo más.`;
    }
    // Si escribe texto libre, mostrar el menú
    session.step = STEPS.OTRA_DUDA_MENU;
    return `¿En qué puedo ayudarte?\n\n1️⃣ Deseo contactarme\n2️⃣ Solicitar sobrecupo\n3️⃣ Cambiar horas\n4️⃣ Consultar perfil Dr. Sandoval`;
  }

  // ── OTRA DUDA - CONTACTO ──────────────────────────────────
  if (session.step === STEPS.OTRA_DUDA_CONTACTO) {
    if (t === "1") {
      session.step = STEPS.MENU_PRINCIPAL;
      return `*Clínica Alemana Osorno* — canales de contacto:\n\n📞 Call center: 600 401 5007\n🌐 Web: https://www.clinicaalemanaosorno.cl/informacion-al-paciente/reserva-hora/\n\nEscribe *menú* para volver al inicio.`;
    }
    if (t === "2") {
      session.step = STEPS.MENU_PRINCIPAL;
      return `*Clínica Santa María* — canales de contacto:\n\n📞 Call center: +56 2 2913 0000\n💬 WhatsApp: +56 2 2914 2472\n🌐 Web: https://www.clinicasantamaria.cl/reserva-de-horas\n🏥 También puedes ir directamente de forma presencial\n\nEscribe *menú* para volver al inicio.`;
    }
    if (t === "3") {
      session.step = STEPS.MENU_PRINCIPAL;
      return `*gastroenterologos.cl* — canales de contacto:\n\n📧 info@gastroenterologos.cl\n🌐 https://gastroenterologos.cl/dr-cristian-sandoval-verges/\n\nEscribe *menú* para volver al inicio.`;
    }
    if (t === "4") {
      session.step = STEPS.OTRA_DUDA_MENU;
      return `¿En qué puedo ayudarte?\n\n1️⃣ Deseo contactarme\n2️⃣ Solicitar sobrecupo\n3️⃣ Cambiar horas\n4️⃣ Consultar perfil Dr. Sandoval`;
    }
    return `¿Con cuál institución deseas contactarte?\n\n1️⃣ Clínica Alemana Osorno\n2️⃣ Clínica Santa María\n3️⃣ gastroenterologos.cl\n4️⃣ Volver`;
  }

  // ── CONFIRMAR ENVÍO ───────────────────────────────────────
  if (session.step === STEPS.CONFIRMAR_ENVIO) {
    if (t === "1") {
      try {
        await sendSolicitudEmail(session);
        const correo = session.data.correo || "-";
        const nombre = session.data.nombre || "Paciente";
        resetSession(from);
        return await gptResponde(
          `El paciente ${nombre} acaba de enviar su solicitud correctamente. Su correo es ${correo}. Confirma el envío y despídete cálidamente.`,
          []
        ) || `✅ Tu solicitud fue enviada correctamente, ${nombre}.\n\nRecibirás una copia en *${correo}*.\n\nEl equipo humano se pondrá en contacto contigo para confirmar disponibilidad, presupuesto, preparación y agendamiento definitivo. 🙏`;
      } catch (err) {
        console.error("Error enviando email:", err.response?.data || err.message);
        return "⚠️ Hubo un problema al enviar tu solicitud. Por favor intenta nuevamente o escribe a contacto@gastroenterologos.cl directamente.";
      }
    }
    if (t === "2") {
      resetSession(from);
      return "Solicitud cancelada. Escribe *menú* si deseas comenzar de nuevo. 👋";
    }
    return msgResumenFinal(session.data);
  }

  // Fallback
  return msgMenuPrincipal();
}

// ============================================================
// WEBHOOK
// ============================================================
app.get("/", (req, res) => res.status(200).send("Bot Gastro activo ✅"));

app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  // Responder 200 INMEDIATAMENTE a Meta (evita reintentos)
  res.sendStatus(200);

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from    = message.from;
    const session = getSession(from);

    // ── IMAGEN ────────────────────────────────────────────
    if (message.type === "image") {
      if (session.step !== STEPS.ESPERANDO_ORDEN_FOTO) {
        await sendWhatsAppMessage(from, "He recibido una imagen, pero aún no corresponde enviar la orden médica en este paso.");
        return;
      }
      const media = await downloadWhatsAppMedia(message.image?.id);
      session.data.ordenMedicaBuffer   = media.buffer;
      session.data.ordenMedicaMimeType = media.mimeType;
      session.step = STEPS.CONFIRMAR_ENVIO;
      await sendWhatsAppMessage(from, msgResumenFinal(session.data));
      return;
    }

    // ── TEXTO ─────────────────────────────────────────────
    if (message.type !== "text") return;

    const text = message.text.body;
    const textClean = cleanText(text);

    // Detección de riesgo (salud mental)
    const friesgoArr = ["quiero morir", "me quiero matar", "no quiero seguir", "no puedo mas", "no puedo más"];
    if (friesgoArr.some(f => textClean.includes(f))) {
      await sendWhatsAppMessage(from,
        "Entiendo que estás pasando por un momento muy difícil. 💙\n\nPor favor comunícate de inmediato con el *Fono Salud Mental*: 600 360 7777 (disponible 24/7) o acude a la urgencia más cercana.\n\nEstás acompañado/a. 🙏"
      );
      return;
    }

    // Comando reset
    if (isResetCommand(textClean)) {
      resetSession(from);
      await sendWhatsAppMessage(from, msgMenuPrincipal());
      return;
    }

    // Guardar en historial para GPT
    session.history.push({ role: "user", content: text });

    const respuesta = await procesarMensaje(from, text, session);

    if (respuesta) {
      session.history.push({ role: "assistant", content: respuesta });
      await sendWhatsAppMessage(from, respuesta);
    }

  } catch (error) {
    console.error("Error webhook:", error.response?.data || error.message);
  }
});

// ============================================================
// INICIO
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
