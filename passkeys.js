// Passkeys (WebAuthn) sin dependencias: Face ID / Touch ID / huella para desbloquear la app.
// Registro: requiere el PIN (solo quien lo tiene puede dar de alta un dispositivo).
// Login: el dispositivo firma un reto con su clave privada (desbloqueada con la cara) y el servidor
// comprueba la firma con la clave pública guardada; a cambio emite un token de sesión.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- CBOR mínimo (lo justo para attestationObject y claves COSE) ----
function cborDecode(buf) {
  let pos = 0;
  function readLen(ai) {
    if (ai < 24) return ai;
    if (ai === 24) return buf[pos++];
    if (ai === 25) { const v = buf.readUInt16BE(pos); pos += 2; return v; }
    if (ai === 26) { const v = buf.readUInt32BE(pos); pos += 4; return v; }
    if (ai === 27) { const v = Number(buf.readBigUInt64BE(pos)); pos += 8; return v; }
    throw new Error('CBOR: longitud no soportada');
  }
  function item() {
    const b = buf[pos++]; const major = b >> 5; const ai = b & 31;
    switch (major) {
      case 0: return readLen(ai);
      case 1: return -1 - readLen(ai);
      case 2: { const n = readLen(ai); const v = buf.slice(pos, pos + n); pos += n; return v; }
      case 3: { const n = readLen(ai); const v = buf.slice(pos, pos + n).toString('utf8'); pos += n; return v; }
      case 4: { const n = readLen(ai); const a = []; for (let i = 0; i < n; i++) a.push(item()); return a; }
      case 5: { const n = readLen(ai); const m = new Map(); for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); } return m; }
      case 7: if (ai === 20) return false; if (ai === 21) return true; if (ai === 22) return null; throw new Error('CBOR: simple no soportado');
      default: throw new Error('CBOR: tipo no soportado');
    }
  }
  return item();
}

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function fromB64u(s) { return Buffer.from(String(s || ''), 'base64url'); }
function sha256(b) { return crypto.createHash('sha256').update(b).digest(); }

// Clave COSE -> JWK (EC2 P-256 / RSA)
function coseToJwk(cose) {
  const kty = cose.get(1); const alg = cose.get(3);
  if (kty === 2) return { jwk: { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) }, alg: alg || -7 };
  if (kty === 3) return { jwk: { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) }, alg: alg || -257 };
  throw new Error('Tipo de clave no soportado');
}

// authenticatorData: rpIdHash(32) | flags(1) | counter(4) | [aaguid(16) | credIdLen(2) | credId | COSE key]
function parseAuthData(ad) {
  const out = { rpIdHash: ad.slice(0, 32), flags: ad[32], counter: ad.readUInt32BE(33) };
  if (out.flags & 0x40) {
    const len = ad.readUInt16BE(53);
    out.credId = ad.slice(55, 55 + len);
    out.cose = cborDecode(ad.slice(55 + len));
  }
  return out;
}

