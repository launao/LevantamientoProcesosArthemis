/* ═══════════════════════════════════════════════════════════════
   captura.js — Página que se abre en el celular desde el QR.

   Dos decisiones de diseño que importan:

   1. La lista muestra lo que hay EN EL SERVIDOR, más lo que sigue en
      cola. No lo que el navegador recuerda. En iPhone, abrir la cámara
      suele hacer que Safari descargue la página de memoria; si la
      lista dependiera de una variable, se vería vacía después de cada
      foto aunque todo estuviera bien guardado.

   2. El campo de archivo vive en el DOM antes de abrirse. Uno creado
      al vuelo y nunca insertado se pierde cuando Safari recicla la
      página mientras la cámara está abierta, y la foto desaparece sin
      un solo mensaje de error.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const T = window.CAPTURE_TOKEN;
const URL_SUBIDA = '/api/capture/' + T + '/evidencias';

const C = {
  info: null, error: null, campo: '',
  rec: null, recT: 0, recTimer: null, recId: null, trozos: [], nTrozo: 0, wake: null,
  pendientes: [], aviso: null
};

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

/* ── Arranque ─────────────────────────────────────────────────── */
init();

async function init() {
  try {
    C.info = await pedirInfo();
    if (!C.info) return pintar();
    // No se elige por defecto la primera pregunta: así nadie sube veinte
    // fotos a “Objetivo del proceso” sin darse cuenta. Se recuerda la
    // última usada en este proceso, que es lo que normalmente se quiere.
    let recordado = '';
    try { recordado = localStorage.getItem('lp_campo_' + C.info.proceso.id) || ''; } catch (_) {}
    const existe = C.info.campos.some(x => x.id === recordado);
    C.campo = C.info.campoFijo || (existe ? recordado : '');
    await recuperarGrabaciones();
    await leerPendientes();
    pintar();
    Almacen.procesar();
  } catch (e) {
    C.error = 'No se pudo abrir el enlace: ' + (e.message || e);
    pintar();
  }
}

async function pedirInfo() {
  const r = await fetch('/api/capture/' + T, { cache: 'no-store' });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    C.error = d.error === 'enlace_vencido'
      ? 'Este enlace ya venció. Pide uno nuevo desde el computador.'
      : 'No se pudo abrir el enlace.';
    return null;
  }
  return r.json();
}

/** Trae del servidor lo que realmente quedó guardado y repinta. */
async function refrescar() {
  try {
    const info = await pedirInfo();
    if (info) {
      const campoActual = C.campo;
      C.info = info;
      C.campo = campoActual || info.campoFijo || '';
    }
  } catch (_) { /* sin red: se queda con lo que tenía */ }
  await leerPendientes();
  pintarLista();
  pintarEstado();
}

async function leerPendientes() {
  try {
    const todas = await Almacen.pendientes();
    C.pendientes = todas.filter(x => x.url === URL_SUBIDA);
  } catch (_) { C.pendientes = []; }
}

/** Grabaciones que quedaron a medias por un cierre inesperado. */
async function recuperarGrabaciones() {
  try {
    const gs = await Almacen.recuperarGrabaciones();
    for (const g of gs) {
      if (g.token !== T || !g.trozos || !g.trozos.length) continue;
      const blob = new Blob(g.trozos, { type: g.tipo || 'audio/webm' });
      await encolar(blob, 'audio', g.campo || C.campo, g.nombre || 'nota.webm', g.duracion || 0, true);
      await Almacen.borrarGrabacion(g.id);
      avisar('Se recuperó una grabación interrumpida.', 'ok');
    }
  } catch (_) {}
}

/* Cada vez que la cola confirma una subida, se relee del servidor. */
Almacen.alCambiar(async (n, detalle) => {
  if (!C.info) return;
  if (detalle && detalle.subido) await refrescar();
  else { await leerPendientes(); pintarEstado(); pintarLista(); }
});

