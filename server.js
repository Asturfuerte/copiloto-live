// Copiloto Live: puente WebSocket entre el navegador y Gemini Live.
// Sin dependencias: HTTP + WebSocket (RFC 6455) implementados a mano.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');

const VERSION = '2026-10-30b'; // se cambia en cada entrega para comprobar en /salud qué versión está desplegada
const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const ACCESS_PIN = process.env.ACCESS_PIN || '';
const LIVE_MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live';
const LIVE_VOICE = process.env.LIVE_VOICE || 'Aoede';
const ENABLE_SEARCH = (process.env.ENABLE_SEARCH || '1') !== '0';
const AGENT_NAME = process.env.AGENT_NAME || 'Claude';
const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || path.join(__dirname, 'conocimiento');

// Modo híbrido: si hay ANTHROPIC_API_KEY, Gemini oye y habla, y Claude piensa, busca en internet y lee documentos.
const claude = require('./claude');
console.log('Copiloto Live versión ' + VERSION);
if (claude.enabled()) console.log('Cerebro Claude activo (' + claude.MODEL + '): búsquedas y documentos los resuelve Claude');
else console.log('Cerebro Claude DESACTIVADO: falta la variable ANTHROPIC_API_KEY (todo lo resuelve Gemini)');

const INDEX = Buffer.from(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').split('__AGENT_NAME__').join(AGENT_NAME.replace(/[<>&"]/g, '')));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

// Conocimiento: todos los .md/.txt de la carpeta se añaden a las instrucciones del sistema.
function loadKnowledge() {
  try {
    const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => /\.(md|txt)$/i.test(f)).sort();
    const docs = files.map(f => fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf8').trim()).filter(Boolean);
    if (docs.length) console.log('Conocimiento cargado: ' + files.join(', '));
    return docs.join('\n\n');
  } catch (e) { return ''; }
}
const KNOWLEDGE = loadKnowledge();

// Documentos: carpeta con md/txt/pdf/docx que se indexa al arrancar y se consulta con la función consultar_documentos.
// DOCS_DIR puede ser un volumen persistente (p. ej. /data/documentos); si está vacío se siembra con los documentos del repo.
const BUNDLED_DOCS = path.join(__dirname, 'documentos');
const DOCS_DIR = process.env.DOCS_DIR || BUNDLED_DOCS;
const DOCS_EXT = /\.(md|txt|pdf|docx)$/i;
const DOCS_MAX_BYTES = 50 * 1024 * 1024;
try {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  if (path.resolve(DOCS_DIR) !== path.resolve(BUNDLED_DOCS) && !fs.readdirSync(DOCS_DIR).some(f => DOCS_EXT.test(f)) && fs.existsSync(BUNDLED_DOCS)) {
    for (const f of fs.readdirSync(BUNDLED_DOCS)) if (DOCS_EXT.test(f)) fs.copyFileSync(path.join(BUNDLED_DOCS, f), path.join(DOCS_DIR, f));
    console.log('Documentos iniciales copiados a ' + DOCS_DIR);
  }
} catch (e) { console.log('No se pudo preparar la carpeta de documentos: ' + e.message); }
const documentos = require('./documentos');
let DOCS = documentos.buildIndex(DOCS_DIR);
// Embeddings en segundo plano (búsqueda semántica); hasta que estén, se busca solo por palabras clave.
function embedDocs(idx) { documentos.ensureEmbeddings(idx, DOCS_DIR, GEMINI_KEY, console.log).catch(e => console.log('Embeddings no disponibles: ' + e.message)); }
embedDocs(DOCS);
function reindexDocs() { DOCS = documentos.buildIndex(DOCS_DIR); embedDocs(DOCS); return DOCS; }
// Cola de OCR en segundo plano (uno a la vez). OCR_PENDING: fichero -> { pagina, total, error }.
const OCR_PENDING = new Map();
let ocrChain = Promise.resolve();
function queueOcr(file) {
  if (OCR_PENDING.has(file)) return;
  OCR_PENDING.set(file, { pagina: 0, total: 0, error: null });
  ocrChain = ocrChain.then(async () => {
    const full = path.join(DOCS_DIR, file);
    try {
      if (!fs.existsSync(full)) return;
      await documentos.ensureOcr(full, (i, n) => { const p = OCR_PENDING.get(file); if (p) { p.pagina = i; p.total = n; } if (i === 1 || i % 10 === 0 || i === n) console.log('OCR ' + file + ': página ' + i + '/' + n); });
      OCR_PENDING.delete(file);
      reindexDocs();
    } catch (e) {
      console.log('OCR falló para ' + file + ': ' + e.message);
      const p = OCR_PENDING.get(file); if (p) p.error = e.message.slice(0, 120);
      setTimeout(() => OCR_PENDING.delete(file), 10 * 60 * 1000); // el error se muestra un rato y luego desaparece
    }
  });
}
// Al arrancar, OCR de los PDF escaneados que aún no lo tengan (p. ej. copiados a mano a la carpeta).
try { for (const f of fs.readdirSync(DOCS_DIR)) if (/\.pdf$/i.test(f) && documentos.pdfNeedsOcr(path.join(DOCS_DIR, f))) queueOcr(f); } catch (e) {}
function docsTool() {
  return {
    functionDeclarations: [{
      name: 'consultar_documentos',
      description: 'Busca en los documentos del cliente (contratos, expedientes, sentencias, informes, catálogos) y devuelve los fragmentos más relevantes. Úsala siempre que te pregunten por el contenido de un documento, un expediente, un contrato, una cláusula, una fecha o una cifra que pueda estar en ellos. Documentos disponibles: ' + (DOCS.docs.map(d => d.name).join('; ') || 'ninguno') + '.',
      parameters: {
        type: 'OBJECT',
        properties: {
          pregunta: { type: 'STRING', description: 'Qué quieres encontrar DENTRO del documento: el concepto, cláusula, dato o pregunta concreta (p. ej. "sentencias anteriores citadas sobre subsanación", "renta mensual y preaviso"). No repitas aquí el nombre del documento.' },
          documento: { type: 'STRING', description: 'Opcional: nombre (o parte) del documento donde buscar, si se sabe (p. ej. "STS Unión Ereza", "escritura constitución").' },
        },
        required: ['pregunta'],
      },
    }, {
      name: 'leer_documento',
      description: 'Devuelve el texto COMPLETO de un documento, por partes. Úsala cuando la pregunta exija ver todo el documento y no un fragmento: listar todas las fechas, periodos, empresas, cláusulas o importes; contar; resumir; comparar partes alejadas. Si tiene varias partes, pide las siguientes hasta tener lo que necesitas. Documentos disponibles: ' + (DOCS.docs.map(d => d.name).join('; ') || 'ninguno') + '.',
      parameters: {
        type: 'OBJECT',
        properties: {
          documento: { type: 'STRING', description: 'Nombre (o parte) del documento a leer.' },
          parte: { type: 'INTEGER', description: 'Número de parte (empieza en 1).' },
        },
        required: ['documento'],
      },
    }],
  };
}
function docsRules() {
  return DOCS.docs.length ? `

=== DOCUMENTOS ===
Tienes dos funciones: consultar_documentos (busca fragmentos; para preguntas concretas: un dato, una cláusula, una cifra) y leer_documento (devuelve el documento entero por partes; para listar todo, contar, resumir o cuando la búsqueda no da lo que pides). Documentos cargados: ${DOCS.docs.map(d => d.name).join('; ')}.
Cuando te pregunten algo que pueda estar en esos documentos, llama a la función ANTES de responder y contesta solo con lo que devuelva, citando el documento. En "pregunta" pon solo lo que buscas dentro del texto (concepto, dato, cláusula), con términos concretos; el nombre del documento va aparte en "documento". Si no encuentras lo que buscas, prueba una segunda vez con otras palabras. Si la pregunta tiene varias partes, responde las que sí hayas encontrado y di cuál no. Nunca inventes cláusulas, cifras ni fechas.
` : '';
}
function safeDocName(raw) {
  let n = ''; try { n = decodeURIComponent(raw); } catch (e) { return ''; }
  n = path.basename(n).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  if (!n || n.startsWith('.') || n.length > 150 || !DOCS_EXT.test(n)) return '';
  return n;
}
function docsList() {
  const list = DOCS.docs.map(d => { let st = {}; try { st = fs.statSync(path.join(DOCS_DIR, d.file)); } catch (e) {} return { nombre: d.name, fichero: d.file, fragmentos: d.chunks, bytes: st.size || 0, fecha: st.mtime || null, ocr: fs.existsSync(path.join(DOCS_DIR, d.file + documentos.OCR_SIDECAR)) }; });
  for (const [file, p] of OCR_PENDING) {
    let st = {}; try { st = fs.statSync(path.join(DOCS_DIR, file)); } catch (e) {}
    list.push({ nombre: file.replace(DOCS_EXT, ''), fichero: file, fragmentos: 0, bytes: st.size || 0, fecha: st.mtime || null, ocr: true, procesando: !p.error, progreso: p.total ? p.pagina + '/' + p.total : 'preparando', error: p.error });
  }
  return list;
}

const KNOWLEDGE_RULES = `

=== CONOCIMIENTO PROPIO ===
Lo que sigue es información fiable que te han dado para esta sesión. Cuando te pregunten algo que esté aquí, responde con estos datos sin buscar en internet. Si piden una hora concreta (por ejemplo "la próxima guagua"), di las dos o tres salidas más cercanas a la hora que te digan, y pregunta la hora si no la sabes. Si algo no está aquí, dilo y, si procede, búscalo.

`;

const PERSONA = {
  participante: `Eres "${AGENT_NAME}", una persona más en una conversación informal en español de España. Escuchas en directo a varias personas.
Habla SOLO cuando aporte: si alguien dice algo falso o inexacto, corrígelo con naturalidad y educación; si te preguntan o te nombran ("${AGENT_NAME}"), responde; de vez en cuando puedes añadir un dato breve o una pregunta que encaje. Si no hay nada que decir, responde con un silencio absoluto: no digas ni una palabra, ni saludos ni muletillas.
Cuando intervengas por tu cuenta (para corregir o aportar un dato), frases cortas: máximo veinticinco palabras.
Cuando te pregunten directamente o te pidan información, responde completo: da la respuesta entera con los datos necesarios, aunque ocupe varias frases, sin cortarte a medias. Aun así, ve al grano y sin relleno.
Tono cercano, sin listas ni enumeraciones, como quien habla en una mesa. Si no estás seguro de un dato, dilo o búscalo antes de afirmarlo. Nunca repitas lo que ya dijiste.
PRESENTACIONES: cuando te presenten a alguien o te digan el nombre de la persona que está en la reunión ("te presento a…", "está con nosotros…", "esta es…", "se llama…"), salúdala en ese momento por su nombre, de usted, y di que esperas poder ayudar a resolver todas las dudas (por ejemplo: "Hola, Juan, encantada. Espero poder ayudarle a resolver todas las dudas que tenga."). Hazlo una sola vez por persona y luego sigue con tu comportamiento normal, usando su nombre con naturalidad y tratándola de usted cuando intervenga.`,
  copiloto: `Eres "${AGENT_NAME}", un acompañante discreto en una reunión en español de España. Escuchas en directo.
Habla ÚNICAMENTE si alguien afirma algo claramente falso o inexacto, o si te preguntan o te nombran ("${AGENT_NAME}"). En cualquier otro caso responde con silencio absoluto: ni una palabra, ni saludos ni muletillas.
Cuando corrijas por tu cuenta, sé breve (máximo veinte palabras), educado y concreto, y cita el dato correcto.
Cuando te pregunten directamente o te pidan información, responde completo: da la respuesta entera con los datos necesarios, aunque ocupe varias frases, sin cortarte a medias. Aun así, ve al grano y sin relleno.
Si no estás seguro de un dato, búscalo antes. Nunca repitas lo que ya dijiste.
EXCEPCIÓN — PRESENTACIONES: cuando te presenten a alguien o te digan el nombre de la persona que está en la reunión ("te presento a…", "está con nosotros…", "esta es…", "se llama…"), rompe el silencio solo para saludarla por su nombre, de usted, y decir que esperas poder ayudar a resolver todas las dudas (por ejemplo: "Hola, Juan, encantada. Espero poder ayudarle a resolver todas las dudas que tenga."). Hazlo una sola vez por persona y vuelve inmediatamente al silencio habitual, tratándola de usted cuando intervenga.`,
};

// ---------- WebSocket servidor (navegador <-> nosotros) ----------
function acceptKey(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}
function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
function sendText(sock, obj) { try { sock.write(frame(0x1, Buffer.from(JSON.stringify(obj)))); } catch (e) {} }
function sendBin(sock, buf) { try { sock.write(frame(0x2, buf)); } catch (e) {} }

// Parser de frames entrantes (del navegador, siempre enmascarados)
function makeParser(onMessage, onClose) {
  let buf = Buffer.alloc(0);
  let frag = []; let fragOp = 0;
  return chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0; const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0; let len = buf[1] & 0x7f; let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.slice(off + maskLen, off + maskLen + len);
      if (masked) { const m = buf.slice(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      buf = buf.slice(off + maskLen + len);
      if (op === 0x8) { onClose(); return; }
      if (op === 0x9) { continue; } // ping del navegador: ignorar (raro)
      if (op === 0xA) continue;
      if (op === 0x0) { frag.push(payload); if (fin) { onMessage(fragOp, Buffer.concat(frag)); frag = []; } continue; }
      if (!fin) { fragOp = op; frag = [payload]; continue; }
      onMessage(op, payload);
    }
  };
}

// ---------- WebSocket cliente (nosotros <-> Gemini) ----------
function connectGemini(onOpen, onMessage, onClose) {
  const host = 'generativelanguage.googleapis.com';
  const pathq = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' + encodeURIComponent(GEMINI_KEY);
  const key = crypto.randomBytes(16).toString('base64');
  const sock = tls.connect({ host, port: 443, servername: host });
  let opened = false; let buf = Buffer.alloc(0); let frag = []; let fragOp = 0;
  sock.on('secureConnect', () => {
    sock.write(`GET ${pathq} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (!opened) {
      const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
      const head = buf.slice(0, i).toString();
      buf = buf.slice(i + 4);
      if (!/ 101 /.test(head.split('\r\n')[0])) { onClose('Gemini rechazó la conexión: ' + head.split('\r\n')[0]); sock.destroy(); return; }
      opened = true; onOpen();
    }
    while (true) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0; const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f; let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len); buf = buf.slice(off + len);
      if (op === 0x8) { onClose('Gemini cerró la sesión'); return; }
      if (op === 0x9) { try { sock.write(maskFrame(0xA, payload)); } catch (e) {} continue; }
      if (op === 0xA) continue;
      if (op === 0x0) { frag.push(payload); if (fin) { onMessage(Buffer.concat(frag)); frag = []; } continue; }
      if (!fin) { fragOp = op; frag = [payload]; continue; }
      onMessage(payload);
    }
  });
  sock.on('error', e => onClose('Error con Gemini: ' + e.message));
  sock.on('close', () => onClose('Conexión con Gemini cerrada'));
  return {
    send: obj => { try { sock.write(maskFrame(0x1, Buffer.from(JSON.stringify(obj)))); } catch (e) {} },
    close: () => { try { sock.write(maskFrame(0x8, Buffer.alloc(0))); sock.end(); } catch (e) {} },
  };
}
function maskFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const data = Buffer.from(payload); for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
  const len = data.length; let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, mask, data]);
}

// Trato y saludo según la hora (Canarias): se calcula al abrir cada sesión.
function tratoRules() {
  const n = require('./recordatorios').ahora();
  const h = parseInt(n.hm.slice(0, 2), 10);
  const franja = h < 7 ? 'madrugada' : h < 12 ? 'mañana' : h < 15 ? 'mediodía' : h < 21 ? 'tarde' : 'noche';
  return `

=== TRATO ===
Tutea SIEMPRE a Alfredo, tu usuario: háblale de "tú", nunca de usted.
En cambio, a las personas que te presenten en una reunión (clientes, invitados) trátalas SIEMPRE de usted, y dirígete a ellas por su nombre cuando les hables o cuando su nombre salga en la conversación ("Como decía usted, Juan…"). Con varias personas, a Alfredo de tú y al resto de usted.
Ahora mismo son las ${n.hm} (${franja}). Si saludas al empezar, que el saludo encaje con la hora: por la mañana "buenos días" y, si preguntas algo, que sea cómo ha amanecido o qué plan hay para hoy (nunca "qué tal te va el día" a primera hora, que el día acaba de empezar); al mediodía o por la tarde puedes preguntar qué tal va el día; por la noche, qué tal ha ido el día. Saludo breve y natural, una sola vez.`;
}

// ---------- Sesión: navegador <-> Gemini ----------
function startSession(client, params) {
  const modo = params.modo === 'copiloto' ? 'copiloto' : 'participante';
  const voice = params.voz || LIVE_VOICE;
  let gem = null; let ready = false; let closed = false;
  const pending = [];
  // Últimos minutos de conversación (transcripción), para que Claude entienda preguntas como "¿y el sábado?"
  let historial = ''; let ultimoHablante = '';
  function anotar(quien, texto) {
    if (quien !== ultimoHablante) { historial += '\n' + quien + ': '; ultimoHablante = quien; }
    historial += texto;
    if (historial.length > 3000) historial = historial.slice(-3000);
  }
  const usarClaude = claude.enabled();

  const setup = {
    setup: {
      model: 'models/' + LIVE_MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }, languageCode: 'es-ES' },
      },
      systemInstruction: { parts: [{ text: PERSONA[modo] + tratoRules() + instruccionesRules() + agendaRules() + agenda.resumenParaSesion(PREFS.citasAlEmpezar) + PEDIDOS_RULES + (shopify.enabled() ? shopify.RULES : '') + (usarClaude ? claude.RULES : docsRules()) + (KNOWLEDGE ? KNOWLEDGE_RULES + KNOWLEDGE : '') }] },
      realtimeInputConfig: { automaticActivityDetection: { disabled: false, endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', silenceDurationMs: 500 } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
  setup.setup.tools = [];
  if (usarClaude) setup.setup.tools.push(claude.TOOL); // Claude hace las búsquedas web y la consulta de documentos
  else {
    if (ENABLE_SEARCH) setup.setup.tools.push({ googleSearch: {} });
    if (DOCS.docs.length) setup.setup.tools.push(docsTool());
  }
  setup.setup.tools.push(AGENDA_TOOL);
  setup.setup.tools.push(PEDIDOS_TOOL);
  if (shopify.enabled()) setup.setup.tools.push(shopify.TOOL);
  if (!setup.setup.tools.length) delete setup.setup.tools;

  gem = connectGemini(
    () => { gem.send(setup); },
    raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.setupComplete) { ready = true; sendText(client, { tipo: 'listo', modelo: LIVE_MODEL, voz: voice, nombre: AGENT_NAME, conocimiento: KNOWLEDGE.length, documentos: DOCS.docs.length, cerebro: usarClaude ? claude.MODEL : '' }); for (const p of pending) gem.send(p); pending.length = 0; return; }
      const sc = msg.serverContent;
      if (sc) {
        if (sc.interrupted) sendText(client, { tipo: 'interrumpido' });
        if (sc.inputTranscription && sc.inputTranscription.text) { sendText(client, { tipo: 'oido', texto: sc.inputTranscription.text }); anotar('Persona', sc.inputTranscription.text); }
        if (sc.outputTranscription && sc.outputTranscription.text) { sendText(client, { tipo: 'dicho', texto: sc.outputTranscription.text }); anotar(AGENT_NAME, sc.outputTranscription.text); }
        const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
        for (const p of parts) if (p.inlineData && p.inlineData.data) sendBin(client, Buffer.from(p.inlineData.data, 'base64'));
        if (sc.turnComplete) sendText(client, { tipo: 'fin_turno' });
      }
      if (msg.goAway) sendText(client, { tipo: 'aviso', texto: 'La sesión con Gemini va a cerrarse; reconectando.' });
      if (msg.toolCall) {
        // Google Search se resuelve en el lado de Google. consultar_documentos la resolvemos aquí; el resto se rechaza limpiamente.
        const calls = msg.toolCall.functionCalls || [];
        Promise.all(calls.map(async c => {
          if (c.name === 'investigar') {
            const pregunta = String((c.args && c.args.pregunta) || '');
            sendText(client, { tipo: 'aviso', texto: 'Investigando: ' + pregunta });
            console.log('investigar("' + pregunta + '")');
            let result;
            try {
              result = await claude.investigar(pregunta, {
                nombre: AGENT_NAME,
                ahora: require('./recordatorios').ahora().texto,
                conocimiento: KNOWLEDGE,
                conversacion: historial.trim(),
                docs: () => DOCS.docs.map(d => d.name),
                buscar: (p, d) => documentos.answerAsync(DOCS, p, GEMINI_KEY, 8, d),
                leer: (d, n) => documentos.readDocument(DOCS, d, n),
                log: console.log,
              });
            } catch (e) {
              console.log('Claude falló: ' + e.message);
              result = 'Ahora mismo no he podido consultarlo (' + e.message.slice(0, 80) + '). Díselo al usuario en una frase y ofrece intentarlo de nuevo.';
            }
            return { id: c.id, name: c.name, response: { result } };
          }
          if (c.name === 'consultar_documentos') {
            const pregunta = String((c.args && c.args.pregunta) || '');
            const documento = c.args && c.args.documento ? String(c.args.documento) : '';
            sendText(client, { tipo: 'aviso', texto: 'Consultando documentos: ' + pregunta + (documento ? ' [' + documento + ']' : '') });
            const t0 = Date.now();
            const result = await documentos.answerAsync(DOCS, pregunta, GEMINI_KEY, 8, documento);
            console.log('consultar_documentos("' + pregunta + '") -> ' + result.length + ' chars en ' + (Date.now() - t0) + ' ms' + (DOCS.embedded ? '' : ' (sin embeddings)'));
            return { id: c.id, name: c.name, response: { result } };
          }
          if (c.name === 'guardar_recordatorio' || c.name === 'listar_recordatorios' || c.name === 'completar_recordatorio' || c.name === 'modificar_recordatorio' || c.name === 'cambiar_hora_aviso' || c.name === 'configurar_recordatorio_inicio' || c.name === 'guardar_instruccion' || c.name === 'borrar_instruccion') {
            const a = c.args || {}; let result;
            try {
              if (c.name === 'guardar_recordatorio') { const it = agenda.add({ texto: a.texto, fecha: a.fecha, hora: a.hora, lugar: a.lugar, tipo: a.tipo }); result = 'Guardado: ' + agenda.describe(it, require('./recordatorios').ahora().ymd); sendText(client, { tipo: 'agenda', accion: 'nuevo', item: it }); }
              else if (c.name === 'listar_recordatorios') result = agenda.listar(a.desde, a.hasta);
              else if (c.name === 'completar_recordatorio') { const it = agenda.update(String(a.id || ''), { hecho: true }); result = 'Completado: ' + it.texto; sendText(client, { tipo: 'agenda', accion: 'hecho', item: it }); }
              else if (c.name === 'cambiar_hora_aviso') {
                if (!a.hora) result = 'El aviso diario está puesto a las ' + horaAviso() + '.';
                else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(a.hora)) result = 'Hora no válida; dime una hora en formato HH:MM de 24 horas.';
                else {
                  const n2 = require('./recordatorios').ahora();
                  push.estado.horaAviso = a.hora;
                  if (push.estado.ultimoEnvio === n2.ymd && n2.hm < a.hora) delete push.estado.ultimoEnvio; // si la nueva hora aún no ha llegado hoy, el aviso de hoy se enviará a esa hora
                  push.save();
                  result = 'Hecho: el aviso diario de la agenda se enviará a las ' + a.hora + '.';
                }
              }
              else if (c.name === 'configurar_recordatorio_inicio') {
                PREFS.citasAlEmpezar = !!a.activar; savePrefs();
                result = a.activar ? 'Hecho y guardado: volveré a repasar las citas al empezar cada sesión.' : 'Hecho y guardado para siempre: no volveré a recitar las citas al empezar; seguirás recibiendo tu aviso diario a las ' + horaAviso() + '.';
              }
              else if (c.name === 'guardar_instruccion') {
                const t = String(a.texto || '').trim().slice(0, 200);
                if (!t) result = 'Dime la instrucción que quieres que guarde.';
                else {
                  PREFS.instrucciones = (PREFS.instrucciones || []).filter(x => x.toLowerCase() !== t.toLowerCase());
                  PREFS.instrucciones.push(t);
                  if (PREFS.instrucciones.length > 20) PREFS.instrucciones.shift();
                  savePrefs();
                  result = 'Guardada para siempre (nº ' + PREFS.instrucciones.length + '): "' + t + '". La cumpliré en todas las sesiones.';
                }
              }
              else if (c.name === 'borrar_instruccion') {
                const list = PREFS.instrucciones || []; const n = Number(a.numero);
                if (!n || n < 1 || n > list.length) result = 'No existe la instrucción nº ' + (a.numero || '?') + '; hay ' + list.length + ' guardada(s).';
                else { const q = list.splice(n - 1, 1)[0]; savePrefs(); result = 'Eliminada la instrucción: "' + q + '".'; }
              }
              else { const it = agenda.update(String(a.id || ''), { texto: a.texto, fecha: a.fecha, hora: a.hora, lugar: a.lugar }); result = 'Modificado: ' + agenda.describe(it, require('./recordatorios').ahora().ymd); sendText(client, { tipo: 'agenda', accion: 'cambio', item: it }); }
            } catch (e) { result = 'Error: ' + e.message; }
            console.log(c.name + '(' + JSON.stringify(a) + ') -> ' + result.slice(0, 80));
            return { id: c.id, name: c.name, response: { result } };
          }
          if (c.name === 'ventas_tienda' || c.name === 'buscar_producto' || c.name === 'pedido_tienda' || c.name === 'catalogo_tienda') {
            sendText(client, { tipo: 'aviso', texto: 'Consultando tienda: ' + ({ ventas_tienda: 'ventas', buscar_producto: 'producto', pedido_tienda: 'pedido', catalogo_tienda: 'catálogo' })[c.name] });
            let result;
            try { result = await shopify.llamar(c.name, c.args); } catch (e) { result = 'No se pudo consultar la tienda: ' + e.message; }
            console.log(c.name + '(' + JSON.stringify(c.args || {}) + ') -> ' + String(result).slice(0, 80));
            return { id: c.id, name: c.name, response: { result } };
          }
          if (c.name === 'estado_pedidos') {
            if (shopify.enabled()) { try { await pedidos.resolverNombres(id => shopify.nombrePedido(id)); } catch (e2) {} } // sana avisos antiguos guardados con el id interno
            let result = pedidos.resumen(c.args && c.args.pedido);
            if (shopify.enabled()) { // además de los avisos del almacén, lo pendiente de enviar según la tienda
              const enAlmacen = pedidos.lista().map(x => x.shopify).filter(Boolean); // de estos ya informa el almacén: no repetirlos como "pendientes"
              try { result += '\n' + await shopify.pendientes(enAlmacen); } catch (e) { result += '\n(No se pudo consultar la tienda: ' + e.message + ')'; }
            }
            console.log('estado_pedidos("' + ((c.args && c.args.pedido) || '') + '") -> ' + result.length + ' chars');
            return { id: c.id, name: c.name, response: { result } };
          }
          if (c.name === 'leer_documento') {
            const documento = String((c.args && c.args.documento) || ''); const parte = Number(c.args && c.args.parte) || 1;
            sendText(client, { tipo: 'aviso', texto: 'Consultando documentos: leyendo ' + documento + (parte > 1 ? ' (parte ' + parte + ')' : '') });
            const result = documentos.readDocument(DOCS, documento, parte);
            console.log('leer_documento("' + documento + '", ' + parte + ') -> ' + result.length + ' chars');
            return { id: c.id, name: c.name, response: { result } };
          }
          return { id: c.id, name: c.name, response: { result: 'no disponible' } };
        })).then(responses => { if (!closed) gem.send({ toolResponse: { functionResponses: responses } }); });
      }
    },
    reason => { if (!closed) { closed = true; sendText(client, { tipo: 'cerrado', motivo: reason }); try { client.end(); } catch (e) {} } }
  );

  return {
    audio: pcm16k => {
      const m = { realtimeInput: { audio: { data: pcm16k.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } };
      if (ready) gem.send(m); else if (pending.length < 50) pending.push(m);
    },
    text: t => { const m = { clientContent: { turns: [{ role: 'user', parts: [{ text: t }] }], turnComplete: true } }; if (ready) gem.send(m); else pending.push(m); },
    end: () => { closed = true; try { gem.close(); } catch (e) {} },
  };
}

// ---------- HTTP ----------
function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }

// ---- Acceso: PIN o token de sesión (emitido tras desbloquear con passkey / Face ID) ----
const { Recordatorios } = require('./recordatorios');
// La agenda se guarda DENTRO de DOCS_DIR (el único directorio que seguro es persistente cuando hay volumen).
// Antes se guardaba en el directorio padre de DOCS_DIR, que queda fuera del volumen si el montaje es exactamente DOCS_DIR, y se perdía en cada redespliegue.
const AGENDA_FILE = process.env.AGENDA_FILE || path.join(DOCS_DIR, 'agenda.json');
// Migración desde la ubicación antigua, si existiera y la nueva no
try {
  const OLD_AGENDA = path.resolve(DOCS_DIR) !== path.resolve(BUNDLED_DOCS) ? path.join(path.dirname(DOCS_DIR), 'agenda.json') : path.join(__dirname, 'agenda.json');
  if (!process.env.AGENDA_FILE && !fs.existsSync(AGENDA_FILE) && fs.existsSync(OLD_AGENDA)) fs.copyFileSync(OLD_AGENDA, AGENDA_FILE);
} catch (e) {}
const agenda = new Recordatorios(AGENDA_FILE);

// ---------- Preferencias persistentes (las cambia el usuario de viva voz y sobreviven a cierres y redespliegues) ----------
const PREFS_FILE = process.env.PREFS_FILE || path.join(path.dirname(AGENDA_FILE), 'preferencias.json');
let PREFS = { citasAlEmpezar: false, instrucciones: [] }; // por defecto NO se recitan las citas al abrir sesión (ya existe el aviso diario)
try { PREFS = Object.assign(PREFS, JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'))); } catch (e) {}
function savePrefs() { try { fs.writeFileSync(PREFS_FILE, JSON.stringify(PREFS, null, 1)); } catch (e) { console.log('No se pudieron guardar las preferencias: ' + e.message); } }

// Instrucciones permanentes que el usuario dicta de viva voz; entran en el prompt de cada sesión.
function instruccionesRules() {
  const list = PREFS.instrucciones || [];
  return `

=== INSTRUCCIONES PERMANENTES DEL USUARIO ===
Cuando el usuario te dé una norma de comportamiento para el futuro ("a partir de ahora…", "siempre…", "nunca…", "deja de…", "recuerda que…"), guárdala con guardar_instruccion resumida en una frase corta e imperativa: así la cumplirás en todas las sesiones, no solo en esta. Confírmaselo en una frase ("Guardado: …"). Si te pide eliminar o cambiar una, usa borrar_instruccion con su número (y guarda la nueva si procede). No guardes peticiones puntuales de la sesión (p. ej. "repite eso"), solo normas de futuro.
` + (list.length ? 'INSTRUCCIONES GUARDADAS — cúmplelas SIEMPRE:\n' + list.map((t, i) => (i + 1) + '. ' + t).join('\n') : 'Todavía no hay ninguna guardada.');
}

// ---------- Tienda Shopify (ventas, stock, pedidos) ----------
const shopify = require('./shopify');
if (shopify.enabled()) console.log('Tienda Shopify conectada: ' + process.env.SHOPIFY_SHOP);

// ---------- Pedidos de la tienda (webhook de Coinnecta) ----------
const { Pedidos } = require('./pedidos');
const pedidos = new Pedidos(path.join(path.dirname(AGENDA_FILE), 'pedidos.json'));
const PEDIDOS_TOOL = {
  functionDeclarations: [{
    name: 'estado_pedidos',
    description: 'Devuelve el estado de los pedidos: los avisos del almacén (preparado, enviado, incidencia, entregado, transportista y seguimiento) y, además, qué pedidos están pendientes de enviar según la tienda. Úsala cuando pregunten por los pedidos, si hay algo para entregar o enviar, cómo va un pedido, o por el seguimiento de un envío.',
    parameters: { type: 'OBJECT', properties: {
      pedido: { type: 'STRING', description: 'Opcional: número de pedido (p. ej. "1042") o palabra del estado ("enviado", "incidencia") para filtrar. Vacío = los últimos.' },
    } },
  }],
};
const PEDIDOS_RULES = `

=== PEDIDOS DE LA TIENDA ===
Cómo funciona el negocio (tenlo claro al responder): la tienda Shopify es el ESCAPARATE — ahí entran los pedidos, contra reembolso, así que figuran "pendientes de pago" hasta la entrega (normal). El ALMACÉN del proveedor (Coinnecta) es quien de verdad prepara y envía los pedidos al cliente; sus avisos son la fuente fiable del estado del envío.
Tienes la función estado_pedidos, que junta las dos cosas: los avisos del almacén (confirmado, enviado, transportista, seguimiento) y lo que la tienda aún marca pendiente de enviar. Si preguntan por un pedido, por los envíos o por un seguimiento, llámala antes de responder y contesta solo con lo que devuelva.
Al responder, CUENTA UNA SOLA HISTORIA por pedido: importe y pago según la tienda, estado del envío según el almacén. Si el almacén dice "enviado con MRW" y la tienda todavía lo marca "sin enviar", vale lo del almacén (la tienda tarda en reflejarlo); no lo presentes como contradicción ni como dos pedidos distintos. Di los estados en lenguaje natural y, si hay código de seguimiento, dilo despacio y claro.`;

// ---------- Avisos push (móvil/navegador) y planificador diario ----------
const { Push } = require('./push');
const push = new Push(path.dirname(AGENDA_FILE), 'mailto:' + (process.env.PUSH_CONTACTO || 'fuerno@gmail.com'));
// Hora local (Canarias) del aviso diario: se puede cambiar de viva voz ("avísame a las 8") y queda guardada.
if (!push.estado.horaAviso) { push.estado.horaAviso = process.env.PUSH_HORA || '09:00'; push.save(); }
function horaAviso() { return push.estado.horaAviso || '09:00'; }
function textoAvisos(avisos, hoyYmd) {
  return avisos.map(it => agenda.describe(it, hoyYmd).replace(/^\[\w+\] /, '')).join('\n');
}
setInterval(() => {
  try {
    const n = require('./recordatorios').ahora();
    if (n.hm < horaAviso()) return;
    if (push.estado.ultimoEnvio === n.ymd) return;
    push.estado.ultimoEnvio = n.ymd; push.save();
    const avisos = agenda.avisosDeHoy();
    if (!avisos.length || !push.subs.length) return;
    push.send('Agenda de ' + AGENT_NAME, textoAvisos(avisos, n.ymd)).then(k => console.log('Aviso diario de agenda enviado a ' + k + ' dispositivo(s)'));
  } catch (e) { console.log('Error en el aviso diario: ' + e.message); }
}, 60000);
const AGENDA_TOOL = {
  functionDeclarations: [
    { name: 'guardar_recordatorio', description: 'Guarda en la agenda una cita, una tarea con fecha o una nota que el usuario quiera recordar. Úsala en cuanto el usuario mencione algo que quiere apuntar o recordar ("tengo cita el jueves", "apúntame que…", "recuérdame…"). Calcula la fecha exacta a partir de la fecha de hoy que tienes en las instrucciones; si la fecha es ambigua, pregunta antes.',
      parameters: { type: 'OBJECT', properties: {
        texto: { type: 'STRING', description: 'Qué es (p. ej. "Cita con el dentista", "Llamar a Flavio").' },
        fecha: { type: 'STRING', description: 'Fecha en formato AAAA-MM-DD. Vacío si es una nota sin fecha.' },
        hora: { type: 'STRING', description: 'Hora HH:MM (24 h) si la hay.' },
        lugar: { type: 'STRING', description: 'Lugar, si lo dice.' },
        tipo: { type: 'STRING', description: '"cita", "tarea" o "nota".' },
      }, required: ['texto'] } },
    { name: 'listar_recordatorios', description: 'Devuelve lo pendiente en la agenda (citas, tareas, notas), opcionalmente entre dos fechas. Úsala cuando pregunten qué hay, qué toca esta semana, si hay algo pendiente, etc.',
      parameters: { type: 'OBJECT', properties: { desde: { type: 'STRING', description: 'AAAA-MM-DD (opcional).' }, hasta: { type: 'STRING', description: 'AAAA-MM-DD (opcional).' } } } },
    { name: 'completar_recordatorio', description: 'Marca como hecha o cancelada una cita/tarea/nota (desaparece de los pendientes). Necesita el id que aparece entre corchetes al listar.',
      parameters: { type: 'OBJECT', properties: { id: { type: 'STRING' } }, required: ['id'] } },
    { name: 'modificar_recordatorio', description: 'Cambia la fecha, la hora, el lugar o el texto de un recordatorio existente (p. ej. "la cita del dentista pásala al viernes").',
      parameters: { type: 'OBJECT', properties: { id: { type: 'STRING' }, texto: { type: 'STRING' }, fecha: { type: 'STRING', description: 'AAAA-MM-DD' }, hora: { type: 'STRING', description: 'HH:MM' }, lugar: { type: 'STRING' } }, required: ['id'] } },
    { name: 'cambiar_hora_aviso', description: 'Cambia la hora a la que cada día se envía el aviso con las citas (notificación al móvil y al PC). Úsala cuando pidan que avise a otra hora ("avísame a las 8", "manda el aviso por la tarde"). Sin el parámetro hora, devuelve a qué hora está puesto ahora.',
      parameters: { type: 'OBJECT', properties: { hora: { type: 'STRING', description: 'HH:MM en 24 horas (p. ej. "08:00", "20:30"). Vacío para consultar.' } } } },
    { name: 'configurar_recordatorio_inicio', description: 'Activa o desactiva PARA SIEMPRE (queda guardado para todas las sesiones futuras) que al empezar cada sesión se reciten las citas próximas. Úsala en cuanto el usuario pida que no le recuerdes las citas al abrir ("no me las recuerdes cada vez", "deja de repetirme la agenda") o que vuelvas a hacerlo.',
      parameters: { type: 'OBJECT', properties: { activar: { type: 'BOOLEAN', description: 'false = no recitar citas al empezar; true = volver a recitarlas.' } }, required: ['activar'] } },
    { name: 'guardar_instruccion', description: 'Guarda PARA SIEMPRE una norma de comportamiento que el usuario te dé para el futuro ("a partir de ahora…", "siempre…", "nunca…"). Quedará fija en todas las sesiones futuras, no solo en esta.',
      parameters: { type: 'OBJECT', properties: { texto: { type: 'STRING', description: 'La instrucción, resumida en una frase corta e imperativa (p. ej. "No proponer reuniones los domingos").' } }, required: ['texto'] } },
    { name: 'borrar_instruccion', description: 'Elimina una de las instrucciones permanentes guardadas, por su número en la lista de tus instrucciones.',
      parameters: { type: 'OBJECT', properties: { numero: { type: 'INTEGER', description: 'Número de la instrucción en la lista.' } }, required: ['numero'] } },
  ],
};
function agendaRules() {
  return `

=== AGENDA ===
Tienes una agenda persistente con las funciones guardar_recordatorio, listar_recordatorios, completar_recordatorio, modificar_recordatorio, cambiar_hora_aviso y configurar_recordatorio_inicio. Cada día se envía un aviso con las citas que tocan (notificación al móvil y al PC); si el usuario pide que se le avise a otra hora o pregunta a qué hora se le avisa, usa cambiar_hora_aviso. Si el usuario menciona una cita, un plazo, algo que tiene que hacer o algo que quiere recordar, guárdalo (confirma en una frase: "Apuntado: dentista, jueves 23 a las 10"). Para fechas relativas usa la fecha de hoy. Si te pregunta qué tiene pendiente o qué hay esta semana, lista. Cuando diga que algo ya está hecho o se cancela, complétalo.
` + (PREFS.citasAlEmpezar
    ? 'Al empezar la sesión, si hay citas vencidas, de hoy o de los próximos días, recuérdaselas una vez, brevemente. Si el usuario te pide que dejes de recordárselas al empezar, usa configurar_recordatorio_inicio con activar=false: así queda guardado para todas las sesiones.'
    : 'IMPORTANTE: al empezar la sesión NO recites la agenda ni las citas pendientes, ni las menciones sin que te pregunten; el usuario ya recibe su aviso diario a la hora que eligió. Habla de la agenda solo si el usuario la saca o te pregunta. Si alguna vez te pidiera recuperar el repaso de citas al empezar, usa configurar_recordatorio_inicio con activar=true.');
}

const { Passkeys } = require('./passkeys');
const PASSKEYS_FILE = process.env.PASSKEYS_FILE || (path.resolve(DOCS_DIR) !== path.resolve(BUNDLED_DOCS) ? path.join(path.dirname(DOCS_DIR), 'passkeys.json') : path.join(__dirname, 'passkeys.json'));
const passkeys = new Passkeys(PASSKEYS_FILE);
function authorized(u, req) {
  if (!ACCESS_PIN) return true;
  const pin = u.searchParams.get('pin') || req.headers['x-pin'] || '';
  if (pin && pin === ACCESS_PIN) return true;
  const token = u.searchParams.get('token') || req.headers['x-token'] || '';
  return passkeys.validSession(token);
}
function rpInfo(req) { const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0]; const proto = req.headers['x-forwarded-proto'] || 'https'; return { rpId: host, origin: proto + '://' + (req.headers['x-forwarded-host'] || req.headers.host) }; }
function readJson(req, cb) { const parts = []; let n = 0; req.on('data', c => { n += c.length; if (n < 1e6) parts.push(c); }); req.on('end', () => { try { cb(null, JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { cb(e); } }); }

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, no-cache, must-revalidate', 'pragma': 'no-cache' });
    return res.end(INDEX);
  }
  if (req.method === 'GET' && req.url === '/manifest.webmanifest') {
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify({
      name: AGENT_NAME + ' · Copiloto Live', short_name: AGENT_NAME, description: 'Asistente de voz en tiempo real para reuniones.',
      start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait', lang: 'es',
      background_color: '#f3f5f8', theme_color: '#23466e',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  }
  if (req.method === 'GET' && req.url === '/sw.js') {
    const f = path.join(PUBLIC_DIR, 'sw.js');
    if (fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(fs.readFileSync(f)); }
  }
  if (req.method === 'GET' && /^\/[\w.-]+\.(png|svg|ico)$/.test(req.url)) {
    const f = path.join(PUBLIC_DIR, req.url.slice(1));
    if (fs.existsSync(f)) { res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'public, max-age=86400' }); return res.end(fs.readFileSync(f)); }
  }
  if (req.method === 'GET' && req.url === '/salud') return send(res, 200, { ok: true, version: VERSION, clave: !!GEMINI_KEY, modelo: LIVE_MODEL, cerebro_claude: claude.enabled() ? claude.MODEL : false, voz: LIVE_VOICE, busqueda: ENABLE_SEARCH, nombre: AGENT_NAME, tienda: shopify.enabled(), citas_al_empezar: PREFS.citasAlEmpezar, instrucciones: (PREFS.instrucciones || []).length, conocimiento_chars: KNOWLEDGE.length, busqueda_semantica: !!DOCS.embedded, agenda_pendientes: agenda.pendientes().length, documentos: DOCS.docs.map(d => ({ nombre: d.name, fragmentos: d.chunks })) });

  const u = new URL(req.url, 'http://x');

  // ---- Passkeys (Face ID / huella) ----
  if (u.pathname.startsWith('/auth/')) {
    const { rpId, origin } = rpInfo(req);
    if (req.method === 'GET' && u.pathname === '/auth/estado') return send(res, 200, { pin: !!ACCESS_PIN, passkeys: passkeys.count(), sesion: authorized(u, req) });
    if (req.method === 'POST' && u.pathname === '/auth/opciones-registro') { if (!authorized(u, req)) return send(res, 401, { error: 'PIN incorrecto' }); return send(res, 200, passkeys.registrationOptions(rpId, AGENT_NAME)); }
    if (req.method === 'POST' && u.pathname === '/auth/registro') {
      if (!authorized(u, req)) return send(res, 401, { error: 'PIN incorrecto' });
      return readJson(req, (e, body) => { if (e) return send(res, 400, { error: 'JSON' }); try { const id = passkeys.register(rpId, origin, body, body.nombre); console.log('Passkey registrada: ' + (body.nombre || id)); send(res, 200, { ok: true, id, token: passkeys.newSession(body.nombre) }); } catch (err) { send(res, 400, { error: err.message }); } });
    }
    if (req.method === 'POST' && u.pathname === '/auth/opciones-login') return send(res, 200, passkeys.loginOptions(rpId));
    if (req.method === 'POST' && u.pathname === '/auth/login') {
      return readJson(req, (e, body) => { if (e) return send(res, 400, { error: 'JSON' }); try { const token = passkeys.login(rpId, origin, body); send(res, 200, { ok: true, token }); } catch (err) { console.log('Passkey login fallido: ' + err.message); send(res, 401, { error: err.message }); } });
    }
    if (req.method === 'GET' && u.pathname === '/auth/dispositivos') { if (!authorized(u, req)) return send(res, 401, { error: 'PIN incorrecto' }); return send(res, 200, { dispositivos: passkeys.list() }); }
    if (req.method === 'DELETE' && u.pathname.startsWith('/auth/dispositivos/')) { if (!authorized(u, req)) return send(res, 401, { error: 'PIN incorrecto' }); passkeys.remove(decodeURIComponent(u.pathname.slice('/auth/dispositivos/'.length))); return send(res, 200, { ok: true, dispositivos: passkeys.list() }); }
    return send(res, 404, { error: 'No encontrado' });
  }

  // ---- Agenda (panel de la web) ----
  if (u.pathname === '/agenda' || u.pathname.startsWith('/agenda/')) {
    if (!authorized(u, req)) return send(res, 401, { error: 'PIN incorrecto' });
    const hoy = require('./recordatorios').ahora();
    if (req.method === 'GET' && u.pathname === '/agenda') return send(res, 200, { hoy: hoy.ymd, ahora: hoy.texto, items: agenda.pendientes().map(it => Object.assign({ descripcion: agenda.describe(it, hoy.ymd) }, it)) });
    if (req.method === 'POST' && u.pathname === '/agenda') return readJson(req, (e, body) => { if (e) return send(res, 400, { error: 'JSON' }); try { send(res, 200, { ok: true, item: agenda.add(body) }); } catch (err) { send(res, 400, { error: err.message }); } });
    const id = u.pathname.slice('/agenda/'.length);
    if (req.method === 'DELETE' && id) { try { agenda.remove(id); return send(res, 200, { ok: true }); } catch (e) { return send(res, 404, { error: e.message }); } }
    if (req.method === 'PATCH' && id) return readJson(req, (e, body) => { if (e) return send(res, 400, { error: 'JSON' }); try { send(res, 200, { ok: true, item: agenda.update(id, body) }); } catch (err) { send(res, 400, { error: err.message }); } });
    return send(res, 405, { error: 'Método no permitido' });
  }

  // ---- Avisos (para el sync del PC y los push del móvil) ----
  if (u.pathname === '/avisos') {
    if (!authorized(u, req)) return send(res, 401, { error: 'PIN incorrecto' });
    const hoy = require('./recordatorios').ahora();
    const avisos = agenda.avisosDeHoy();
    return send(res, 200, { hoy: hoy.ymd, ahora: hoy.texto, avisos: avisos.map(it => ({ id: it.id, texto: it.texto, fecha: it.fecha, hora: it.hora, lugar: it.lugar, faltan: it.faltan, descripcion: agenda.describe(it, hoy.ymd).replace(/^\[\w+\] /, '') })) });
  }
  if (u.pathname.startsWith('/push')) {
    if (!authorized(u, req)) return send(res, 401, { error: 'PIN incorrecto' });
    if (req.method === 'GET' && u.pathname === '/push/clave') return send(res, 200, { ok: push.ok, clave: push.keys ? push.keys.publicKey : null, dispositivos: push.subs.length });
    if (req.method === 'POST' && u.pathname === '/push/suscribir') {
      return readJson(req, (e, body) => { if (e) return send(res, 400, { error: 'JSON' }); try { const n = push.add(body.sub, body.nombre); console.log('Dispositivo suscrito a avisos push (' + n + ' en total)'); send(res, 200, { ok: true, dispositivos: n }); } catch (err) { send(res, 400, { error: err.message }); } });
    }
    if (req.method === 'POST' && u.pathname === '/push/prueba') {
      return push.send('Prueba de ' + AGENT_NAME, 'Así te avisaré de tus citas. 👋').then(n => send(res, 200, { ok: true, enviados: n })).catch(e => send(res, 500, { error: e.message }));
    }
    return send(res, 404, { error: 'No encontrado' });
  }

  // ---- Pedidos de la tienda ----
  // Webhook que Coinnecta llama con cada actualización de pedido. No usa el PIN:
  // se autentica con la clave secreta que va en la propia URL configurada en Coinnecta.
  if (u.pathname === '/webhook/coinnecta') {
    if (req.method !== 'POST') return send(res, 405, { error: 'Método no permitido' });
    if ((u.searchParams.get('clave') || '') !== pedidos.data.clave) return send(res, 401, { error: 'Clave incorrecta' });
    return readJson(req, async (e, body) => {
      if (e) return send(res, 400, { error: 'JSON' });
      try {
        // El almacén manda el id interno largo de Shopify: lo traducimos al número visible (#1003) antes de guardar y avisar.
        if (shopify.enabled() && body && body.shopify_order_id) {
          try { body.shopify_name = await shopify.nombrePedido(body.shopify_order_id); } catch (e2) { console.log('No se pudo traducir el pedido de Shopify ' + body.shopify_order_id + ': ' + e2.message); }
        }
        const { ped, ev } = pedidos.evento(body);
        console.log('Webhook Coinnecta: pedido ' + pedidos.nombre(ped) + ' -> ' + ev.estado + (ev.seguimiento ? ' (' + ev.seguimiento + ')' : ''));
        let cuerpo = ev.estado + (ev.detalles ? ' · ' + ev.detalles : '') + (ped.transportista ? ' · ' + ped.transportista : '') + (ev.seguimiento ? '\nSeguimiento: ' + ev.seguimiento : '') + '\nAlmacén nº ' + ped.order_id + ' · toca para abrir el panel';
        push.send('🛒 Pedido ' + pedidos.nombre(ped), cuerpo, 'https://almacen.coinnecta.es/app/orders').then(n => { if (n) console.log('Aviso de pedido enviado a ' + n + ' dispositivo(s)'); }).catch(() => {});
        send(res, 200, { ok: true });
      } catch (err) { send(res, 400, { error: err.message }); }
    });
  }
  // Listado para la web (protegido como todo lo demás) + la URL del webhook para pegarla en Coinnecta.
  if (u.pathname === '/pedidos' && req.method === 'GET') {
    if (!authorized(u, req)) return send(res, 401, { error: 'PIN incorrecto' });
    const { origin } = rpInfo(req);
    return send(res, 200, { pedidos: pedidos.lista().slice(0, 50), webhook: origin + '/webhook/coinnecta?clave=' + pedidos.data.clave });
  }

  // ---- Gestión de documentos (misma protección que la sesión: PIN o token) ----
  if (u.pathname === '/documentos' || u.pathname.startsWith('/documentos/')) {
    if (!authorized(u, req)) return send(res, 401, { error: 'PIN incorrecto' });
    if (req.method === 'GET' && u.pathname === '/documentos') return send(res, 200, { documentos: docsList() });
    if (req.method === 'GET' && u.pathname === '/documentos/buscar') { // prueba de búsqueda: ?q=...
      const q = u.searchParams.get('q') || '';
      return documentos.answerAsync(DOCS, q, GEMINI_KEY, 8, u.searchParams.get('doc') || '').then(r => send(res, 200, { pregunta: q, semantica: !!DOCS.embedded, ranking: DOCS.lastDebug || null, resultado: r })).catch(e => send(res, 500, { error: e.message }));
    }
    const name = u.pathname.length > '/documentos/'.length ? safeDocName(u.pathname.slice('/documentos/'.length)) : '';
    if (req.method === 'PUT' && u.pathname.startsWith('/documentos/')) {
      if (!name) return send(res, 400, { error: 'Nombre no válido. Formatos: md, txt, pdf, docx.' });
      const len = Number(req.headers['content-length'] || 0);
      if (len > DOCS_MAX_BYTES) return send(res, 413, { error: 'Demasiado grande (máximo 50 MB).' });
      const parts = []; let size = 0; let aborted = false;
      req.on('data', c => { size += c.length; if (size > DOCS_MAX_BYTES) { aborted = true; req.destroy(); } else parts.push(c); });
      req.on('end', async () => {
        if (aborted) return;
        const full = path.join(DOCS_DIR, name);
        try {
          fs.writeFileSync(full, Buffer.concat(parts));
          try { fs.unlinkSync(full + documentos.OCR_SIDECAR); } catch (e) {} // si se sustituye un PDF, su OCR anterior ya no vale
          // PDF escaneado: se responde ya y el OCR sigue en segundo plano (la lista muestra el progreso).
          if (/\.pdf$/i.test(name) && documentos.pdfNeedsOcr(full)) {
            queueOcr(name);
            console.log('Documento subido: ' + name + ' (escaneado; OCR en cola)');
            return send(res, 202, { ok: true, procesando: true, documento: { nombre: name.replace(DOCS_EXT, ''), fichero: name, fragmentos: 0, ocr: true }, documentos: docsList() });
          }
          reindexDocs();
          const d = DOCS.docs.find(x => x.file === name);
          if (!d) { try { fs.unlinkSync(full); } catch (e) {} reindexDocs(); return send(res, 422, { error: 'No se pudo extraer texto del fichero.' }); }
          console.log('Documento subido: ' + name + ' (' + d.chunks + ' fragmentos)');
          send(res, 200, { ok: true, documento: { nombre: d.name, fichero: d.file, fragmentos: d.chunks, ocr: false }, documentos: docsList() });
        } catch (e) { send(res, 500, { error: 'No se pudo guardar: ' + e.message }); }
      });
      req.on('error', () => {});
      return;
    }
    if (req.method === 'DELETE' && u.pathname.startsWith('/documentos/')) {
      if (!name) return send(res, 400, { error: 'Nombre no válido' });
      try { fs.unlinkSync(path.join(DOCS_DIR, name)); } catch (e) { return send(res, 404, { error: 'No existe' }); }
      try { fs.unlinkSync(path.join(DOCS_DIR, name + documentos.OCR_SIDECAR)); } catch (e) {}
      OCR_PENDING.delete(name);
      reindexDocs(); console.log('Documento borrado: ' + name);
      return send(res, 200, { ok: true, documentos: docsList() });
    }
    return send(res, 405, { error: 'Método no permitido' });
  }
  send(res, 404, { error: 'No encontrado' });
});

server.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/ws') { sock.destroy(); return; }
  if (!authorized(u, req)) { sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); sock.destroy(); return; }
  if (!GEMINI_KEY) { sock.write('HTTP/1.1 500 Internal Server Error\r\n\r\n'); sock.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  const session = startSession(sock, { modo: u.searchParams.get('modo'), voz: u.searchParams.get('voz') });
  const parse = makeParser((op, payload) => {
    if (op === 0x2) session.audio(payload);
    else if (op === 0x1) { try { const j = JSON.parse(payload.toString()); if (j.texto) session.text(String(j.texto)); } catch (e) {} }
  }, () => { session.end(); try { sock.end(); } catch (e) {} });
  sock.on('data', parse);
  sock.on('close', () => session.end());
  sock.on('error', () => session.end());
});

server.listen(PORT, () => console.log('Copiloto Live en el puerto ' + PORT));
