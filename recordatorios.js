// Agenda / recordatorios del cliente: citas, tareas y notas que el agente guarda cuando se las mencionan.
// Se guardan en un JSON (junto a los datos persistentes) y se le recuerdan al usuario al empezar cada sesión.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TZ = process.env.TZ_CLIENTE || 'Atlantic/Canary';
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Fecha/hora local del cliente como { ymd: 'YYYY-MM-DD', hm: 'HH:MM', texto: 'miércoles 21 de octubre de 2026, 11:30' }
function ahora(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(d).map(x => [x.type, x.value]));
  const ymd = `${p.year}-${p.month}-${p.day}`;
  const dow = new Date(ymd + 'T12:00:00Z').getUTCDay();
  return { ymd, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, texto: `${DIAS[dow]} ${+p.day} de ${MESES[+p.month - 1]} de ${p.year}, ${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}
function fechaBonita(ymd) { const d = new Date(ymd + 'T12:00:00Z'); return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`; }
function diasEntre(a, b) { return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000); }
function validYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s + 'T00:00:00Z')); }
function validHm(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(s || ''); }

class Recordatorios {
  constructor(file) {
    this.file = file; this.items = [];
    try { this.items = JSON.parse(fs.readFileSync(file, 'utf8')).items || []; } catch (e) {}
  }
  save() { try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ items: this.items }, null, 1)); } catch (e) { console.log('No se pudo guardar la agenda: ' + e.message); } }

  add({ texto, fecha, hora, tipo, avisar, lugar }) {
    texto = String(texto || '').trim(); if (!texto) throw new Error('falta el texto');
    if (fecha && !validYmd(fecha)) throw new Error('fecha no válida; usa AAAA-MM-DD');
    if (hora && !validHm(hora)) throw new Error('hora no válida; usa HH:MM');
    tipo = ['cita', 'tarea', 'nota'].includes(tipo) ? tipo : (fecha ? 'cita' : 'nota');
    const it = { id: crypto.randomBytes(4).toString('hex'), texto, fecha: fecha || null, hora: hora || null, lugar: lugar ? String(lugar).trim() : null, tipo, avisar: Array.isArray(avisar) && avisar.length ? avisar.map(Number).filter(n => n >= 0) : (fecha ? [7, 2, 0] : []), hecho: false, creado: new Date().toISOString() };
    this.items.push(it); this.save(); return it;
  }
  update(id, cambios) {
    const it = this.items.find(x => x.id === id); if (!it) throw new Error('no existe');
    if (cambios.texto) it.texto = String(cambios.texto).trim();
    if (cambios.fecha !== undefined) { if (cambios.fecha && !validYmd(cambios.fecha)) throw new Error('fecha no válida'); it.fecha = cambios.fecha || null; }
    if (cambios.hora !== undefined) { if (cambios.hora && !validHm(cambios.hora)) throw new Error('hora no válida'); it.hora = cambios.hora || null; }
    if (cambios.lugar !== undefined) it.lugar = cambios.lugar || null;
    if (cambios.hecho !== undefined) it.hecho = !!cambios.hecho;
    this.save(); return it;
  }
  remove(id) { const n = this.items.length; this.items = this.items.filter(x => x.id !== id); if (this.items.length === n) throw new Error('no existe'); this.save(); }

  // Pendientes ordenados: con fecha primero (por fecha y hora), luego notas sin fecha
  pendientes(desde, hasta) {
    return this.items.filter(x => !x.hecho && (!desde || !x.fecha || x.fecha >= desde) && (!hasta || !x.fecha || x.fecha <= hasta))
      .sort((a, b) => (a.fecha || '9999') + (a.hora || '') < (b.fecha || '9999') + (b.hora || '') ? -1 : 1);
  }
  describe(it, hoy) {
    let s = `[${it.id}] ${it.tipo}: ${it.texto}`;
    if (it.fecha) { const d = diasEntre(hoy, it.fecha); s += ` — ${fechaBonita(it.fecha)}${it.hora ? ' a las ' + it.hora : ''}` + (d < 0 ? ` (hace ${-d} día${-d === 1 ? '' : 's'}, VENCIDA)` : d === 0 ? ' (HOY)' : d === 1 ? ' (mañana)' : ` (en ${d} días)`); }
    if (it.lugar) s += ` — en ${it.lugar}`;
    return s;
  }
  // Texto para las instrucciones del sistema al empezar la sesión
  // recitar=true: se pide mencionar las citas próximas al empezar. recitar=false: la lista es solo
  // referencia para responder preguntas y queda PROHIBIDO sacarla sin que pregunten.
  resumenParaSesion(recitar) {
    const n = ahora(); const items = this.pendientes();
    let out = `\n\n=== FECHA Y AGENDA ===\nAhora mismo es ${n.texto} (hora de Canarias). Usa esta fecha para interpretar "mañana", "el jueves que viene", "dentro de dos semanas", etc.\n`;
    if (!items.length) return out + 'La agenda está vacía.\n';
    const proximas = items.filter(it => it.fecha && diasEntre(n.ymd, it.fecha) <= 7);
    const resto = items.filter(it => !proximas.includes(it));
    const cabecera = recitar
      ? 'Citas vencidas o de los próximos 7 días (menciónalas brevemente UNA vez al empezar, cuando el usuario te salude o te hable por primera vez; no las repitas después salvo que pregunte):\n'
      : 'Citas vencidas o de los próximos 7 días (SOLO para consultarlas si el usuario pregunta por su agenda; NO las menciones por tu cuenta, ni al saludar ni en ningún otro momento — él ya recibe su aviso diario):\n';
    if (proximas.length) out += cabecera + proximas.map(it => '- ' + this.describe(it, n.ymd)).join('\n') + '\n';
    if (resto.length) out += `Otras pendientes (${resto.length}): ` + resto.slice(0, 15).map(it => this.describe(it, n.ymd)).join(' | ') + (resto.length > 15 ? ' | …' : '') + '\n';
    return out;
  }
  // Respuesta de la función listar
  listar(desde, hasta) {
    const n = ahora(); const items = this.pendientes(desde, hasta);
    if (!items.length) return 'No hay nada pendiente' + (desde || hasta ? ' en ese periodo' : '') + '.';
    return `Hoy es ${n.texto}.\n` + items.map(it => this.describe(it, n.ymd)).join('\n');
  }
  // Avisos que tocan hoy (para la fase de notificaciones): citas cuyo "avisar" incluye los días que faltan
  avisosDeHoy() {
    const n = ahora();
    return this.pendientes().filter(it => it.fecha && (it.avisar || []).includes(diasEntre(n.ymd, it.fecha))).map(it => ({ ...it, faltan: diasEntre(n.ymd, it.fecha) }));
  }
}

module.exports = { Recordatorios, ahora, fechaBonita, diasEntre };