/* ── Render ───────────────────────────────────────────────────── */
function pintar() {
  const cap = document.getElementById('cap');

  if (C.error) {
    cap.innerHTML = `<div class="empty" style="padding-top:90px"><span class="e">⚠</span>${esc(C.error)}</div>`;
    return;
  }
  if (!C.info) return;

  const p = C.info.proceso;
  const fijo = !!C.info.campoFijo;
  const campoNombre = (C.info.campos.find(c => c.id === C.campo) || {}).etiqueta || 'General';

  cap.innerHTML = `
  <header>
    <h1>${esc(p.nombre)}</h1>
    <div class="meta">${esc(p.codigo || '')}${p.area ? ' · ' + esc(p.area) : ''}</div>
  </header>

  <div id="estado"></div>

  <div class="card" style="margin-bottom:14px">
    <span class="lbl">¿A qué pregunta corresponde?</span>
    ${fijo
      ? `<div class="chip" style="margin-top:4px">${esc(campoNombre)}</div>
         <div class="tiny" style="margin-top:6px">Fijado desde el computador.</div>`
      : `<select id="selCampo" class="${C.campo ? '' : 'pendiente'}">
          <option value="">— Elige la pregunta —</option>
          ${C.info.campos.map(c =>
            `<option value="${c.id}" ${c.id === C.campo ? 'selected' : ''}>${esc(c.seccion)} · ${esc(c.etiqueta)}</option>`).join('')}
         </select>
         <div class="tiny" style="margin-top:6px">Todo lo que captures se guarda en la pregunta que elijas aquí. Puedes cambiarla entre una foto y otra.</div>`}
  </div>

  <div class="card" style="margin-bottom:14px">
    <span class="lbl">Nota escrita (opcional)</span>
    <textarea id="nota" placeholder="Qué se ve en la foto, quién lo dijo, dónde fue…" style="min-height:70px"></textarea>
    <div class="flex" style="margin-top:8px;gap:8px">
      <button class="btn" id="bNota">Guardar solo la nota</button>
      <span class="tiny" style="flex:1">O déjala escrita y se adjunta a la siguiente foto o audio.</span>
    </div>
  </div>

  <div class="flex" style="margin:18px 0 10px">
    <h3 style="font-size:14px;margin:0;flex:1">Guardado en el proceso</h3>
    <button class="btn sm" id="bRefrescar" title="Actualizar">↻ Actualizar</button>
  </div>
  <div id="lista"></div>

  <input type="file" id="inpFoto" accept="image/*" capture="environment"
         style="position:absolute;width:1px;height:1px;opacity:0">
  <input type="file" id="inpGaleria" accept="image/*" multiple
         style="position:absolute;width:1px;height:1px;opacity:0">

  <div class="acciones">
    <button class="btn p" id="bFoto"><span class="ico">📷</span><span>Tomar foto</span></button>
    <button class="btn" id="bGaleria"><span class="ico">🖼</span><span>Galería</span></button>
    <button class="btn" id="bVoz"><span class="ico">🎙</span><span>Grabar voz</span></button>
  </div>`;

  const sc = document.getElementById('selCampo');
  if (sc) sc.onchange = () => {
    C.campo = sc.value;
    sc.classList.toggle('pendiente', !C.campo);
    try { localStorage.setItem('lp_campo_' + C.info.proceso.id, C.campo); } catch (_) {}
    pintarLista();
  };

  const inpFoto = document.getElementById('inpFoto');
  const inpGal = document.getElementById('inpGaleria');
  inpFoto.onchange = () => recibirImagenes(inpFoto);
  inpGal.onchange = () => recibirImagenes(inpGal);

  const exigeCampo = accion => () => {
    if (!C.campo) {
      avisar('Primero elige a qué pregunta corresponde.', 'bad');
      const sel = document.getElementById('selCampo');
      if (sel) { sel.focus(); sel.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      return;
    }
    accion();
  };
  document.getElementById('bFoto').onclick = exigeCampo(() => inpFoto.click());
  document.getElementById('bGaleria').onclick = exigeCampo(() => inpGal.click());
  document.getElementById('bVoz').onclick = exigeCampo(grabar);
  document.getElementById('bNota').onclick = guardarNota;
  document.getElementById('bRefrescar').onclick = refrescar;

  pintarEstado();
  pintarLista();
}

function avisar(texto, clase) {
  C.aviso = { texto, clase: clase || '' };
  pintarEstado();
  setTimeout(() => {
    if (C.aviso && C.aviso.texto === texto) { C.aviso = null; pintarEstado(); }
  }, 6000);
}

function pintarEstado() {
  const el = document.getElementById('estado');
  if (!el) return;

  if (C.aviso) {
    el.innerHTML = `<div class="aviso ${C.aviso.clase}">${esc(C.aviso.texto)}</div>`;
    return;
  }
  const n = C.pendientes.length;
  const guardadas = (C.info && C.info.evidencias) ? C.info.evidencias.length : 0;

  if (!navigator.onLine) {
    el.innerHTML = `<div class="aviso warn"><b>Sin señal.</b> Sigue capturando: ${n} archivo(s) esperando. Se suben solos cuando vuelva la conexión.</div>`;
  } else if (n > 0) {
    el.innerHTML = `<div class="aviso warn">Subiendo ${n} archivo(s)…</div>`;
  } else if (guardadas) {
    el.innerHTML = `<div class="aviso ok">${guardadas} archivo(s) guardados en el proceso. Puedes cerrar.</div>`;
  } else {
    el.innerHTML = `<div class="aviso">Lo que captures aquí entra directo al proceso. Cierra cuando termines.</div>`;
  }
}

function pintarLista() {
  const el = document.getElementById('lista');
  if (!el) return;

  const guardadas = (C.info && C.info.evidencias) ? C.info.evidencias : [];
  if (!guardadas.length && !C.pendientes.length) {
    el.innerHTML = '<div class="mut" style="padding:8px 0">Todavía no hay nada guardado en este proceso.</div>';
    return;
  }

  const nombre = id => (C.info.campos.find(x => x.id === id) || {}).etiqueta || 'Sin pregunta';
  const deEste = C.campo ? guardadas.filter(x => x.campo === C.campo) : guardadas;
  const fotos = deEste.filter(x => x.tipo === 'foto');
  const audios = deEste.filter(x => x.tipo === 'audio');
  const notas = deEste.filter(x => x.tipo === 'nota');

  el.innerHTML =
    (C.campo ? `<div class="tiny" style="margin-bottom:10px">En «${esc(nombre(C.campo))}»: ${deEste.length} · en todo el proceso: ${guardadas.length}</div>` : '') +
    (C.pendientes.length
      ? `<div class="mut" style="margin-bottom:10px">⇡ ${C.pendientes.length} esperando subir</div>` : '') +
    (fotos.length
      ? `<div class="galeria" style="margin-bottom:12px">${fotos.map(f =>
          `<div class="item"><img src="/c/${T}/media/${f.mediaId}" alt="foto" loading="lazy">
            <span class="badge">✓</span></div>`).join('')}</div>` : '') +
    audios.map(a =>
      `<div class="audio-item"><span>✓</span>
        <audio controls preload="none" src="/c/${T}/media/${a.mediaId}"></audio>
        <span class="tiny">${mmss(a.duracion || 0)}</span></div>`).join('') +
    notas.map(n =>
      `<div class="audio-item" style="align-items:flex-start"><span>✓</span>
        <div style="flex:1;font-size:13.5px;white-space:pre-wrap">${esc(n.nota)}</div></div>`).join('');
}

/* ── Captura de imágenes ──────────────────────────────────────── */

async function recibirImagenes(inp) {
  const archivos = Array.from(inp.files || []);
  inp.value = '';                       // permite volver a elegir la misma foto
  if (!archivos.length) return;

  avisar('Procesando…', 'warn');
  for (const f of archivos) {
    try {
      const b = await comprimir(f);
      await encolar(b, 'foto', C.campo, 'foto.jpg', 0);
    } catch (e) {
      avisar('No se pudo procesar la foto: ' + (e.message || e), 'bad');
    }
  }
}

async function encolar(blob, tipo, campo, nombre, duracion, silencioso) {
  const notaEl = document.getElementById('nota');
  const nota = notaEl ? notaEl.value : '';
  try {
    await Almacen.encolarArchivo({
      url: URL_SUBIDA, procesoId: C.info.proceso.id, blob, nombre,
      campos: { tipo, campo: campo || '', nota, duracion: String(duracion || 0) }
    });
    if (notaEl && !silencioso) notaEl.value = '';
    await leerPendientes();
    pintarEstado();
    pintarLista();
  } catch (e) {
    // Si IndexedDB no está disponible (navegación privada en iOS), se sube
    // directo: menos protegido ante cortes, pero mejor que perder el archivo.
    await subirDirecto(blob, tipo, campo, nombre, duracion, nota);
    if (notaEl && !silencioso) notaEl.value = '';
  }
}

async function subirDirecto(blob, tipo, campo, nombre, duracion, nota) {
  const fd = new FormData();
  fd.append('archivo', blob, nombre);
  fd.append('tipo', tipo);
  fd.append('campo', campo || '');
  fd.append('nota', nota || '');
  fd.append('duracion', String(duracion || 0));
  try {
    const r = await fetch(URL_SUBIDA, { method: 'POST', body: fd });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      avisar(mensajeError(d.error), 'bad');
      return;
    }
    await refrescar();
    avisar('Guardado.', 'ok');
  } catch (_) {
    avisar('Sin conexión. Intenta de nuevo cuando tengas señal.', 'bad');
  }
}

