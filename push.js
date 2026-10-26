// Avisos push: suscripciones de navegadores/móviles y envío de notificaciones (claves VAPID propias).
// Las claves y las suscripciones se guardan junto a la agenda, en el directorio persistente.
const fs = require('fs');
const path = require('path');
let webpush = null; try { webpush = require('web-push'); } catch (e) {}

class Push {
  constructor(dir, subject) {
    this.ok = !!webpush;
    this.keysFile = path.join(dir, 'push-vapid.json');
    this.subsFile = path.join(dir, 'push-subs.json');
    this.keys = null; this.subs = []; this.estado = {};
    if (!this.ok) { console.log('Push no disponible: falta el paquete web-push (npm install)'); return; }
    try { this.keys = JSON.parse(fs.readFileSync(this.keysFile, 'utf8')); } catch (e) {}
    if (!this.keys || !this.keys.publicKey) {
      this.keys = webpush.generateVAPIDKeys();
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(this.keysFile, JSON.stringify(this.keys)); } catch (e) { console.log('No se pudieron guardar las claves push: ' + e.message); }
    }
    try { const j = JSON.parse(fs.readFileSync(this.subsFile, 'utf8')); this.subs = j.subs || []; this.estado = j.estado || {}; } catch (e) {}
    webpush.setVapidDetails(subject, this.keys.publicKey, this.keys.privateKey);
  }
  save() { try { fs.writeFileSync(this.subsFile, JSON.stringify({ subs: this.subs, estado: this.estado }, null, 1)); } catch (e) { console.log('No se pudieron guardar las suscripciones push: ' + e.message); } }
  add(sub, nombre) {
    if (!sub || !sub.endpoint || !sub.keys) throw new Error('suscripción no válida');
    this.subs = this.subs.filter(s => s.sub.endpoint !== sub.endpoint);
    this.subs.push({ sub, nombre: String(nombre || 'dispositivo').slice(0, 80), fecha: new Date().toISOString() });
    this.save(); return this.subs.length;
  }
  // Envía a todos los dispositivos; retira en silencio las suscripciones caducadas (404/410)
  async send(titulo, cuerpo) {
    if (!this.ok) return 0;
    let n = 0;
    for (const s of [...this.subs]) {
      try { await webpush.sendNotification(s.sub, JSON.stringify({ titulo, cuerpo }), { TTL: 86400 }); n++; }
      catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { this.subs = this.subs.filter(x => x !== s); this.save(); console.log('Suscripción push caducada retirada (' + s.nombre + ')'); }
        else console.log('Push fallido (' + s.nombre + '): ' + (e.statusCode || e.message));
      }
    }
    return n;
  }
}

module.exports = { Push };
