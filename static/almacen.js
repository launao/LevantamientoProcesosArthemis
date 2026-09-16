/* ═══════════════════════════════════════════════════════════════
   almacen.js — Nada se pierde.

   Todo lo que se captura (foto, audio, respuestas escritas) se escribe
   PRIMERO en IndexedDB y solo después se intenta enviar al servidor.
   Si no hay señal, si el servidor falla o si se cierra el navegador a
   media subida, el elemento sigue en la cola y se reintenta solo:
   al recuperar conexión, cada 15 segundos, y al volver a abrir la app.

   El servidor deduplica por hash, así que reintentar nunca duplica nada.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const Almacen = (() => {
  const DB_NOMBRE = 'levantamiento';
  const DB_VERSION = 1;
  let _db = null;
  const oyentes = [];
  let procesando = false;
  let backoff = 0;

  /* ── Apertura ──────────────────────────────────────────────── */
  function abrir() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NOMBRE, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('cola')) {
          const s = db.createObjectStore('cola', { keyPath: 'id', autoIncrement: true });
          s.createIndex('procesoId', 'procesoId');
        }
        if (!db.objectStoreNames.contains('borradores')) {
          db.createObjectStore('borradores', { keyPath: 'procesoId' });
        }
        if (!db.objectStoreNames.contains('grabacion')) {
          db.createObjectStore('grabacion', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => { _db = req.result; res(_db); };
      req.onerror = () => rej(req.error);
    });
  }

  function tx(store, modo, fn) {
    return abrir().then(db => new Promise((res, rej) => {
      const t = db.transaction(store, modo);
      const s = t.objectStore(store);
      let salida;
      try { salida = fn(s); } catch (e) { rej(e); return; }
      t.oncomplete = () => res(salida && salida.result !== undefined ? salida.result : salida);
      t.onerror = () => rej(t.error);
    }));
  }

  const pedir = req => new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

  /* ── Cola de subidas ───────────────────────────────────────── */

  /**
   * Encola un archivo. Devuelve el registro guardado, con id local, para
   * poder pintarlo de inmediato aunque todavía no haya salido al servidor.
   */
  async function encolarArchivo(item) {
    const db = await abrir();
    const registro = Object.assign({
      creado: Date.now(), intentos: 0, ultimoError: null
    }, item);
    const id = await new Promise((res, rej) => {
      const t = db.transaction('cola', 'readwrite');
      const r = t.objectStore('cola').add(registro);
      r.onsuccess = () => res(r.result);
      t.onerror = () => rej(t.error);
    });
    registro.id = id;
    avisar();
    procesar();
    return registro;
  }

  async function pendientes(procesoId) {
    const db = await abrir();
    return new Promise((res, rej) => {
      const t = db.transaction('cola', 'readonly');
      const r = t.objectStore('cola').getAll();
      r.onsuccess = () => res(procesoId ? r.result.filter(x => x.procesoId === procesoId) : r.result);
      t.onerror = () => rej(t.error);
    });
  }

  async function contar() {
    return (await pendientes()).length;
  }

  async function quitar(id) {
    const db = await abrir();
    await new Promise((res, rej) => {
      const t = db.transaction('cola', 'readwrite');
      t.objectStore('cola').delete(id);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
    avisar();
  }

  async function marcarFallo(item, mensaje) {
    const db = await abrir();
    await new Promise((res, rej) => {
      const t = db.transaction('cola', 'readwrite');
      item.intentos = (item.intentos || 0) + 1;
      item.ultimoError = String(mensaje || '').slice(0, 200);
      t.objectStore('cola').put(item);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }

  /**
   * Intenta vaciar la cola. Se puede llamar tantas veces como se quiera:
   * si ya hay un ciclo en curso, no hace nada.
   */
  async function procesar() {
    if (procesando || !navigator.onLine) return;
    procesando = true;
    try {
      const items = await pendientes();
      for (const item of items) {
        // Errores permanentes (formato rechazado, proceso borrado): no se reintenta
        // eternamente; tras 6 intentos queda marcado para revisión manual.
        if (item.intentos >= 6) continue;
        try {
          const fd = new FormData();
          fd.append('archivo', item.blob, item.nombre || 'archivo');
          Object.entries(item.campos || {}).forEach(([k, v]) => fd.append(k, v));
          const r = await fetch(item.url, {
            method: 'POST', body: fd, credentials: 'same-origin'
          });
          if (r.ok) {
            const d = await r.json().catch(() => ({}));
            await quitar(item.id);
            avisar({ subido: item, respuesta: d });
            backoff = 0;
            continue;
          }
          if (r.status === 401 || r.status === 410) {
            await marcarFallo(item, 'sesion_o_enlace_vencido');
            avisar({ requiereAtencion: true });
            break;
          }
          if (r.status === 413 || r.status === 415) {
            // El archivo nunca va a pasar: se marca al tope para que no bloquee.
            item.intentos = 6;
            await marcarFallo(item, 'archivo_rechazado');
            continue;
          }
          await marcarFallo(item, 'http_' + r.status);
        } catch (e) {
          await marcarFallo(item, e.message);
          backoff = Math.min((backoff || 1) * 2, 60);
          break;   // sin red: no tiene sentido seguir con el resto ahora
        }
      }
    } finally {
      procesando = false;
      avisar();
    }
  }

  /* ── Borradores de texto ───────────────────────────────────── */

  async function guardarBorrador(procesoId, datos) {
    const db = await abrir();
    return new Promise((res, rej) => {
      const t = db.transaction('borradores', 'readwrite');
      t.objectStore('borradores').put({ procesoId, datos, ts: Date.now() });
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }

  async function leerBorrador(procesoId) {
    const db = await abrir();
    return new Promise((res, rej) => {
      const t = db.transaction('borradores', 'readonly');
      const r = t.objectStore('borradores').get(procesoId);
      r.onsuccess = () => res(r.result || null);
      t.onerror = () => rej(t.error);
    });
  }

  async function borrarBorrador(procesoId) {
    const db = await abrir();
    return new Promise((res, rej) => {
      const t = db.transaction('borradores', 'readwrite');
      t.objectStore('borradores').delete(procesoId);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }

  /* ── Grabación en curso ────────────────────────────────────── */
  /* Los trozos de audio se van escribiendo mientras se graba. Si el
     navegador se cierra a mitad, al volver a abrir se recupera lo grabado. */

  /** Guarda UN trozo. Cada uno es un registro aparte, así una grabación
      de media hora no obliga a reescribir media hora de audio cada vez. */
  async function guardarTrozo(grupo, meta, trozo, n) {
    const db = await abrir();
    return new Promise((res, rej) => {
      const t = db.transaction('grabacion', 'readwrite');
      t.objectStore('grabacion').put(Object.assign(
        { id: grupo + '#' + String(n).padStart(5, '0'), grupo, trozo, n, ts: Date.now() }, meta));
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }

  /** Devuelve las grabaciones interrumpidas, ya rearmadas en orden. */
  async function recuperarGrabaciones() {
    const db = await abrir();
    const filas = await new Promise((res, rej) => {
      const t = db.transaction('grabacion', 'readonly');
      const r = t.objectStore('grabacion').getAll();
      r.onsuccess = () => res(r.result || []);
      t.onerror = () => rej(t.error);
    });
    const grupos = {};
    filas.forEach(f => {
      const g = f.grupo || f.id;
      if (!grupos[g]) grupos[g] = Object.assign({}, f, { id: g, trozos: [] });
      if (f.trozo) grupos[g].trozos.push({ n: f.n || 0, b: f.trozo });
      if (Array.isArray(f.trozos)) f.trozos.forEach((b, i) => grupos[g].trozos.push({ n: i, b }));
      grupos[g].duracion = Math.max(grupos[g].duracion || 0, f.duracion || 0);
    });
    return Object.values(grupos).map(g => {
      g.trozos = g.trozos.sort((a, b) => a.n - b.n).map(x => x.b);
      return g;
    }).filter(g => g.trozos.length);
  }

  async function borrarGrabacion(grupo) {
    const db = await abrir();
    const filas = await new Promise((res, rej) => {
      const t = db.transaction('grabacion', 'readonly');
      const r = t.objectStore('grabacion').getAll();
      r.onsuccess = () => res(r.result || []);
      t.onerror = () => rej(t.error);
    });
    const ids = filas.filter(f => (f.grupo || f.id) === grupo).map(f => f.id);
    return new Promise((res, rej) => {
      const t = db.transaction('grabacion', 'readwrite');
      ids.forEach(id => t.objectStore('grabacion').delete(id));
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }

  /* ── Eventos ───────────────────────────────────────────────── */
  function alCambiar(fn) { oyentes.push(fn); }
  function avisar(detalle) {
    contar().then(n => oyentes.forEach(fn => {
      try { fn(n, detalle); } catch (_) {}
    }));
  }

  /* ── Reintentos automáticos ────────────────────────────────── */
  window.addEventListener('online', () => { backoff = 0; procesar(); });
  setInterval(() => procesar(), 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) procesar(); });

  return {
    encolarArchivo, pendientes, contar, quitar, procesar, alCambiar,
    guardarBorrador, leerBorrador, borrarBorrador,
    guardarTrozo, recuperarGrabaciones, borrarGrabacion
  };
})();
