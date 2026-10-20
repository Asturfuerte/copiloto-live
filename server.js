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

const INDEX = fs.readFileSync(path.join(__dirname, 'index.html'));

const PERSONA = {
  participante: `Eres "Claude", una persona más en una conversación informal en español de España. Escuchas en directo a varias personas.
Habla SOLO cuando aporte: si alguien dice algo falso o inexacto, corrígelo con naturalidad y educación; si te preguntan o te nombran ("Claude"), responde; de vez en cuando puedes añadir un dato breve o una pregunta que encaje. Si no hay nada que decir, responde con un silencio absoluto: no digas ni una palabra, ni saludos ni muletillas.
Frases cortas (máximo veinticinco palabras), tono cercano, sin listas ni enumeraciones, como quien habla en una mesa. Si no estás seguro de un dato, dilo o búscalo antes de afirmarlo. Nunca repitas lo que ya dijiste.`,
  copiloto: `Eres "Claude", un acompañante discreto en una reunión en español de España. Escuchas en directo.
Habla ÚNICAMENTE si alguien afirma algo claramente falso o inexacto, o si te preguntan o te nombran ("Claude"). En cualquier otro caso responde con silencio absoluto: ni una palabra, ni saludos ni muletillas.
Cuando hables, sé breve (máximo veinte palabras), educado y concreto, y cita el dato correcto. Si no estás seguro, búscalo antes. Nunca repitas lo que ya dijiste.`,
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
      systemInstruction: { parts: [{ text: PERSONA[modo] }] },
      realtimeInputConfig: { automaticActivityDetection: { disabled: false, endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', silenceDurationMs: 500 } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
  if (ENABLE_SEARCH) setup.setup.tools = [{ googleSearch: {} }];

  gem = connectGemini(
    () => { gem.send(setup); },
    raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.setupComplete) { ready = true; sendText(client, { tipo: 'listo', modelo: LIVE_MODEL, voz: voice }); for (const p of pending) gem.send(p); pending.length = 0; return; }
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
        // Google Search se resuelve en el lado de Google; cualquier otra función la rechazamos limpiamente
        const calls = msg.toolCall.functionCalls || [];
        gem.send({ toolResponse: { functionResponses: calls.map(c => ({ id: c.id, name: c.name, response: { result: 'no disponible' } })) } });
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

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, no-cache, must-revalidate', 'pragma': 'no-cache' });
    return res.end(INDEX);
  }
  if (req.method === 'GET' && req.url === '/salud') return send(res, 200, { ok: true, clave: !!GEMINI_KEY, modelo: LIVE_MODEL, voz: LIVE_VOICE, busqueda: ENABLE_SEARCH });
  send(res, 404, { error: 'No encontrado' });
});

server.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/ws') { sock.destroy(); return; }
  if (ACCESS_PIN && u.searchParams.get('pin') !== ACCESS_PIN) { sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); sock.destroy(); return; }
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