function mensajeError(codigo) {
  return {
    archivo_muy_grande: 'El archivo pesa demasiado.',
    tipo_no_permitido: 'Ese formato de imagen no se acepta.',
    enlace_vencido: 'El enlace venció. Pide uno nuevo.',
    archivo_vacio: 'El archivo llegó vacío.'
  }[codigo] || 'No se pudo subir el archivo.';
}

function comprimir(file, max = 1800, q = 0.85) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          if (!w || !h) return rej(new Error('imagen sin dimensiones'));
          if (Math.max(w, h) > max) {
            const s = max / Math.max(w, h);
            w = Math.round(w * s); h = Math.round(h * s);
          }
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          cv.toBlob(b => b ? res(b) : rej(new Error('no se pudo convertir')), 'image/jpeg', q);
        } catch (e) { rej(e); }
      };
      img.onerror = () => rej(new Error('formato no soportado'));
      img.src = fr.result;
    };
    fr.onerror = () => rej(new Error('no se pudo leer el archivo'));
    fr.readAsDataURL(file);
  });
}

/** Guarda la nota escrita sin necesidad de adjuntarla a nada. */
async function guardarNota() {
  const el = document.getElementById('nota');
  const texto = (el.value || '').trim();
  if (!texto) { avisar('Escribe algo primero.', 'warn'); return; }

  const btn = document.getElementById('bNota');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const r = await fetch('/api/capture/' + T + '/nota', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nota: texto, campo: C.campo })
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      avisar(mensajeError(d.error), 'bad');
    } else {
      el.value = '';
      await refrescar();
      avisar('Nota guardada en el proceso.', 'ok');
    }
  } catch (_) {
    avisar('Sin conexión. La nota no se guardó: vuelve a intentarlo.', 'bad');
  }
  btn.disabled = false; btn.textContent = 'Guardar solo la nota';
}

