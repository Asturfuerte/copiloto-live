// Service worker: recibe los avisos push de la agenda y los muestra como notificación.
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.titulo || 'Aviso', {
    body: d.cuerpo || '', icon: '/icon-192.png', badge: '/icon-192.png', lang: 'es',
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => ws.length ? ws[0].focus() : clients.openWindow('/')));
});
