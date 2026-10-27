// Service worker: recibe los avisos push (agenda y pedidos) y los muestra como notificación.
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.titulo || 'Aviso', {
    body: d.cuerpo || '', icon: '/icon-192.png', badge: '/icon-192.png', lang: 'es',
    data: { url: d.url || '' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '';
  // Con url (p. ej. el panel del almacén para confirmar un pedido) se abre esa página; si no, la app.
  e.waitUntil(url ? clients.openWindow(url)
    : clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => ws.length ? ws[0].focus() : clients.openWindow('/')));
});
