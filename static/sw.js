/* sw.js — Service worker mínimo.
   Existe para que el navegador ofrezca instalar la app y abrirla sin barra
   de direcciones. NO cachea nada: todo pasa directo a la red, para que
   nadie trabaje nunca sobre una versión vieja de la aplicación. Lo que
   debe sobrevivir sin conexión ya vive en IndexedDB (ver almacen.js). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { /* sin intervención: red directa */ });
