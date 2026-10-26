// Pedidos de la tienda (Shopify -> almacén Coinnecta). Las actualizaciones llegan por
// el webhook de Coinnecta (POST /webhook/coinnecta?clave=...) y se guardan aquí.
// La "clave" se genera una vez y persiste: es el secreto que va en la URL del webhook.
const fs = require('fs');
const crypto = require('crypto');

const MAX_PEDIDOS = 300;
const MAX_EVENTOS = 30;

class Pedidos {
  constructor(file) {
    this.file = file;
    this.data = { clave: '', pedidos: {} };
    try { this.data = Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) {}
    if (!this.data.clave) { this.data.clave = crypto.randomBytes(12).toString('hex'); this.save(); }
  }
  save() { try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch (e) {} }

  // Registra un evento del webhook de Coinnecta. Devuelve { ped, ev } para componer el aviso.
  evento(p) {
    const id = String(p.order_id || '').trim();
    if (!id) throw new Error('order_id vacío');
    const ped = this.data.pedidos[id] || (this.data.pedidos[id] = { order_id: id, eventos: [] });
    if (p.shopify_order_id) ped.shopify_order_id = String(p.shopify_order_id);
    if (p.total) ped.total = String(p.total);
    if (p.shipping_company) ped.transportista = String(p.shipping_company);
    const ev = {
      fecha: String(p.event_date || new Date().toISOString()),
      estado: String(p.status_name || p.status_id || 'actualizado'),
      detalles: String(p.details || ''),
      seguimiento: String(p.tracking_code || ''),
      url: p.tracking_url ? String(p.tracking_url) : '',
    };
    ped.eventos.push(ev);
    if (ped.eventos.length > MAX_EVENTOS) ped.eventos.splice(0, ped.eventos.length - MAX_EVENTOS);
    this.prune();
    this.save();
    return { ped, ev };
  }
  prune() {
    const ids = Object.keys(this.data.pedidos);
    if (ids.length <= MAX_PEDIDOS) return;
    ids.sort((a, b) => this.ultimaFecha(a).localeCompare(this.ultimaFecha(b)));
    for (const id of ids.slice(0, ids.length - MAX_PEDIDOS)) delete this.data.pedidos[id];
  }
  ultimaFecha(id) { const e = this.data.pedidos[id].eventos; return e.length ? e[e.length - 1].fecha : ''; }

  nombre(ped) { return ped.shopify_order_id ? '#' + ped.shopify_order_id : 'nº ' + ped.order_id; }

  // Lista ordenada por última actualización (la más reciente primero).
  lista() {
    return Object.values(this.data.pedidos)
      .sort((a, b) => (b.eventos[b.eventos.length - 1] || {}).fecha > (a.eventos[a.eventos.length - 1] || {}).fecha ? 1 : -1)
      .map(ped => {
        const ev = ped.eventos[ped.eventos.length - 1] || {};
        return { pedido: this.nombre(ped), order_id: ped.order_id, shopify: ped.shopify_order_id || '', estado: ev.estado || '', detalles: ev.detalles || '', fecha: ev.fecha || '', transportista: ped.transportista || '', seguimiento: ev.seguimiento || '', url: ev.url || '', total: ped.total || '', eventos: ped.eventos.length };
      });
  }

  // Texto para la función de voz: todo, o filtrado por número de pedido.
  resumen(consulta, max) {
    const q = String(consulta || '').replace(/[#º]/g, '').trim().toLowerCase();
    let items = this.lista();
    if (q) items = items.filter(x => x.order_id.toLowerCase().includes(q) || x.shopify.toLowerCase().includes(q) || x.estado.toLowerCase().includes(q) || x.detalles.toLowerCase().includes(q));
    if (!items.length) return q ? 'No hay ningún pedido que encaje con "' + consulta + '".' : 'No ha llegado todavía ninguna actualización de pedidos del almacén.';
    return items.slice(0, max || 10).map(x => {
      let s = 'Pedido ' + x.pedido + ': ' + (x.estado || 'sin estado');
      if (x.detalles) s += ' (' + x.detalles + ')';
      if (x.transportista) s += ' · ' + x.transportista;
      if (x.seguimiento) s += ' · seguimiento ' + x.seguimiento;
      if (x.total) s += ' · ' + x.total + ' €';
      if (x.fecha) s += ' · ' + x.fecha.slice(0, 16).replace('T', ' ');
      return s;
    }).join('\n');
  }
}

module.exports = { Pedidos };