/* ── Voz ──────────────────────────────────────────────────────── */
async function grabar() {
  if (C.rec) return detener();
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    avisar('Este navegador no permite grabar audio.', 'bad');
    return;
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (_) { avisar('Necesito permiso para usar el micrófono.', 'bad'); return; }

  let mime = 'audio/webm', ext = 'webm';
  if (MediaRecorder.isTypeSupported && !MediaRecorder.isTypeSupported('audio/webm')) {
    if (MediaRecorder.isTypeSupported('audio/mp4')) { mime = 'audio/mp4'; ext = 'm4a'; }
    else { mime = ''; ext = 'm4a'; }
  }

  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  C.trozos = [];
  C.nTrozo = 0;
  C.recId = 'g_' + Date.now();

  // El celular se bloquea a los pocos segundos y con él se va el micrófono.
  try { if ('wakeLock' in navigator) C.wake = await navigator.wakeLock.request('screen'); }
  catch (_) {}

  mr.onerror = () => { avisar('La grabación se interrumpió. Se guarda lo que alcanzó.', 'bad'); detener(); };
  stream.getAudioTracks().forEach(t => {
    t.onended = () => { if (C.rec) { avisar('El micrófono se cerró. Se guarda lo grabado.', 'warn'); detener(); } };
  });
  const tipoReal = () => (mr.mimeType ? mr.mimeType.split(';')[0] : (mime || 'audio/mp4'));

  mr.ondataavailable = async e => {
    if (!e.data.size) return;
    C.trozos.push(e.data);
    try {
      await Almacen.guardarTrozo(C.recId, {
        token: T, campo: C.campo, tipo: tipoReal(), nombre: 'nota.' + ext, duracion: C.recT
      }, e.data, C.nTrozo++);
    } catch (_) {}
  };

  mr.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    try { if (C.wake) { C.wake.release(); C.wake = null; } } catch (_) {}
    const blob = new Blob(C.trozos, { type: tipoReal() });
    try { await Almacen.borrarGrabacion(C.recId); } catch (_) {}
    if (blob.size) await encolar(blob, 'audio', C.campo, 'nota.' + ext, C.recT);
    C.trozos = []; C.recId = null;
  };

  mr.start(4000);
  C.rec = mr; C.recT = 0;
  pantallaGrabando();
  C.recTimer = setInterval(() => {
    C.recT++;
    const t = document.getElementById('gT');
    if (t) t.textContent = mmss(C.recT);
    if (C.recT >= 1800) detener();
  }, 1000);
}

