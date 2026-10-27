// Consultas a la tienda Shopify (API Admin) para las funciones de voz de Matilde.
// Variables de entorno:
//   SHOPIFY_SHOP          -> dominio técnico de la tienda (xxxx.myshopify.com)
//   SHOPIFY_CLIENT_ID     -> ID de cliente de la app del Dev Dashboard
//   SHOPIFY_CLIENT_SECRET -> Secreto de cliente de la app
// (Las apps nuevas del Dev Dashboard no dan un token fijo: el token se pide con el
//  ID/secreto y caduca cada 24 h, así que aquí se renueva solo. Si algún día hubiera
//  un token fijo shpat_, se puede usar SHOPIFY_TOKEN en su lugar.)
// Si faltan, las funciones de tienda no se registran y todo lo demás sigue igual.
const SHOP = process.env.SHOPIFY_SHOP || '';
const TOKEN_FIJO = process.env.SHOPIFY_TOKEN || '';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const API = '2025-07';

function enabled() { return !!(SHOP && (TOKEN_FIJO || (CLIENT_ID && CLIENT_SECRET))); }

// Token en caché; se renueva 5 minutos antes de caducar.
let cache = { token: TOKEN_FIJO, exp: TOKEN_FIJO ? Infinity : 0 };
async function getToken() {
  if (cache.token && Date.now() < cache.exp - 5 * 60 * 1000) return cache.token;
  const r = await fetch('https://' + SHOP + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!r.ok) throw new Error('Shopify no dio token (' + r.status + '); revisa SHOPIFY_CLIENT_ID y SHOPIFY_CLIENT_SECRET');
  const j = await r.json();
  if (!j.access_token) throw new Error('Shopify no dio token; revisa las credenciales');
  cache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
  console.log('Token de Shopify renovado (caduca en ' + Math.round((Number(j.expires_in) || 86400) / 3600) + ' h)');
  return cache.token;
}

async function api(ruta) {
  const url = 'https://' + SHOP + '/admin/api/' + API + ruta;
  let r = await fetch(url, { headers: { 'X-Shopify-Access-Token': await getToken() } });
  if ((r.status === 401 || r.status === 403) && CLIENT_ID && !TOKEN_FIJO) { // token caducado antes de tiempo: renovar y reintentar una vez
    cache.exp = 0;
    r = await fetch(url, { headers: { 'X-Shopify-Access-Token': await getToken() } });
  }
  if (r.status === 401 || r.status === 403) throw new Error('Shopify rechazó el acceso (revisa las credenciales y los permisos de la app)');
  if (!r.ok) throw new Error('Shopify respondió ' + r.status);
  return r.json();
}

const eur = x => (Math.round(Number(x || 0) * 100) / 100).toLocaleString('es-ES', { minimumFractionDigits: 2 }) + ' €';
const PAGO = { paid: 'pagado', pending: 'pendiente de pago', partially_paid: 'pago parcial', refunded: 'reembolsado', partially_refunded: 'reembolso parcial', voided: 'anulado', authorized: 'autorizado' };
const ENVIO = { fulfilled: 'enviado', partial: 'envío parcial', restocked: 'devuelto a stock' };
const estadoPago = o => PAGO[o.financial_status] || o.financial_status || '';
const estadoEnvio = o => ENVIO[o.fulfillment_status] || (o.fulfillment_status ? o.fulfillment_status : 'sin enviar');

