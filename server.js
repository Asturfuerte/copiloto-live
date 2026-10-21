// Copiloto Live: puente WebSocket entre el navegador y Gemini Live.
// Sin dependencias: HTTP + WebSocket (RFC 6455) implementados a mano.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const ACCESS_PIN = process.env.ACCESS_PIN || '';
const LIVE_MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live';
const LIVE_VOICE = process.env.LIVE_VOICE || 'Aoede';
const ENABLE_SEARCH = (process.env.ENABLE_SEARCH || '1') !== '0';
const AGENT_NAME = process.env.AGENT_NAME || 'Claude';
const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || path.join(__dirname, 'conocimiento');

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
Tono cercano, sin listas ni enumeraciones, como quien habla en una mesa. Si no estás seguro de un dato, dilo o búscalo antes de afirmarlo. Nunca repitas lo que ya dijiste.`,
  copiloto: `Eres "${AGENT_NAME}", un acompañante discreto en una reunión en español de España. Escuchas en directo.
Habla ÚNICAMENTE si alguien afirma algo claramente falso o inexacto, o si te preguntan o te nombran ("${AGENT_NAME}"). En cualquier otro caso responde con silencio absoluto: ni una palabra, ni saludos ni muletillas.
Cuando corrijas por tu cuenta, sé breve (máximo veinte palabras), educado y concreto, y cita el dato correcto.
Cuando te pregunten directamente o te pidan información, responde completo: da la respuesta entera con los datos necesarios, aunque ocupe varias frases, sin cortarte a medias. Aun así, ve al grano y sin relleno.
Si no estás seguro de un dato, búscalo antes. Nunca repitas lo que ya dijiste.`,
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

// ---------- Sesión: navegador <-> Gemini ----------
function startSession(client, params) {
  const modo = params.modo === 'copiloto' ? 'copiloto' : 'participante';
  const voice = params.voz || LIVE_VOICE;
  let gem = null; let ready = false; let closed = false;
  const pending = [];

  const setup = {
    setup: {
      model: 'models/' + LIVE_MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }, languageCode: 'es-ES' },
      },
      systemInstruction: { parts: [{ text: PERSONA[modo] + docsRules() + (KNOWLEDGE ? KNOWLEDGE_RULES + KNOWLEDGE : '') }] },
      realtimeInputConfig: { automaticActivityDetection: { disabled: false, endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', silenceDurationMs: 500 } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
  setup.setup.tools = [];
  if (ENABLE_SEARCH) setup.setup.tools.push({ googleSearch: {} });
  if (DOCS.docs.length) setup.setup.tools.push(docsTool());
  if (!setup.setup.tools.length) delete setup.setup.tools;

  gem = connectGemini(
    () => { gem.send(setup); },
    raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.setupComplete) { ready = true; sendText(client, { tipo: 'listo', modelo: LIVE_MODEL, voz: voice, nombre: AGENT_NAME, conocimiento: KNOWLEDGE.length, documentos: DOCS.docs.length }); for (const p of pending) gem.send(p); pending.length = 0; return; }
      const sc = msg.serverContent;
      if (sc) {
        if (sc.interrupted) sendText(client, { tipo: 'interrumpido' });
        if (sc.inputTranscription && sc.inputTranscription.text) sendText(client, { tipo: 'oido', texto: sc.inputTranscription.text });
        if (sc.outputTranscription && sc.outputTranscription.text) sendText(client, { tipo: 'dicho', texto: sc.outputTranscription.text });
        const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
        for (const p of parts) if (p.inlineData && p.inlineData.data) sendBin(client, Buffer.from(p.inlineData.data, 'base64'));
        if (sc.turnComplete) sendText(client, { tipo: 'fin_turno' });
      }
      if (msg.goAway) sendText(client, { tipo: 'aviso', texto: 'La sesión con Gemini va a cerrarse; reconectando.' });
      if (msg.toolCall) {
        // Google Search se resuelve en el lado de Google. consultar_documentos la resolvemos aquí; el resto se rechaza limpiamente.
        const calls = msg.toolCall.functionCalls || [];
        Promise.all(calls.map(async c => {
          if (c.name === 'consultar_documentos') {
            const pregunta = String((c.args && c.args.pregunta) || '');
            const documento = c.args && c.args.documento ? String(c.args.documento) : '';
            sendText(client, { tipo: 'aviso', texto: 'Consultando documentos: ' + pregunta + (documento ? ' [' + documento + ']' : '') });
            const t0 = Date.now();
            const result = await documentos.answerAsync(DOCS, pregunta, GEMINI_KEY, 8, documento);
            console.log('consultar_documentos("' + pregunta + '") -> ' + result.length + ' chars en ' + (Date.now() - t0) + ' ms' + (DOCS.embedded ? '' : ' (sin embeddings)'));
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
  if (req.method === 'GET' && /^\/[\w.-]+\.(png|svg|ico)$/.test(req.url)) {
    const f = path.join(PUBLIC_DIR, req.url.slice(1));
    if (fs.existsSync(f)) { res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'public, max-age=86400' }); return res.end(fs.readFileSync(f)); }
  }
  if (req.method === 'GET' && req.url === '/salud') return send(res, 200, { ok: true, clave: !!GEMINI_KEY, modelo: LIVE_MODEL, voz: LIVE_VOICE, busqueda: ENABLE_SEARCH, nombre: AGENT_NAME, conocimiento_chars: KNOWLEDGE.length, busqueda_semantica: !!DOCS.embedded, documentos: DOCS.docs.map(d => ({ nombre: d.name, fragmentos: d.chunks })) });

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