function pantallaGrabando() {
  const d = document.createElement('div');
  d.className = 'grabando'; d.id = 'panelGrab';
  d.innerHTML = `
    <div class="onda">🎙</div>
    <div class="t" id="gT">0:00</div>
    <div style="opacity:.75;font-size:14px">Grabando la entrevista</div>
    <button class="btn p" id="gStop" style="padding:14px 34px;font-size:16px">Detener y guardar</button>
    <div class="tiny" style="color:#9fb0c0;max-width:260px;text-align:center">
      Se guarda cada 4 segundos. Puede hablar todo lo que necesite: el tope es una hora.
      La pantalla se queda encendida sola.</div>`;
  document.body.appendChild(d);
  document.getElementById('gStop').onclick = detener;
}

function detener() {
  if (!C.rec) return;
  try { C.rec.stop(); } catch (_) {}
  clearInterval(C.recTimer);
  C.rec = null;
  const d = document.getElementById('panelGrab');
  if (d) d.remove();
}

/* Al volver de la cámara o de otra app, se relee del servidor. */
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  if (C.rec && !C.wake) {
    try { if ('wakeLock' in navigator) C.wake = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  if (C.info && !C.rec) refrescar();
});
window.addEventListener('pageshow', () => { if (C.info) refrescar(); });
window.addEventListener('online', () => { Almacen.procesar(); pintarEstado(); });
window.addEventListener('offline', pintarEstado);
window.addEventListener('beforeunload', e => {
  if (C.rec) { e.preventDefault(); e.returnValue = ''; }
});

try { const t = localStorage.getItem('lp_tema'); if (t) document.documentElement.setAttribute('data-theme', t); } catch (_) {}
