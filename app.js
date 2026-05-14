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
const GOOGLE_SHEET_ID      = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY   = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
// ============================================================
// DEFINICIÓN DE STEPS
// ============================================================
const STEPS = {
  MENU_PRINCIPAL:        "menu_principal",
  SEDE_CONSULTA:         "sede_consulta",
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
  FECHA_SIGUIENTE:       "fecha_siguiente",
  OTRA_DUDA:             "otra_duda",
  OTRA_DUDA_MENU:        "otra_duda_menu",
  OTRA_DUDA_CONTACTO:    "otra_duda_contacto",
  OTRA_DUDA_SOBRECUPO:   "otra_duda_sobrecupo",
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
    sessions[from] = { step: STEPS.MENU_PRINCIPAL, data: {}, history: [] };
  }
  return sessions[from];
}
function resetSession(from) {
  sessions[from] = { step: STEPS.MENU_PRINCIPAL, data: {}, history: [] };
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
function formatearTelefono(raw) {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("56")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 9) return `+56 ${digits.slice(0,1)} ${digits.slice(1,5)} ${digits.slice(5)}`;
  if (digits.length === 8) return `+56 ${digits.slice(0,2)} ${digits.slice(2,6)} ${digits.slice(6)}`;
  return null;
}
function formatearRut(raw) {
  let clean = raw.replace(/[^0-9kK]/g, "").toUpperCase();
  if (clean.length < 2) return null;
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`;
}
function proximosDias(diaNombre, cantidad = 4, sedeKey = "los_dominicos") {
  const diasMap = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6 };
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
        label: `${nombresCapitalizados[fecha.getDay()]} ${d}/${m}/${y} ${etiquetaHorario(sedeKey)}`,
        fecha: `${d}/${m}/${y}`
      });
    }
  }
  return fechas;
}
function etiquetaHorario(sedeKey) {
  return sedeKey === "bellavista" ? "(p.m.)" : "(a.m.)";
}
function todasLasFechas30Dias(sedesKeys) {
  const diasMap = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6 };
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
          label: `${nombresCapitalizados[fecha.getDay()]} ${d}/${m}/${y} — ${nombreSede(sedeKey)} ${etiquetaHorario(sedeKey)}`,
          fecha: `${d}/${m}/${y}`,
          sede: nombreSede(sedeKey),
          sedeKey
        });
      }
    }
    fecha.setDate(fecha.getDate() + 1);
  }
  return resultados.sort((a, b) => {
    const [da, ma, ya] = a.fecha.split("/").map(Number);
    const [db, mb, yb] = b.fecha.split("/").map(Number);
    return new Date(ya, ma-1, da) - new Date(yb, mb-1, db);
  });
}
function nombreSede(key) {
  const nombres = { vitacura: "Vitacura", los_dominicos: "Los Dominicos", bellavista: "Bellavista" };
  return nombres[key] || key;
}
// ============================================================
// DEDUPLICACIÓN DE MENSAJES
// ============================================================
const mensajesProcesados = new Set();
const ultimoMensajePorUsuario = new Map();
function yaFueProcesado(messageId) {
  if (!messageId) return false;
  if (mensajesProcesados.has(messageId)) return true;
  mensajesProcesados.add(messageId);
  setTimeout(() => mensajesProcesados.delete(messageId), 5 * 60 * 1000);
  return false;
}
function esMensajeDuplicadoPorTiempo(from) {
  const ahora = Date.now();
  const ultimo = ultimoMensajePorUsuario.get(from) || 0;
  if (ahora - ultimo < 1500) {
    console.log(`⚠️ [${from}] Mensaje duplicado por tiempo ignorado`);
    return true;
  }
  ultimoMensajePorUsuario.set(from, ahora);
  return false;
}
// ============================================================
// GOOGLE SHEETS
// ============================================================
async function getDisponibilidadSheet() {
  if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) return null;
  try {
    const auth = new google.auth.JWT(GOOGLE_SERVICE_ACCOUNT_EMAIL, null, GOOGLE_PRIVATE_KEY, ["https://www.googleapis.com/auth/spreadsheets.readonly"]);
    const sheets = google.sheets({ version: "v4", auth });
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: "A:Z" });
    return response.data.values || [];
  } catch (err) {
    console.error("Error Google Sheets:", err.message);
    return null;
  }
}
// ============================================================
// GPT
// ============================================================
const SYSTEM_PROMPT = `Eres la secretaria virtual del Dr. Cristián Sandoval Vergés – Gastroenterólogo.
Tu función es responder con tono cálido, profesional, breve y claro, en español.
NO tomas decisiones de flujo. Solo redactas la respuesta al paciente según la instrucción que recibes.
NO inventes información médica, horarios ni fechas.
NO digas que agendas definitivamente. Siempre aclara que es una orientación/solicitud.
Responde siempre en máximo 3-4 líneas, sin listas largas innecesarias.`;
async function gptResponde(instruccion, historial = []) {
  try {
    const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...historial.slice(-6), { role: "user", content: instruccion }];
    const response = await axios.post("https://api.openai.com/v1/chat/completions", { model: "gpt-4o-mini", max_tokens: 300, temperature: 0.4, messages }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" } });
    return response.data.choices[0].message.content.trim();
  } catch (err) {
    console.error("Error GPT:", err.response?.data || err.message);
    return null;
  }
}
// ============================================================
// GMAIL
// ============================================================
function encodeSubject(subject) {
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}
function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function getGmailAccessToken() {
  const response = await axios.post("https://oauth2.googleapis.com/token", { client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET, refresh_token: GMAIL_REFRESH_TOKEN, grant_type: "refresh_token" });
  return response.data.access_token;
}
function buildEmailBody(data) {
  return `SOLICITUD DE PROCEDIMIENTO — DR. CRISTIÁN SANDOVAL VERGÉS


👤  DATOS DEL PACIENTE

  Nombre       : ${data.nombre     || "-"}
  Edad         : ${data.edad       ? `${data.edad} años` : "-"}
  RUT          : ${data.rut        || "-"}
  Teléfono     : ${data.telefono   || "-"}
  Correo       : ${data.correo     || "-"}
  Previsión    : ${data.prevision  || "-"}${data.isapre ? ` (${data.isapre})` : ""}


🔬  PROCEDIMIENTO SOLICITADO

  Procedimiento  : ${data.procedimiento  || "-"}
  Sede           : ${data.sede           || "-"}
  Fecha preferida: ${data.fechaPreferida || "-"}


🩺  ENCUESTA CLÍNICA

  Alérgico al látex    : ${data.latex           || "-"}
  Anticoagulantes      : ${data.anticoagulantes  || "-"}
  Análogos GLP-1       : ${data.glp1            || "-"}
  Marcapasos           : ${data.marcapasos      || "-"}


⚠️  IMPORTANTE

Esta solicitud NO constituye un agendamiento definitivo.

El equipo deberá contactar al paciente para confirmar:
  • Disponibilidad final
  • Presupuesto y aranceles
  • Indicaciones de preparación
  • Agendamiento definitivo

El paciente será contactado desde el área de presupuestos
a la brevedad para coordinar los detalles.`;
}
function buildRawEmail({ from, to, cc, bcc, subject, body, attachment }) {
  const boundary = `boundary_${Date.now()}`;
  const headers = [
    `From: Asistente Dr. Sandoval (No Reply) <${from}>`,
    `To: ${to}`,
    cc  ? `Cc: ${cc}`   : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean);
  const parts = [`--${boundary}\nContent-Type: text/plain; charset="UTF-8"\nContent-Transfer-Encoding: 7bit\n\n${body}`];
  if (attachment?.buffer) {
    parts.push(`--${boundary}\nContent-Type: ${attachment.mimeType || "image/jpeg"}; name="orden_medica.jpg"\nContent-Disposition: attachment; filename="orden_medica.jpg"\nContent-Transfer-Encoding: base64\n\n${attachment.buffer.toString("base64")}`);
  }
  parts.push(`--${boundary}--`);
  return base64Url(Buffer.from(headers.join("\n") + "\n\n" + parts.join("\n\n"), "utf8"));
}
const DESTINO_POR_SEDE = {
  vitacura:      "presupuesto.vitacura@clinicasantamaria.cl",
  los_dominicos: "presupuesto.losdominicos@clinicasantamaria.cl",
  bellavista:    "Agendamiento.examenes@clinicasantamaria.cl",
};
async function sendSolicitudEmail(session) {
  const accessToken = await getGmailAccessToken();
  const sedeKey = session.data.sedeKey || "los_dominicos";
  const destinoEmail = DESTINO_POR_SEDE[sedeKey] || "contacto@gastroenterologos.cl";
  const raw = buildRawEmail({
    from: GMAIL_USER,
    to: destinoEmail,
    cc: session.data.correo || undefined,
    bcc: "Cristian.Sandoval@gastroenterologos.cl",
    subject: `Solicitud procedimiento con Dr. Sandoval - ${session.data.procedimiento || "Procedimiento"} - ${session.data.nombre || "Paciente"}`,
    body: buildEmailBody(session.data),
    attachment: session.data.ordenMedicaBuffer ? { buffer: session.data.ordenMedicaBuffer, mimeType: session.data.ordenMedicaMimeType } : null,
  });
  await axios.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { raw }, { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } });
}
// ============================================================
// WHATSAPP - Enviar mensajes
// ============================================================
async function sendWhatsAppMessage(to, message) {
  await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, { messaging_product: "whatsapp", to, text: { body: message } }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } });
}
async function sendWhatsAppButtons(to, body, buttons, headerText = null) {
  const payload = {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: { buttons: buttons.map(b => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) }
    }
  };
  if (headerText) payload.interactive.header = { type: "text", text: headerText };
  await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, payload, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } });
}
async function sendWhatsAppList(to, body, items, buttonText = "Ver opciones", headerText = null) {
  const payload = {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: {
        button: buttonText.slice(0, 20),
        sections: [{ title: "Opciones", rows: items.map(item => ({ id: item.id, title: item.title.slice(0, 24), description: item.description ? item.description.slice(0, 72) : undefined })) }]
      }
    }
  };
  if (headerText) payload.interactive.header = { type: "text", text: headerText };
  await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, payload, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } });
}
// ============================================================
// DESCARGAR MEDIA
// ============================================================
async function downloadWhatsAppMedia(mediaId) {
  const mediaInfo = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const file = await axios.get(mediaInfo.data.url, { responseType: "arraybuffer", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  return { buffer: Buffer.from(file.data), mimeType: mediaInfo.data.mime_type || "image/jpeg" };
}
// ============================================================
// MENSAJES FIJOS
// ============================================================
function msgInfoClinicaAlemana() {
  return `Puedes agendar tu consulta presencial en *Clínica Alemana Osorno* por:\n\n📞 Call center: 600 401 5007\n🌐 Web: https://www.clinicaalemanaosorno.cl/informacion-al-paciente/reserva-hora/\n\n¿Necesitas algo más? Escribe *menú* para volver al inicio.`;
}
function msgInfoClinicaSantaMaria() {
  return `Puedes agendar tu consulta presencial en *Clínica Santa María* por:\n\n📞 Call center: +56 2 2913 0000\n💬 WhatsApp: +56 2 2914 2472\n🌐 Web: https://www.clinicasantamaria.cl/reserva-de-horas\n🏥 También puedes ir directamente de forma presencial\n\n¿Necesitas algo más? Escribe *menú* para volver al inicio.`;
}
function msgInfoGastroWeb() {
  return `Puedes agendar tu consulta de *telemedicina* (primera consulta o control) directamente en:\n\n🌐 https://gastroenterologos.cl/dr-cristian-sandoval-verges/\n\nEsta modalidad es externa a Clínica Santa María.\n\nSi no hay horas disponibles y necesitas un *sobrecupo*, escribe a:\n📧 info@gastroenterologos.cl\n\n¿Necesitas algo más? Escribe *menú* para volver al inicio.`;
}
// ============================================================
// FUNCIONES DE ENVÍO INTERACTIVO
// ============================================================
async function enviarMenuPrincipal(to) {
  await sendWhatsAppList(to,
    `👋 Hola, soy el asistente virtual del Dr. Cristián Sandoval Vergés – Gastroenterólogo.\n\nTe ayudaré a orientar tu solicitud. ¿Qué necesitas?`,
    [{ id: "1", title: "🏥 Consulta médica" }, { id: "2", title: "🔬 Procedimientos" }, { id: "3", title: "❓ Tengo otra duda" }],
    "Ver opciones"
  );
}
async function enviarSedeConsulta(to) {
  await sendWhatsAppList(to,
    "¿Prefieres agendar tu consulta en:",
    [
      { id: "1", title: "Clínica Alemana",    description: "Presencial - Osorno" },
      { id: "2", title: "Clínica Santa María", description: "Presencial - Santiago" },
      { id: "3", title: "Gastroenterologos.cl", description: "Telemedicina - Todo Chile" },
      { id: "4", title: "⬅️ Volver" },
    ],
    "Ver sedes"
  );
}
async function enviarTipoProcedimiento(to) {
  await sendWhatsAppList(to,
    `Te ayudaremos a encontrar una fecha disponible para iniciar tu solicitud de agendamiento.\n\nEsto no constituye un agendamiento definitivo.\n\n¿Qué procedimiento necesitas?`,
    [{ id: "1", title: "Endoscopía alta" }, { id: "2", title: "Colonoscopía" }, { id: "3", title: "Colonoscopía+Endoscopia" }, { id: "4", title: "Otros procedimientos" }],
    "Ver opciones",
    "Solicitud - Clínica Santa María"
  );
}
async function enviarOtrosProcedimientos(to) {
  await sendWhatsAppList(to,
    "Selecciona el procedimiento:",
    [{ id: "1", title: "Polipectomía baja" }, { id: "2", title: "Polipectomía alta" }, { id: "3", title: "Colonoscopía corta" }, { id: "4", title: "Ligadura de várices" }, { id: "5", title: "Argón plasma" }, { id: "6", title: "⬅️ Volver" }],
    "Ver opciones"
  );
}
async function enviarTieneOrden(to) {
  await sendWhatsAppButtons(to,
    `¿Tienes orden médica para el procedimiento?\n\nTe recomendamos tenerla a mano, ya que deberás fotografiarla más adelante.`,
    [{ id: "1", title: "✅ Sí" }, { id: "2", title: "❌ No" }]
  );
}
async function enviarSinOrden(to) {
  await sendWhatsAppList(to,
    "Para realizar este procedimiento necesitas primero una orden médica.\n\nDebes agendar una consulta médica para evaluación:",
    [
      { id: "1", title: "Clínica Alemana",    description: "Presencial - Osorno" },
      { id: "2", title: "Clínica Santa María", description: "Presencial - Santiago" },
      { id: "3", title: "Gastroenterologos.cl", description: "Telemedicina - Todo Chile" },
      { id: "4", title: "Agendaré después" },
    ],
    "Ver opciones"
  );
}
async function enviarLatex(to) {
  await sendWhatsAppButtons(to, "¿Eres alérgico al látex?", [{ id: "1", title: "✅ Sí" }, { id: "2", title: "❌ No" }]);
}
async function enviarAnticoagulantes(to) {
  await sendWhatsAppButtons(to, "¿Usas anticoagulantes?", [{ id: "1", title: "✅ Sí" }, { id: "2", title: "❌ No" }]);
}
async function enviarGlp1(to) {
  await sendWhatsAppButtons(to, "¿Usas análogos GLP-1?\n(Ozempic, Wegovy, Rybelsus, Victoza, Saxenda, Mounjaro, Trulicity, entre otros)", [{ id: "1", title: "✅ Sí" }, { id: "2", title: "❌ No" }]);
}
async function enviarMarcapasos(to) {
  await sendWhatsAppButtons(to, "¿Tienes marcapasos?", [{ id: "1", title: "✅ Sí" }, { id: "2", title: "❌ No" }]);
}
async function enviarSedeProcedimiento(to, sedes) {
  const items = sedes.map((s, i) => {
    const info = DISPONIBILIDAD_BASE[s];
    return { id: (i + 1).toString(), title: nombreSede(s), description: `${info.dia} ${info.horario}` };
  });
  items.push({ id: (sedes.length + 1).toString(), title: "📅 Ver todos", description: "Ver disponibilidad completa" });
  await sendWhatsAppList(to, "¿En qué sede prefieres el procedimiento?", items, "Ver sedes");
}
async function enviarFechas(to, sedeKey, offset = 0) {
  const info = DISPONIBILIDAD_BASE[sedeKey];
  const fechas = proximosDias(info.dia, 8, sedeKey);
  const pagina = fechas.slice(offset, offset + 4);
  const items = pagina.map((f, i) => {
    const partes = f.label.split(" ");
    return { id: (i + 1).toString(), title: `${partes[0]} ${partes[1]}`, description: partes[2] || "" };
  });
  if (offset + 4 < fechas.length) items.push({ id: "sig", title: "Ver más fechas ▶" });
  if (offset > 0) items.push({ id: "ant", title: "◀ Atrás" });
  await sendWhatsAppList(to, `Proximas fechas en ${nombreSede(sedeKey)}:`, items, "Ver fechas");
}
async function enviarTodasLasFechas(to, sedes) {
  const fechas = todasLasFechas30Dias(sedes);
  if (fechas.length === 0) { await sendWhatsAppMessage(to, "No hay fechas disponibles en los próximos 30 días."); return; }
  const items = fechas.slice(0, 10).map((f, i) => {
    const partes = f.label.split(" — ");
    return { id: (i + 1).toString(), title: partes[0] || f.label, description: partes[1] || "" };
  });
  await sendWhatsAppList(to, "Fechas disponibles en los proximos 30 días:", items, "Ver fechas");
}
async function enviarOtraDudaMenu(to) {
  await sendWhatsAppList(to, "¿En qué puedo ayudarte?",
    [{ id: "1", title: "📞 Contactarme" }, { id: "2", title: "📋 Sobrecupo" }, { id: "3", title: "🔄 Cambiar horas" }, { id: "4", title: "Perfil Dr. Sandoval", description: "gastroenterologos.cl" }],
    "Ver opciones"
  );
}
async function enviarOtraDudaContacto(to) {
  await sendWhatsAppList(to, "¿Con cuál institución deseas contactarte?",
    [{ id: "1", title: "Clínica Alemana" }, { id: "2", title: "Clínica Santa María" }, { id: "3", title: "Gastroenterologos.cl" }, { id: "4", title: "⬅️ Volver" }],
    "Ver opciones"
  );
}
async function enviarConfirmarEnvio(to, data) {
  const resumen = `📋 Resumen de tu solicitud:\n\n👤 Paciente: ${data.nombre || "-"}\n🎂 Edad: ${data.edad ? `${data.edad} años` : "-"}\n🪪 RUT: ${data.rut || "-"}\n📞 Teléfono: ${data.telefono || "-"}\n📧 Correo: ${data.correo || "-"}\n🏥 Previsión: ${data.prevision || "-"}${data.isapre ? ` (${data.isapre})` : ""}\n\n🔬 Procedimiento: ${data.procedimiento || "-"}\n📍 Sede: ${data.sede || "-"}\n📅 Fecha preferida: ${data.fechaPreferida || "-"}\n\n⚠️ Esta solicitud NO constituye un agendamiento definitivo.\n\nEl equipo humano se pondrá en contacto contigo a la brevedad para continuar y finalizar el agendamiento, donde se te entregará presupuesto, hora exacta e indicaciones para el examen.`;
  await sendWhatsAppButtons(to, resumen, [{ id: "1", title: "✅ Enviar" }, { id: "2", title: "❌ Cancelar" }]);
}
// ============================================================
// LÓGICA DE FLUJO PRINCIPAL
// ============================================================
async function procesarMensaje(from, text, session, message = null) {
  const t = cleanText(text);
  if (session.step === STEPS.MENU_PRINCIPAL) {
    if (t === "1") { session.step = STEPS.SEDE_CONSULTA; await enviarSedeConsulta(from); return null; }
    if (t === "2") { session.step = STEPS.TIPO_PROCEDIMIENTO; await enviarTipoProcedimiento(from); return null; }
    if (t === "3") { session.step = STEPS.OTRA_DUDA_MENU; await enviarOtraDudaMenu(from); return null; }
    await enviarMenuPrincipal(from); return null;
  }
  if (session.step === STEPS.SEDE_CONSULTA) {
    if (t === "1") { session.step = STEPS.MENU_PRINCIPAL; return msgInfoClinicaAlemana(); }
    if (t === "2") { session.step = STEPS.MENU_PRINCIPAL; return msgInfoClinicaSantaMaria(); }
    if (t === "3") { session.step = STEPS.MENU_PRINCIPAL; return msgInfoGastroWeb(); }
    if (t === "4") { session.step = STEPS.MENU_PRINCIPAL; await enviarMenuPrincipal(from); return null; }
    await enviarSedeConsulta(from); return null;
  }
  if (session.step === STEPS.TIPO_PROCEDIMIENTO) {
    const procedimientos = {
      "1": { nombre: "Endoscopía digestiva alta", key: "endoscopia" },
      "2": { nombre: "Colonoscopía completa", key: "colonoscopia" },
      "3": { nombre: "Colonoscopía larga + endoscopía alta", key: "ambos" },
    };
    if (procedimientos[t]) {
      session.data.procedimiento = procedimientos[t].nombre;
      session.data.procedimientoKey = procedimientos[t].key;
      session.step = STEPS.TIENE_ORDEN;
      await enviarTieneOrden(from); return null;
    }
    if (t === "4") { session.step = STEPS.TIPO_PROCEDIMIENTO_OTROS; await enviarOtrosProcedimientos(from); return null; }
    await enviarTipoProcedimiento(from); return null;
  }
  if (session.step === STEPS.TIPO_PROCEDIMIENTO_OTROS) {
    const otros = {
      "1": { nombre: "Polipectomía baja", key: "polipectomia_baja" },
      "2": { nombre: "Polipectomía alta", key: "polipectomia_alta" },
      "3": { nombre: "Colonoscopía corta", key: "colonoscopia_corta" },
      "4": { nombre: "Ligadura de várices", key: "ligadura_varices" },
      "5": { nombre: "Argón plasma", key: "argon_plasma" },
    };
    if (otros[t]) {
      session.data.procedimiento = otros[t].nombre;
      session.data.procedimientoKey = otros[t].key;
      session.step = STEPS.TIENE_ORDEN;
      await enviarTieneOrden(from); return null;
    }
    if (t === "6") { session.step = STEPS.TIPO_PROCEDIMIENTO; await enviarTipoProcedimiento(from); return null; }
    await enviarOtrosProcedimientos(from); return null;
  }
  if (session.step === STEPS.TIENE_ORDEN) {
    if (t === "1") { session.step = STEPS.NOMBRE; return "¿Cuál es tu *nombre completo*?"; }
    if (t === "2") { session.step = STEPS.SIN_ORDEN_CONSULTA; await enviarSinOrden(from); return null; }
    await enviarTieneOrden(from); return null;
  }
  if (session.step === STEPS.SIN_ORDEN_CONSULTA) {
    if (t === "1") { session.step = STEPS.MENU_PRINCIPAL; return msgInfoClinicaAlemana(); }
    if (t === "2") { session.step = STEPS.MENU_PRINCIPAL; return msgInfoClinicaSantaMaria(); }
    if (t === "3") { session.step = STEPS.MENU_PRINCIPAL; return msgInfoGastroWeb(); }
    if (t === "4") { session.step = STEPS.MENU_PRINCIPAL; return "Perfecto. Cuando tengas tu orden médica, escribe *menú* para comenzar de nuevo. 🙏"; }
    await enviarSinOrden(from); return null;
  }
  if (session.step === STEPS.NOMBRE) {
    if (message?.type === "interactive") return "¿Cuál es tu *nombre completo*?";
    if (text.trim().length < 3) return "Por favor ingresa tu *nombre completo*.";
    session.data.nombre = text.trim();
    session.step = STEPS.EDAD;
    return "¿Cuál es tu *edad*?";
  }
  if (session.step === STEPS.EDAD) {
    if (message?.type === "interactive") return "¿Cuál es tu *edad*?";
    const edad = parseInt(text.trim());
    if (isNaN(edad) || edad < 1 || edad > 120) return "Por favor ingresa tu *edad* en años (solo número).";
    session.data.edad = edad;
    session.step = STEPS.RUT;
    return "¿Cuál es tu *RUT*? (sin puntos, con guión: ej: 12345678-9)";
  }
  if (session.step === STEPS.RUT) {
    if (message?.type === "interactive") return "¿Cuál es tu *RUT*? (sin puntos, con guión: ej: 12345678-9)";
    const rutFormateado = formatearRut(text.trim());
    if (!rutFormateado || rutFormateado.length < 4) return "Por favor ingresa un *RUT válido* (ej: 123456789 o 12345678-9).";
    session.data.rut = rutFormateado;
    session.step = STEPS.TELEFONO;
    return "¿Cuál es tu *número de teléfono*?";
  }
  if (session.step === STEPS.TELEFONO) {
    const formateado = formatearTelefono(text.trim());
    if (!formateado) return "Por favor ingresa un *teléfono válido* (ej: 9 9783 0139).";
    session.data.telefonoTemp = formateado;
    session.step = STEPS.CONFIRMAR_TELEFONO;
    await sendWhatsAppButtons(from, `¿Tu número es *${formateado}*?`, [{ id: "1", title: "✅ Sí, correcto" }, { id: "2", title: "✏️ Corregir" }]);
    return null;
  }
  if (session.step === STEPS.CONFIRMAR_TELEFONO) {
    if (t === "1") { session.data.telefono = session.data.telefonoTemp; session.step = STEPS.CORREO; return "¿Cuál es tu *correo electrónico*?"; }
    if (t === "2") { session.step = STEPS.TELEFONO; return "Ingresa tu *número de teléfono* nuevamente:"; }
    await sendWhatsAppButtons(from, `¿Tu número es *${session.data.telefonoTemp}*?`, [{ id: "1", title: "✅ Sí, correcto" }, { id: "2", title: "✏️ Corregir" }]);
    return null;
  }
  if (session.step === STEPS.CORREO) {
    if (message?.type === "interactive") return "¿Cuál es tu *correo electrónico*?";
    if (!text.includes("@") || !text.includes(".")) return "Por favor ingresa un *correo electrónico válido*.";
    session.data.correoTemp = text.trim().toLowerCase();
    session.step = STEPS.CONFIRMAR_CORREO;
    await sendWhatsAppButtons(from, `¿Tu correo es *${session.data.correoTemp}*?`, [{ id: "1", title: "✅ Sí, correcto" }, { id: "2", title: "✏️ Corregir" }]);
    return null;
  }
  if (session.step === STEPS.CONFIRMAR_CORREO) {
    if (t === "1") {
      session.data.correo = session.data.correoTemp;
      session.step = STEPS.PREVISION;
      await sendWhatsAppList(from, "¿Cuál es tu previsión?", [{ id: "1", title: "Fonasa" }, { id: "2", title: "Isapre" }, { id: "3", title: "Particular" }], "Ver previsión");
      return null;
    }
    if (t === "2") { session.step = STEPS.CORREO; return "Ingresa tu *correo electrónico* nuevamente:"; }
    await sendWhatsAppButtons(from, `¿Tu correo es *${session.data.correoTemp}*?`, [{ id: "1", title: "✅ Sí, correcto" }, { id: "2", title: "✏️ Corregir" }]);
    return null;
  }
  if (session.step === STEPS.PREVISION) {
    if (t === "1") { session.data.prevision = "Fonasa"; session.step = STEPS.LATEX; }
    else if (t === "2") { session.data.prevision = "Isapre"; session.step = STEPS.ISAPRE; }
    else if (t === "3") { session.data.prevision = "Particular"; session.step = STEPS.LATEX; }
    else { await sendWhatsAppList(from, "¿Cuál es tu previsión?", [{ id: "1", title: "Fonasa" }, { id: "2", title: "Isapre" }, { id: "3", title: "Particular" }], "Ver previsión"); return null; }
    if (session.step === STEPS.ISAPRE) {
      await sendWhatsAppList(from, "Selecciona tu Isapre:",
        [{ id: "1", title: "Banmédica" }, { id: "2", title: "Colmena" }, { id: "3", title: "Consalud" }, { id: "4", title: "Cruz Blanca" }, { id: "5", title: "Nueva Masvida" }, { id: "6", title: "Vida Tres" }, { id: "7", title: "Esencial" }, { id: "8", title: "Fundación" }, { id: "9", title: "Otra" }],
        "Ver Isapres"
      );
      return null;
    }
    await enviarLatex(from); return null;
  }
  if (session.step === STEPS.ISAPRE) {
    const isapres = { "1":"Banmédica","2":"Colmena","3":"Consalud","4":"Cruz Blanca","5":"Nueva Masvida","6":"Vida Tres","7":"Esencial","8":"Fundación","9":"Otra" };
    if (isapres[t]) { session.data.isapre = isapres[t]; session.step = STEPS.LATEX; await enviarLatex(from); return null; }
    await sendWhatsAppList(from, "Selecciona tu Isapre:", [{ id: "1", title: "Banmédica" }, { id: "2", title: "Colmena" }, { id: "3", title: "Consalud" }, { id: "4", title: "Cruz Blanca" }, { id: "5", title: "Nueva Masvida" }, { id: "6", title: "Vida Tres" }, { id: "7", title: "Esencial" }, { id: "8", title: "Fundación" }, { id: "9", title: "Otra" }], "Ver Isapres");
    return null;
  }
  if (session.step === STEPS.LATEX) {
    if (t === "1") { session.data.latex = "Sí"; session.step = STEPS.ANTICOAGULANTES; await enviarAnticoagulantes(from); return null; }
    if (t === "2") { session.data.latex = "No"; session.step = STEPS.ANTICOAGULANTES; await enviarAnticoagulantes(from); return null; }
    await enviarLatex(from); return null;
  }
  if (session.step === STEPS.ANTICOAGULANTES) {
    if (t === "1") { session.data.anticoagulantes = "Sí"; session.step = STEPS.GLP1; await enviarGlp1(from); return null; }
    if (t === "2") { session.data.anticoagulantes = "No"; session.step = STEPS.GLP1; await enviarGlp1(from); return null; }
    await enviarAnticoagulantes(from); return null;
  }
  if (session.step === STEPS.GLP1) {
    if (t === "1") { session.data.glp1 = "Sí"; session.step = STEPS.MARCAPASOS; await enviarMarcapasos(from); return null; }
    if (t === "2") { session.data.glp1 = "No"; session.step = STEPS.MARCAPASOS; await enviarMarcapasos(from); return null; }
    await enviarGlp1(from); return null;
  }
  if (session.step === STEPS.MARCAPASOS) {
    if (t === "1") { session.data.marcapasos = "Sí"; }
    else if (t === "2") { session.data.marcapasos = "No"; }
    else { await enviarMarcapasos(from); return null; }
    session.step = STEPS.SEDE_PROCEDIMIENTO;
    let sedes = SEDES_POR_PROCEDIMIENTO[session.data.procedimientoKey] || Object.keys(DISPONIBILIDAD_BASE);
    if (session.data.marcapasos === "Sí") sedes = sedes.filter(s => s !== "vitacura");
    await enviarSedeProcedimiento(from, sedes); return null;
  }
  if (session.step === STEPS.SEDE_PROCEDIMIENTO) {
    let sedes = SEDES_POR_PROCEDIMIENTO[session.data.procedimientoKey] || Object.keys(DISPONIBILIDAD_BASE);
    if (session.data.marcapasos === "Sí") sedes = sedes.filter(s => s !== "vitacura");
    const verTodosIdx = (sedes.length + 1).toString();
    if (t === verTodosIdx) {
      session.data.sede = "Cualquiera"; session.data.sedeKey = "todas"; session.data.sedesDisponibles = sedes;
      session.step = STEPS.FECHA; await enviarTodasLasFechas(from, sedes); return null;
    }
    const idx = parseInt(t) - 1;
    if (idx >= 0 && idx < sedes.length) {
      session.data.sedeKey = sedes[idx]; session.data.sede = nombreSede(sedes[idx]); session.data.sedesDisponibles = [sedes[idx]];
      session.step = STEPS.FECHA; await enviarFechas(from, sedes[idx]); return null;
    }
    await enviarSedeProcedimiento(from, sedes); return null;
  }
  if (session.step === STEPS.FECHA || session.step === STEPS.FECHA_SIGUIENTE) {
    const sedeKey = session.data.sedeKey;
    const esTodasLasSedes = sedeKey === "todas";
    const sedes = session.data.sedesDisponibles || [sedeKey];
    const offset = session.data.fechaOffset || 0;
    if (t === "sig") { session.data.fechaOffset = offset + 4; session.step = STEPS.FECHA_SIGUIENTE; await enviarFechas(from, sedeKey, session.data.fechaOffset); return null; }
    if (t === "ant") { session.data.fechaOffset = Math.max(0, offset - 4); session.step = session.data.fechaOffset === 0 ? STEPS.FECHA : STEPS.FECHA_SIGUIENTE; await enviarFechas(from, sedeKey, session.data.fechaOffset); return null; }
    if (esTodasLasSedes) {
      const fechas = todasLasFechas30Dias(sedes);
      const idx = parseInt(t) - 1;
      if (idx >= 0 && idx < fechas.length) { session.data.fechaPreferida = fechas[idx].label; session.data.sede = fechas[idx].sede; session.data.sedeKey = fechas[idx].sedeKey; }
      else if (text.trim().length >= 8) { session.data.fechaPreferida = text.trim(); }
      else { await enviarTodasLasFechas(from, sedes); return null; }
    } else {
      const fechas = proximosDias(DISPONIBILIDAD_BASE[sedeKey]?.dia || "lunes", 8, sedeKey);
      const pagina = fechas.slice(offset, offset + 4);
      const idx = parseInt(t) - 1;
      if (idx >= 0 && idx < pagina.length) { session.data.fechaPreferida = pagina[idx].label; }
      else if (text.trim().length >= 8) { session.data.fechaPreferida = text.trim(); }
      else { await enviarFechas(from, sedeKey, offset); return null; }
    }
    session.data.fechaOffset = 0;
    session.step = STEPS.ESPERANDO_ORDEN_FOTO;
    return `Por favor, envía una *foto clara de tu orden médica* 📷\n\n_La imagen se adjuntará a tu solicitud como respaldo._`;
  }
  if (session.step === STEPS.OTRA_DUDA || session.step === STEPS.OTRA_DUDA_MENU) {
    if (t === "1") { session.step = STEPS.OTRA_DUDA_CONTACTO; await enviarOtraDudaContacto(from); return null; }
    if (t === "2") { session.step = STEPS.OTRA_DUDA_MENU; return `Los sobrecupos se gestionan de la siguiente forma:\n\n🏥 *Clínica Santa María:* solo de forma *presencial* en la clínica.\n\n🌐 *Gastroenterologos.cl:* escribe a 📧 info@gastroenterologos.cl\n\nEscribe *menú* para volver al inicio.`; }
    if (t === "3") { session.step = STEPS.OTRA_DUDA_MENU; return `Para *cambios de hora* o cancelaciones:\n\n🏥 *Clínica Alemana Osorno:* 📞 600 401 5007 o presencial.\n\n🏥 *Clínica Santa María:* 📞 +56 2 2913 0000, 💬 WhatsApp +56 2 2914 2472 o presencial.\n\n🌐 *Gastroenterologos.cl:* 📧 info@gastroenterologos.cl\n\nEscribe *menú* para volver al inicio.`; }
    if (t === "4") { session.step = STEPS.OTRA_DUDA_MENU; return `Aquí puedes revisar el perfil del *Dr. Cristián Sandoval Vergés*:\n\n🌐 https://gastroenterologos.cl/dr-cristian-sandoval-verges/\n\nEscribe *menú* si necesitas algo más.`; }
    await enviarOtraDudaMenu(from); return null;
  }
  if (session.step === STEPS.OTRA_DUDA_CONTACTO) {
    if (t === "1") { session.step = STEPS.MENU_PRINCIPAL; return msgInfoClinicaAlemana(); }
    if (t === "2") { session.step = STEPS.MENU_PRINCIPAL; return msgInfoClinicaSantaMaria(); }
    if (t === "3") { session.step = STEPS.MENU_PRINCIPAL; return `*Gastroenterologos.cl* — canales de contacto:\n\n📧 info@gastroenterologos.cl\n🌐 https://gastroenterologos.cl/dr-cristian-sandoval-verges/\n\nEscribe *menú* para volver al inicio.`; }
    if (t === "4") { session.step = STEPS.OTRA_DUDA_MENU; await enviarOtraDudaMenu(from); return null; }
    await enviarOtraDudaContacto(from); return null;
  }
  if (session.step === STEPS.CONFIRMAR_ENVIO) {
    if (t === "1") {
      try {
        await sendSolicitudEmail(session);
        console.log(`📧 [${from}] Solicitud enviada | Paciente: ${session.data.nombre} | Sede: ${session.data.sede}`);
        const nombre = session.data.nombre?.split(" ")[0] || "Paciente";
        resetSession(from);
        return `Estimado/a ${nombre}, hemos recibido tu solicitud correctamente.\n\nEl equipo de Clínica Santa María se pondrá en contacto contigo a la brevedad para continuar y finalizar el agendamiento, donde se te entregará presupuesto, hora exacta e indicaciones para el examen.\n\nAgradecemos tu confianza con el Dr. Sandoval. ¡Que tengas un excelente día!\n\n_Fin de la asistencia._`;
      } catch (err) {
        console.error("Error enviando email:", err.response?.data || err.message);
        return "⚠️ Hubo un problema al enviar tu solicitud. Por favor intenta nuevamente o escribe a contacto@gastroenterologos.cl directamente.";
      }
    }
    if (t === "2") { resetSession(from); return "Solicitud cancelada. Escribe *menú* si deseas comenzar de nuevo. 👋"; }
    await enviarConfirmarEnvio(from, session.data); return null;
  }
  // Fallback inteligente
  console.log(`⚠️ [${from}] Fallback en step: ${session.step} | t: "${t}"`);
  switch (session.step) {
    case STEPS.MENU_PRINCIPAL:       await enviarMenuPrincipal(from); break;
    case STEPS.SEDE_CONSULTA:        await enviarSedeConsulta(from); break;
    case STEPS.TIPO_PROCEDIMIENTO:   await enviarTipoProcedimiento(from); break;
    case STEPS.TIPO_PROCEDIMIENTO_OTROS: await enviarOtrosProcedimientos(from); break;
    case STEPS.TIENE_ORDEN:          await enviarTieneOrden(from); break;
    case STEPS.SIN_ORDEN_CONSULTA:   await enviarSinOrden(from); break;
    case STEPS.NOMBRE:               return "¿Cuál es tu *nombre completo*?";
    case STEPS.EDAD:                 return "¿Cuál es tu *edad*?";
    case STEPS.RUT:                  return "¿Cuál es tu *RUT*? (sin puntos, con guión: ej: 12345678-9)";
    case STEPS.TELEFONO:             return "¿Cuál es tu *número de teléfono*?";
    case STEPS.CONFIRMAR_TELEFONO:   await sendWhatsAppButtons(from, `¿Tu número es *${session.data.telefonoTemp}*?`, [{ id: "1", title: "✅ Sí, correcto" }, { id: "2", title: "✏️ Corregir" }]); break;
    case STEPS.CORREO:               return "¿Cuál es tu *correo electrónico*?";
    case STEPS.CONFIRMAR_CORREO:     await sendWhatsAppButtons(from, `¿Tu correo es *${session.data.correoTemp}*?`, [{ id: "1", title: "✅ Sí, correcto" }, { id: "2", title: "✏️ Corregir" }]); break;
    case STEPS.PREVISION:            await sendWhatsAppList(from, "¿Cuál es tu previsión?", [{ id: "1", title: "Fonasa" }, { id: "2", title: "Isapre" }, { id: "3", title: "Particular" }], "Ver previsión"); break;
    case STEPS.ISAPRE:               await sendWhatsAppList(from, "Selecciona tu Isapre:", [{ id: "1", title: "Banmédica" }, { id: "2", title: "Colmena" }, { id: "3", title: "Consalud" }, { id: "4", title: "Cruz Blanca" }, { id: "5", title: "Nueva Masvida" }, { id: "6", title: "Vida Tres" }, { id: "7", title: "Esencial" }, { id: "8", title: "Fundación" }, { id: "9", title: "Otra" }], "Ver Isapres"); break;
    case STEPS.LATEX:                await enviarLatex(from); break;
    case STEPS.ANTICOAGULANTES:      await enviarAnticoagulantes(from); break;
    case STEPS.GLP1:                 await enviarGlp1(from); break;
    case STEPS.MARCAPASOS:           await enviarMarcapasos(from); break;
    case STEPS.SEDE_PROCEDIMIENTO: {
      let sedes = SEDES_POR_PROCEDIMIENTO[session.data.procedimientoKey] || Object.keys(DISPONIBILIDAD_BASE);
      if (session.data.marcapasos === "Sí") sedes = sedes.filter(s => s !== "vitacura");
      await enviarSedeProcedimiento(from, sedes); break;
    }
    case STEPS.FECHA:
    case STEPS.FECHA_SIGUIENTE:
      if (session.data.sedeKey === "todas") await enviarTodasLasFechas(from, session.data.sedesDisponibles);
      else await enviarFechas(from, session.data.sedeKey, session.data.fechaOffset || 0);
      break;
    case STEPS.ESPERANDO_ORDEN_FOTO: return `Por favor, envía una *foto clara de tu orden médica* 📷\n\n_La imagen se adjuntará a tu solicitud como respaldo._`;
    case STEPS.CONFIRMAR_ENVIO:      await enviarConfirmarEnvio(from, session.data); break;
    case STEPS.OTRA_DUDA_MENU:
    case STEPS.OTRA_DUDA:            await enviarOtraDudaMenu(from); break;
    case STEPS.OTRA_DUDA_CONTACTO:   await enviarOtraDudaContacto(from); break;
    default:                         await enviarMenuPrincipal(from); break;
  }
  return null;
}
// ============================================================
// WEBHOOK
// ============================================================
app.get("/", (req, res) => res.status(200).send("Bot Gastro activo ✅"));
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"], token = req.query["hub.verify_token"], challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;
    const from = message.from;
    const session = getSession(from);
    if (yaFueProcesado(message.id)) { console.log(`⚠️ [${from}] Duplicado ID ignorado`); return; }
    if (message.type === "interactive" && esMensajeDuplicadoPorTiempo(from)) return;
    if (message.type === "image") {
      console.log(`📷 [${from}] Imagen | Step: ${session.step}`);
      if (session.step !== STEPS.ESPERANDO_ORDEN_FOTO) { await sendWhatsAppMessage(from, "He recibido una imagen, pero aún no corresponde enviar la orden médica en este paso."); return; }
      const media = await downloadWhatsAppMedia(message.image?.id);
      session.data.ordenMedicaBuffer = media.buffer;
      session.data.ordenMedicaMimeType = media.mimeType;
      session.step = STEPS.CONFIRMAR_ENVIO;
      await enviarConfirmarEnvio(from, session.data);
      return;
    }
    if (message.type !== "text" && message.type !== "interactive") return;
    let text, textClean;
    if (message.type === "interactive") {
      const interactive = message.interactive;
      console.log(`🔍 [${from}] Interactive: ${interactive.type} | ${JSON.stringify(interactive).slice(0, 100)}`);
      if (interactive.type === "button_reply") text = interactive.button_reply.id;
      else if (interactive.type === "list_reply") text = interactive.list_reply.id;
      else return;
      textClean = text.trim().toLowerCase();
    } else {
      text = message.text.body;
      textClean = cleanText(text);
    }
    console.log(`📩 [${from}] Step: ${session.step} | Msg: "${text.slice(0, 50)}"`);
    const friesgoArr = ["quiero morir", "me quiero matar", "no quiero seguir", "no puedo mas", "no puedo más"];
    if (friesgoArr.some(f => textClean.includes(f))) {
      await sendWhatsAppMessage(from, "Entiendo que estás pasando por un momento muy difícil. 💙\n\nPor favor comunícate de inmediato con el *Fono Salud Mental*: 600 360 7777 (disponible 24/7) o acude a la urgencia más cercana.\n\nEstás acompañado/a. 🙏");
      return;
    }
    if (isResetCommand(textClean)) { console.log(`🔄 [${from}] Reset`); resetSession(from); await enviarMenuPrincipal(from); return; }
    session.history.push({ role: "user", content: text });
    const respuesta = await procesarMensaje(from, text, session, message);
    if (respuesta) { console.log(`✅ [${from}] Texto enviado | Step: ${session.step}`); session.history.push({ role: "assistant", content: respuesta }); await sendWhatsAppMessage(from, respuesta); }
    else { console.log(`✅ [${from}] Interactivo enviado | Step: ${session.step}`); }
  } catch (error) {
    console.error(`❌ Error:`, error.response?.data || error.message);
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