// Ventas entre dos fechas (AAAA-MM-DD, incluidas). Devuelve texto para la voz.
async function ventas(desde, hasta) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '')) throw new Error('Falta la fecha "desde" (AAAA-MM-DD)');
  const h = /^\d{4}-\d{2}-\d{2}$/.test(hasta || '') ? hasta : desde;
  const j = await api('/orders.json?status=any&limit=250&created_at_min=' + desde + 'T00:00:00Z&created_at_max=' + h + 'T23:59:59Z&fields=name,total_price,created_at,financial_status,fulfillment_status,cancelled_at');
  const todos = j.orders || [];
  const pedidos = todos.filter(o => !o.cancelled_at);
  const cancelados = todos.length - pedidos.length;
  if (!pedidos.length) return 'Ningún pedido entre ' + desde + ' y ' + h + (cancelados ? ' (' + cancelados + ' cancelado' + (cancelados > 1 ? 's' : '') + ')' : '') + '.';
  const total = pedidos.reduce((a, o) => a + Number(o.total_price || 0), 0);
  const sinEnviar = pedidos.filter(o => !o.fulfillment_status).length;
  let s = pedidos.length + ' pedido' + (pedidos.length > 1 ? 's' : '') + ' por ' + eur(total) + (desde === h ? ' el ' + desde : ' entre ' + desde + ' y ' + h) + '.';
  if (sinEnviar) s += ' ' + sinEnviar + ' sin enviar todavía.';
  if (cancelados) s += ' ' + cancelados + ' cancelado' + (cancelados > 1 ? 's' : '') + ' aparte.';
  s += '\nÚltimos: ' + pedidos.slice(0, 8).map(o => o.name + ' (' + eur(o.total_price) + ', ' + estadoPago(o) + ', ' + estadoEnvio(o) + ')').join('; ');
  if (todos.length === 250) s += '\n(Hay más de 250; el total es parcial.)';
  return s;
}

// El stock solo cuenta si la tienda lo gestiona: en dropshipping los productos van sin
// seguimiento (inventory_management vacío) y Shopify marca 0, pero NO están agotados.
const stockGestionado = v => !!v.inventory_management;
const stockTexto = v => stockGestionado(v) ? ', stock ' + v.inventory_quantity : ', stock a cargo del almacén';

// Busca productos por nombre y devuelve precio y stock por variante.
async function producto(nombre) {
  const q = String(nombre || '').trim().toLowerCase();
  if (!q) throw new Error('Falta el nombre del producto');
  const j = await api('/products.json?limit=250&fields=title,status,variants');
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const hits = (j.products || []).filter(p => norm(p.title).includes(norm(q)));
  if (!hits.length) return 'No encuentro ningún producto que se llame "' + nombre + '" en la tienda.';
  return hits.slice(0, 5).map(p => {
    const vs = (p.variants || []).map(v => (v.title && v.title !== 'Default Title' ? v.title + ': ' : '') + eur(v.price) + stockTexto(v)).join(' · ');
    return p.title + (p.status !== 'active' ? ' [' + p.status + ']' : '') + ' — ' + vs;
  }).join('\n') + (hits.length > 5 ? '\n(y ' + (hits.length - 5) + ' más)' : '');
}