class Passkeys {
  constructor(file) {
    this.file = file;
    this.data = { credenciales: [], sesiones: {} };
    try { this.data = Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) {}
    this.retos = new Map(); // reto -> { tipo, expira }
  }
  save() { try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1)); } catch (e) { console.log('No se pudo guardar passkeys: ' + e.message); } }
  count() { return this.data.credenciales.length; }
  newChallenge(tipo) {
    const c = b64u(crypto.randomBytes(32)); this.retos.set(c, { tipo, expira: Date.now() + 5 * 60 * 1000 });
    for (const [k, v] of this.retos) if (v.expira < Date.now()) this.retos.delete(k);
    return c;
  }
  useChallenge(c, tipo) { const r = this.retos.get(c); this.retos.delete(c); return !!(r && r.tipo === tipo && r.expira > Date.now()); }

  registrationOptions(rpId, nombreUsuario) {
    return {
      challenge: this.newChallenge('reg'),
      rp: { id: rpId, name: 'Copiloto Live' },
      user: { id: b64u(crypto.randomBytes(16)), name: nombreUsuario, displayName: nombreUsuario },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 120000, attestation: 'none',
      excludeCredentials: this.data.credenciales.map(c => ({ type: 'public-key', id: c.id })),
    };
  }
  register(rpId, origin, body, nombreDispositivo) {
    const clientData = JSON.parse(fromB64u(body.clientDataJSON).toString('utf8'));
    if (clientData.type !== 'webauthn.create') throw new Error('tipo incorrecto');
    if (!this.useChallenge(clientData.challenge, 'reg')) throw new Error('reto caducado; vuelve a intentarlo');
    if (clientData.origin !== origin) throw new Error('origen incorrecto: ' + clientData.origin);
    const att = cborDecode(fromB64u(body.attestationObject));
    const ad = parseAuthData(att.get('authData'));
    if (!ad.rpIdHash.equals(sha256(Buffer.from(rpId)))) throw new Error('rpId incorrecto');
    if (!(ad.flags & 0x01)) throw new Error('sin presencia de usuario');
    if (!ad.credId) throw new Error('sin credencial');
    const { jwk, alg } = coseToJwk(ad.cose);
    const id = b64u(ad.credId);
    this.data.credenciales = this.data.credenciales.filter(c => c.id !== id);
    this.data.credenciales.push({ id, jwk, alg, counter: ad.counter, nombre: nombreDispositivo || 'dispositivo', fecha: new Date().toISOString() });
    this.save();
    return id;
  }
  loginOptions(rpId) {
    return {
      challenge: this.newChallenge('auth'), rpId, timeout: 120000, userVerification: 'required',
      allowCredentials: this.data.credenciales.map(c => ({ type: 'public-key', id: c.id })),
    };
  }
  login(rpId, origin, body) {
    const cred = this.data.credenciales.find(c => c.id === body.id);
    if (!cred) throw new Error('dispositivo no registrado');
    const clientDataRaw = fromB64u(body.clientDataJSON);
    const clientData = JSON.parse(clientDataRaw.toString('utf8'));
    if (clientData.type !== 'webauthn.get') throw new Error('tipo incorrecto');
    if (!this.useChallenge(clientData.challenge, 'auth')) throw new Error('reto caducado; vuelve a intentarlo');
    if (clientData.origin !== origin) throw new Error('origen incorrecto');
    const adRaw = fromB64u(body.authenticatorData); const ad = parseAuthData(adRaw);
    if (!ad.rpIdHash.equals(sha256(Buffer.from(rpId)))) throw new Error('rpId incorrecto');
    if (!(ad.flags & 0x04)) throw new Error('sin verificación biométrica');
    const key = crypto.createPublicKey({ key: cred.jwk, format: 'jwk' });
    const signed = Buffer.concat([adRaw, sha256(clientDataRaw)]);
    const ok = crypto.verify('sha256', signed, cred.alg === -7 ? { key, dsaEncoding: 'der' } : { key, padding: crypto.constants.RSA_PKCS1_PADDING }, fromB64u(body.signature));
    if (!ok) throw new Error('firma no válida');
    if (ad.counter && cred.counter && ad.counter <= cred.counter) throw new Error('contador sospechoso');
    cred.counter = ad.counter; cred.ultimoUso = new Date().toISOString();
    return this.newSession(cred.nombre);
  }
  newSession(nombre) {
    const token = b64u(crypto.randomBytes(32));
    const now = Date.now();
    for (const [t, s] of Object.entries(this.data.sesiones)) if (s.expira < now) delete this.data.sesiones[t];
    this.data.sesiones[token] = { nombre, expira: now + 30 * 24 * 3600 * 1000 };
    this.save();
    return token;
  }
  validSession(token) { const s = token && this.data.sesiones[token]; return !!(s && s.expira > Date.now()); }
  remove(id) { this.data.credenciales = this.data.credenciales.filter(c => c.id !== id); this.save(); }
  list() { return this.data.credenciales.map(c => ({ id: c.id, nombre: c.nombre, fecha: c.fecha, ultimoUso: c.ultimoUso || null })); }
}

module.exports = { Passkeys };