// Estado de un pedido por su número ("1042" o "#1042").
async function pedido(numero) {
  const n = String(numero || '').replace(/[#º\s]/g, '');
  if (!n) throw new Error('Falta el número de pedido');
  const j = await api('/orders.json?status=any&name=%23' + encodeURIComponent(n) + '&fields=name,created_at,total_price,financial_status,fulfillment_status,cancelled_at,fulfillments');
  const o = (j.orders || [])[0];
  if (!o) return 'No encuentro el pedido ' + numero + ' en la tienda.';
  let s = 'Pedido ' + o.name + ' (' + String(o.created_at).slice(0, 10) + '): ' + eur(o.total_price) + ', ' + estadoPago(o) + ', ' + (o.cancelled_at ? 'CANCELADO' : estadoEnvio(o)) + '.';
  const f = (o.fulfillments || []).filter(x => x.tracking_number);
  if (f.length) s += ' Seguimiento: ' + f.map(x => (x.tracking_company ? x.tracking_company + ' ' : '') + x.tracking_number).join('; ') + '.';
  return s;
}

// Resumen del catálogo: cuántos productos hay y cuáles están activos.
async function catalogo() {
  const j = await api('/products.json?limit=250&fields=title,status,variants');
  const ps = j.products || [];
  if (!ps.length) return 'La tienda no tiene todavía ningún producto.';
  const act = ps.filter(p => p.status === 'active'), borr = ps.filter(p => p.status === 'draft'), arch = ps.filter(p => p.status === 'archived');
  // Solo es "sin stock" si la tienda gestiona el inventario del producto y está a cero; sin seguimiento = lo lleva el almacén.
  const sinStock = act.filter(p => (p.variants || []).length && (p.variants || []).every(v => stockGestionado(v) && v.inventory_quantity <= 0));
  const sinSeguimiento = act.filter(p => (p.variants || []).every(v => !stockGestionado(v)));
  let s = 'Catálogo de la tienda: ' + ps.length + ' producto' + (ps.length > 1 ? 's' : '') + ' — ' + act.length + ' activos, ' + borr.length + ' en borrador, ' + arch.length + ' archivados.';
  if (sinStock.length) s += ' OJO: ' + sinStock.length + ' activo' + (sinStock.length > 1 ? 's' : '') + ' sin stock (' + sinStock.slice(0, 10).map(p => p.title).join('; ') + ').';
  if (sinSeguimiento.length === act.length && act.length) s += ' El stock no se controla en la tienda: lo gestiona el almacén del proveedor, como corresponde al dropshipping.';
  if (act.length) s += '\nActivos: ' + act.slice(0, 40).map(p => p.title).join('; ') + (act.length > 40 ? ' (y ' + (act.length - 40) + ' más)' : '');
  if (ps.length === 250) s += '\n(Hay más de 250 productos; el recuento es parcial.)';
  return s;
}

// Pedidos de la tienda pendientes de enviar (para completar estado_pedidos).
async function pendientes() {
  const j = await api('/orders.json?status=open&fulfillment_status=unfulfilled&limit=50&fields=name,created_at,total_price,financial_status,cancelled_at');
  const os = (j.orders || []).filter(o => !o.cancelled_at);
  if (!os.length) return 'En la tienda no hay ningún pedido pendiente de enviar.';
  return 'Pendientes de enviar según la tienda: ' + os.map(o => o.name + ' (' + String(o.created_at).slice(0, 10) + ', ' + eur(o.total_price) + ', ' + estadoPago(o) + ')').join('; ') + '.';
}

const TOOL = {
  functionDeclarations: [
    { name: 'ventas_tienda', description: 'Ventas de la tienda online entre dos fechas: número de pedidos, importe total y últimos pedidos con su estado. Úsala cuando pregunten cuánto se ha vendido, cuántos pedidos hay hoy/esta semana/este mes, o cómo va la tienda. Calcula las fechas con la fecha de hoy de tus instrucciones.',
      parameters: { type: 'OBJECT', properties: { desde: { type: 'STRING', description: 'AAAA-MM-DD' }, hasta: { type: 'STRING', description: 'AAAA-MM-DD (opcional; sin él, solo el día "desde")' } }, required: ['desde'] } },
    { name: 'buscar_producto', description: 'Busca un producto de la tienda por nombre y devuelve su precio y el stock de cada variante (talla, color). Úsala cuando pregunten por el precio o el stock de un producto.',
      parameters: { type: 'OBJECT', properties: { nombre: { type: 'STRING', description: 'Nombre o parte del nombre del producto.' } }, required: ['nombre'] } },
    { name: 'catalogo_tienda', description: 'Resumen del catálogo de la tienda: cuántos productos hay (activos, en borrador, archivados), cuáles son los activos y si alguno está sin stock. Úsala cuando pregunten cuántos productos o artículos tiene la tienda, qué se vende, o qué hay publicado.',
      parameters: { type: 'OBJECT', properties: {} } },
    { name: 'pedido_tienda', description: 'Estado de un pedido concreto de la tienda por su número: pago, envío y seguimiento. Para el aviso del almacén usa estado_pedidos; esta da la vista de la tienda (Shopify).',
      parameters: { type: 'OBJECT', properties: { numero: { type: 'STRING', description: 'Número del pedido, p. ej. "1042".' } }, required: ['numero'] } },
  ],
};
const RULES = `

=== TIENDA ONLINE (Shopify) ===
Tienes acceso directo a la tienda con ventas_tienda (ventas y pedidos entre fechas), buscar_producto (precio y stock de un producto), catalogo_tienda (cuántos productos hay y cuáles están activos) y pedido_tienda (estado de un pedido en la tienda). Para "¿cómo van los pedidos?" en general usa estado_pedidos (avisos del almacén); para cifras de ventas, stock o un pedido concreto usa estas. Llama a la función antes de responder y di las cifras en lenguaje natural, sin inventar nada.`;

async function llamar(nombre, args) {
  const a = args || {};
  if (nombre === 'ventas_tienda') return ventas(a.desde, a.hasta);
  if (nombre === 'buscar_producto') return producto(a.nombre);
  if (nombre === 'catalogo_tienda') return catalogo();
  if (nombre === 'pedido_tienda') return pedido(a.numero);
  throw new Error('Función desconocida');
}

module.exports = { enabled, llamar, pendientes, TOOL, RULES };
