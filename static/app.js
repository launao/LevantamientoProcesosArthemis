/* ═══════════════════════════════════════════════════════════════
   app.js — Levantamiento de Procesos (cliente)
   Habla con la API en /api y con /media para fotos y audios.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const S = {
  listo: false, yo: null,
  config: null, plantilla: null, equipo: [], procesos: [],
  vista: 'tablero', procId: null, draft: null, dirty: false,
  filtros: { q: '', area: '', estado: '', resp: '' },
  modo: 'guiado', idx: 0, pasoAbierto: null, editandoPlantilla: false,
  rec: null, recCampo: null, recT: 0, recTimer: null, pollTimer: null
};

let ESTADOS = [
  { k: 'pendiente', n: 'Borrador' },
  { k: 'en_curso', n: 'En curso' },
  { k: 'en_revision', n: 'Enviado' },
  { k: 'aprobado', n: 'Aprobado' }
];
const ESTADOS_BASE = ESTADOS.slice();

/** Opciones de un campo: propias, o tomadas de un catálogo compartido. */
function opcionesDe(c) {
  if (c.catalogo) {
    const cat = (S.config.catalogos || []).find(x => x.id === c.catalogo);
    if (cat) return cat.opciones || [];
  }
  return c.opciones || [];
}
const ROLES = [
  { k: 'admin', n: 'Administrador',
    d: 'Reparte los procesos, fija las fechas y configura la plantilla, las listas y el equipo. Ve todo.' },
  { k: 'analista', n: 'Analista — levanta procesos',
    d: 'Ve y edita únicamente los procesos que tiene a cargo. Los levanta, sube fotos y audios, y los envía.' },
  { k: 'clinica', n: 'Cliente / clínica',
    d: 'La contraparte de la institución: ve la agenda y el avance, designa quién atiende de su lado, escribe el cuadro “tener en cuenta”, propone procesos nuevos y consulta los informes. No edita levantamientos.' },
  { k: 'lector', n: 'Lector — solo consulta',
    d: 'Solo mira y exporta. No escribe nada.' }
];

const TIPOS_CAMPO = [
  { k: 'texto', n: 'Texto corto' },
  { k: 'parrafo', n: 'Párrafo' },
  { k: 'lista', n: 'Lista (una opción)' },
  { k: 'multi', n: 'Lista (varias)' },
  { k: 'numero', n: 'Número' },
  { k: 'fecha', n: 'Fecha' },
  { k: 'si_no', n: 'Sí / No' },
  { k: 'pasos', n: 'Tabla de actividades' },
  { k: 'persona', n: 'Persona del equipo' },
  { k: 'procesos', n: 'Otros procesos (enlace)' }
];

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const esAdmin = () => S.yo && S.yo.rol === 'admin';
const puedeEditar = () => S.yo && (S.yo.rol === 'admin' || S.yo.rol === 'analista');
const esClinica = () => S.yo && S.yo.rol === 'clinica';

/* ── Capa de API ──────────────────────────────────────────────── */
async function api(ruta, opciones = {}) {
  const o = Object.assign({ credentials: 'same-origin' }, opciones);
  if (o.body && !(o.body instanceof FormData)) {
    o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    o.body = JSON.stringify(o.body);
  }
  const r = await fetch('/api' + ruta, o);
  if (r.status === 401) { location.href = '/login'; throw new Error('no_autenticado'); }
  let d = null;
  try { d = await r.json(); } catch (_) { d = {}; }
  if (!r.ok) { const e = new Error(d.error || 'error'); e.data = d; e.status = r.status; throw e; }
  return d;
}

/* ═══════════════════════════════════════════════════════════════
   Direcciones

   Cada vista y cada proceso tienen su propia URL. Así se abre un
   proceso en otra pestaña con Cmd+clic, se guarda en favoritos, y el
   botón Atrás del navegador hace lo que uno espera.
   ═══════════════════════════════════════════════════════════════ */
function leerRuta() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  const [vista, id] = h.split('/');
  return { vista: vista || '', id: id || '' };
}

function irA(vista, id, reemplazar) {
  const destino = '#/' + vista + (id ? '/' + id : '');
  if (location.hash === destino) return;
  if (reemplazar) history.replaceState(null, '', destino);
  else location.hash = destino;
}

function aplicarRuta() {
  const { vista, id } = leerRuta();
  if (!vista) { S.vista = 'tablero'; return render(); }

  if (vista === 'proceso' && id) {
    if (S.procId === id && S.vista === 'proceso') return;
    const p = S.procesos.find(x => x.id === id);
    if (p) return abrirProceso(id, true);
    S.vista = 'procesos'; return render();
  }
  if (S.vista === vista && !S.procId) return;
  S.vista = vista; S.procId = null; S.draft = null;
  render();
}

window.addEventListener('hashchange', () => { if (S.listo) aplicarRuta(); });

/* ── Arranque ─────────────────────────────────────────────────── */
render();
arrancar();

async function arrancar() {
  try {
    const d = await api('/bootstrap');
    S.yo = d.usuario; S.config = d.config; S.plantilla = d.plantilla;
    if (Array.isArray(S.config.estados) && S.config.estados.length === 4) ESTADOS = S.config.estados;
    S.equipo = d.equipo; S.procesos = d.procesos;
    api('/indice').then(x => { S.indice = x.procesos; }).catch(() => { S.indice = []; });
    S.listo = true;
    aplicarRuta();
    S.pollTimer = setInterval(refrescarSilencioso, 8000);
  } catch (e) {
    S.listo = true; render();
  }
}

async function refrescarSilencioso() {
  if (S.editandoPlantilla || document.hidden) return;
  try {
    const d = await api('/procesos');
    S.procesos = d.procesos;

    if (S.vista === 'proceso' && S.draft) {
      // Lo que llega del celular debe aparecer solo, sin recargar. Se
      // toca únicamente la evidencia: lo que la persona está escribiendo
      // en este momento no se pisa nunca.
      const fresco = S.procesos.find(x => x.id === S.draft.id);
      if (fresco) {
        const antes = (S.draft.evidencias || []).length;
        S.draft.evidencias = fresco.evidencias || [];
        pintarEvidencias(S.draft);
        const nuevas = S.draft.evidencias.length - antes;
        if (nuevas > 0) toast(`Llegó ${nuevas} archivo(s) desde el celular`);
      }
      return;
    }
    if (S.vista === 'tablero' || S.vista === 'procesos' || S.vista === 'asignacion') render();
  } catch (_) { /* silencioso a propósito */ }
}

/* ── Utilidades de dominio ────────────────────────────────────── */
const persona = id => S.equipo.find(p => p.id === id);
const nombrePersona = id => (persona(id) || {}).nombre || '—';

function camposPlanos() {
  if (!S.plantilla) return [];
  return (S.plantilla.secciones || []).flatMap(s =>
    (s.campos || []).map(c => Object.assign({ seccion: s.nombre }, c)));
}
/** Texto sin etiquetas: para contar avance y para buscar. */
function aTextoPlano(html) {
  if (typeof html !== 'string') return '';
  if (html.indexOf('<') < 0) return html;
  const d = document.createElement('div');
  d.innerHTML = html;
  return (d.textContent || '').trim();
}

function tieneValor(c, v) {
  if (v == null) return false;
  if (c.tipo === 'pasos') return Array.isArray(v) && v.some(r => (r.actividad || '').trim());
  if (c.tipo === 'multi') return Array.isArray(v) && v.length > 0;
  if (c.tipo === 'si_no') return v === 'si' || v === 'no';
  if (c.tipo === 'parrafo') return aTextoPlano(String(v)) !== '';
  return String(v).trim() !== '';
}
function avance(p) {
  const cs = camposPlanos(); if (!cs.length) return 0;
  const obl = cs.filter(c => c.obligatorio);
  const base = obl.length ? obl : cs;
  const r = p.respuestas || {};
  return Math.round(base.filter(c => tieneValor(c, r[c.id])).length / base.length * 100);
}
function avanceGlobal() {
  if (!S.procesos.length) return 0;
  return Math.round(S.procesos.reduce((a, p) => a + avance(p), 0) / S.procesos.length);
}
function procesosFiltrados() {
  const f = S.filtros, q = f.q.toLowerCase().trim();
  return S.procesos.filter(p => {
    if (f.area && p.area !== f.area) return false;
    if (f.estado && p.estado !== f.estado) return false;
    if (f.resp && p.responsable !== f.resp) return false;
    if (q && ![p.nombre, p.codigo, p.area, p.notas].join(' ').toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (a.codigo || '').localeCompare(b.codigo || '') ||
                    (a.nombre || '').localeCompare(b.nombre || ''));
}

function toast(msg) {
  const d = document.createElement('div');
  d.className = 'toast'; d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2600);
}

let saveT = null;
let ultimoGuardado = null;

/** Autoguardado: se dispara solo mientras se escribe. */
function guardarDebounce() {
  if (!puedeEditar()) return;
  S.dirty = true;
  pintarEstadoGuardado('escribiendo');
  respaldarLocal();
  clearTimeout(saveT);
  saveT = setTimeout(() => guardarAhora(true), 900);
}

/** Guardado manual: el botón, Ctrl+S, o al salir del proceso. */
async function guardarAhora(automatico) {
  const p = S.draft;
  if (!p || !puedeEditar()) return false;
  clearTimeout(saveT);
  pintarEstadoGuardado('guardando');
  try {
    await api('/procesos/' + p.id, { method: 'PUT', body: {
      nombre: p.nombre, codigo: p.codigo, area: p.area,
      responsable: p.responsable || null, estado: p.estado,
      fechaLimite: p.fechaLimite || null, contacto: p.contacto || '',
      notas: p.notas || '', respuestas: p.respuestas
    }});
    const i = S.procesos.findIndex(x => x.id === p.id);
    if (i >= 0) S.procesos[i] = JSON.parse(JSON.stringify(p));
    S.dirty = false;
    ultimoGuardado = new Date();
    Almacen.borrarBorrador(p.id).catch(() => {});
    pintarEstadoGuardado('guardado');
    if (!automatico) toast('Guardado');
    return true;
  } catch (e) {
    respaldarLocal();
    pintarEstadoGuardado('error');
    if (!automatico) toast('No se pudo guardar. Quedó respaldado en este equipo.');
    return false;
  }
}

/** Copia local de lo escrito, por si falla la red o se cierra el navegador. */
function respaldarLocal() {
  const p = S.draft;
  if (!p) return;
  Almacen.guardarBorrador(p.id, {
    nombre: p.nombre, codigo: p.codigo, area: p.area,
    responsable: p.responsable, estado: p.estado, respuestas: p.respuestas
  }).catch(() => {});
}

function pintarEstadoGuardado(estado) {
  const el = document.getElementById('estadoGuardado');
  const btn = document.getElementById('btnGuardar');
  if (!el) return;
  const mapa = {
    escribiendo: ['Sin guardar…', 'var(--ink-3)'],
    guardando: ['Guardando…', 'var(--ink-3)'],
    guardado: ['Guardado' + (ultimoGuardado ? ' ' + hhmm(ultimoGuardado) : ''), 'var(--ok)'],
    error: ['Sin guardar — respaldado en este equipo', 'var(--bad)']
  };
  const par = mapa[estado] || ['', 'var(--ink-3)'];
  el.textContent = par[0];
  el.style.color = par[1];
  if (btn) {
    btn.disabled = estado === 'guardando';
    btn.textContent = estado === 'error' ? 'Reintentar' : 'Guardar';
  }
}

function hhmm(d) {
  return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

/** Ctrl+S / Cmd+S guarda sin salir del campo. */
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    if (S.vista === 'proceso' && S.draft) { e.preventDefault(); guardarAhora(false); }
  }
});

/** Al recuperar la conexión, reintenta lo que quedó sin guardar. */
window.addEventListener('online', () => { if (S.dirty && S.draft) guardarAhora(true); });


/* ═══════════════════════════════════════════════════════════════
   Render
   ═══════════════════════════════════════════════════════════════ */
function render() {
  const r = document.getElementById('root');
  if (!S.listo) {
    r.innerHTML = '<div class="empty" style="padding-top:120px"><span class="e">◌</span>Cargando…</div>';
    return;
  }
  if (!S.config || !S.plantilla) {
    r.innerHTML = '<div class="empty" style="padding-top:120px"><span class="e">⚠</span>No se pudo cargar la información.<br><a href="/login">Volver a ingresar</a></div>';
    return;
  }
  const v = S.vista;
  r.innerHTML = `
  <div class="app">
    <aside class="side">
      <div class="brand"><div class="dot"></div>
        <div><b>${esc(S.config.proyecto || 'Levantamiento')}</b><small>${esc(S.config.organizacion || 'Procesos')}</small></div></div>
      <nav class="nav">
        ${esClinica() ? `
          ${nav('avance', '◱', 'Hoy y mañana', v)}
          ${nav('agenda', '◷', 'Agenda', v)}
          ${nav('mapear', '✎', 'Por mapear', v)}
          ${nav('procesos', '▤', 'Procesos', v)}
          ${nav('mapa', '⤳', 'Mapa', v)}
        ` : `
        ${nav('tablero', '◱', esAdmin() ? 'Tablero' : 'Mi avance', v)}
        ${esAdmin() ? navConCuenta('revision', '✓', 'Revisión', v, porRevisar().length) : ''}
        ${nav('procesos', '▤', 'Procesos', v)}
        ${nav('mapa', '⤳', 'Mapa', v)}
        ${esAdmin() ? nav('asignacion', '⇄', 'Asignación', v) : ''}
        ${esAdmin() ? nav('equipo', '👥', 'Equipo', v) : ''}
        ${esAdmin() ? nav('plantilla', '⚙', 'Plantilla', v) : ''}
        ${esAdmin() ? nav('ajustes', '⋯', 'Ajustes', v) : ''}
        ${esAdmin() ? '' : nav('cuenta', '⋯', 'Mi cuenta', v)}
        `}
      </nav>
      <div class="side-foot">
        <div style="font-weight:600;color:var(--ink-2)">${esc(S.yo.nombre)}</div>
        <div>${esc(S.yo.rol)} · <a href="#" id="salir">salir</a></div>
      </div>
    </aside>
    <main class="main" id="main"></main>
  </div>`;

  r.querySelectorAll('.nav button').forEach(b => b.onclick = () => {
    S.vista = b.dataset.v; S.procId = null; S.draft = null; S.editandoPlantilla = false;
    irA(b.dataset.v); render();
  });
  document.getElementById('salir').onclick = async e => {
    e.preventDefault();
    await api('/logout', { method: 'POST' }).catch(() => {});
    location.href = '/login';
  };

  const m = document.getElementById('main');
  const rutas = { tablero: vistaTablero, procesos: vistaProcesos, proceso: vistaProceso,
                  asignacion: vistaAsignacion, equipo: vistaEquipo, agenda: vistaAgenda,
                  mapa: vistaMapa, avance: vistaAvanceClinica, revision: vistaRevision,
                  mapear: vistaPorMapear,
                  plantilla: vistaPlantilla,
                  ajustes: vistaAjustes, cuenta: vistaAjustes };
  if (esClinica() && !['agenda', 'avance', 'mapear', 'procesos', 'proceso', 'mapa'].includes(v)) {
    S.vista = 'avance'; return render();
  }
  // Las pantallas de configuración son solo del administrador. Se comprueba
  // aquí además de ocultar el menú, por si alguien llega por otra vía.
  const soloAdmin = ['asignacion', 'equipo', 'plantilla', 'revision'];
  if (soloAdmin.includes(v) && !esAdmin()) { S.vista = 'tablero'; return render(); }
  (rutas[v] || vistaTablero)(m);
}
/** Los procesos que esperan tu decisión. */
function porRevisar() {
  return S.procesos.filter(p => p.estado === 'en_revision');
}

function navConCuenta(k, ic, lb, v, n) {
  const on = v === k;
  return `<button data-v="${k}" class="${on ? 'on' : ''}">
    <span class="ic">${ic}</span><span class="lb">${lb}</span>
    ${n ? `<span class="badge-nav">${n}</span>` : ''}</button>`;
}

function nav(k, ic, lb, v) {
  const on = v === k || (k === 'procesos' && v === 'proceso');
  return `<button data-v="${k}" class="${on ? 'on' : ''}"><span class="ic">${ic}</span><span class="lb">${lb}</span></button>`;
}

/* ── Tablero ──────────────────────────────────────────────────── */
function vistaTablero(m) {
  return esAdmin() ? tableroAdmin(m) : tableroPersonal(m);
}

/* ═══════════════════════════════════════════════════════════════
   Hoy y vencidos

   Es lo primero que cualquiera necesita ver al entrar, sin importar
   el rol: qué toca hoy y qué se quedó atrás. Cambia solo el alcance
   —lo propio o lo de todos— y si se muestra o no de quién es.
   ═══════════════════════════════════════════════════════════════ */
function panelHoyVencidos(ps, opciones) {
  const conDueno = (opciones || {}).conDueno;
  const hoy = ps.filter(p => grupoDe(p, 'fecha') === 'hoy').sort(porCercania);
  const vencidos = ps.filter(p => grupoDe(p, 'fecha') === 'vencidos').sort(porCercania);

  const linea = p => `<a class="urg-item" href="#/proceso/${p.id}">
    <span class="urg-nom">${esc(p.nombre)}</span>
    <span class="urg-meta">${esc(p.area || 'Sin área')}${
      conDueno ? ' · ' + esc(nombrePersona(p.responsable)) : ''}${
      p.atiende ? ' · atiende ' + esc(p.atiende) : ''}</span>
    <span class="urg-der">
      ${textoPlazo(p.fechaLimite).html}
      <span class="tiny">${avance(p)}%</span>
    </span>
  </a>`;

  return `<div class="grid g2" style="margin-bottom:18px">
    <div class="card panel-urg ${hoy.length ? 'activo' : ''}">
      <h3>Para hoy <span class="cuenta-urg">${hoy.length}</span></h3>
      ${hoy.length
        ? `<div class="urg-lista">${hoy.map(linea).join('')}</div>`
        : '<div class="mut">Nada programado para hoy.</div>'}
    </div>

    <div class="card panel-urg ${vencidos.length ? 'vencido' : ''}">
      <h3>Pasados de fecha <span class="cuenta-urg">${vencidos.length}</span></h3>
      ${vencidos.length
        ? `<div class="urg-lista">${vencidos.slice(0, 8).map(linea).join('')}
           ${vencidos.length > 8 ? `<div class="tiny" style="padding:8px 2px">y ${vencidos.length - 8} más</div>` : ''}</div>`
        : '<div class="mut">Nada atrasado. Todo al día.</div>'}
    </div>
  </div>`;
}

/** Lo que ve quien levanta: solo su trabajo, sin ruido del resto. */
function tableroPersonal(m) {
  const ps = S.procesos;
  const porEstado = k => ps.filter(p => (p.estado || 'pendiente') === k).length;
  const av = avanceGlobal();

  m.innerHTML = `
  <div class="topbar"><h1>Hola, ${esc((S.yo.nombre || '').split(' ')[0])}</h1><div class="sp"></div>
    ${puedeEditar() ? '<button class="btn p" id="nuevoTab">+ Nuevo proceso</button>' : ''}</div>

  ${(() => {
    const dev = ps.filter(p => p.notaRevision && p.estado === 'en_curso');
    return dev.length ? `<div class="banner" style="margin-bottom:16px">
      <b>${dev.length} proceso(s) te los devolvieron para completar:</b>
      ${dev.map(p => `<a href="#/proceso/${p.id}">${esc(p.nombre)}</a>`).join(' · ')}
    </div>` : '';
  })()}

  ${panelHoyVencidos(ps)}

  <div class="grid g4" style="margin-bottom:16px">
    <div class="kpi"><div class="n">${ps.length}</div><div class="t">Procesos a mi cargo</div></div>
    <div class="kpi"><div class="n">${av}%</div><div class="t">Mi avance promedio</div>
      <div class="bar" style="margin-top:8px"><i style="width:${av}%"></i></div></div>
    <div class="kpi"><div class="n">${porEstado('en_revision') + porEstado('aprobado')}</div><div class="t">Ya enviados</div></div>
    <div class="kpi"><div class="n">${porEstado('pendiente') + porEstado('en_curso')}</div><div class="t">Me faltan</div></div>
  </div>

  <div class="card"><h3>Mis procesos</h3>
    ${ps.length ? `<div class="tw"><table class="t"><tbody>
      ${[...ps].sort((a, b) => avance(a) - avance(b)).map(p => filaProceso(p)).join('')}
    </tbody></table></div>` : `<div class="empty"><span class="e">▤</span>
      Todavía no tienes procesos asignados. Puedes crear el tuyo con el botón de arriba.</div>`}
  </div>`;

  const b = document.getElementById('nuevoTab');
  if (b) b.onclick = modalNuevoProceso;
  m.querySelectorAll('tbody tr[data-id]').forEach(tr => tr.onclick = () => abrirProceso(tr.dataset.id));
}

/** Lo que ve el administrador: el total y el detalle de cada persona. */
function tableroAdmin(m) {
  const ps = S.procesos;
  const porEstado = k => ps.filter(p => (p.estado || 'pendiente') === k).length;
  const fotos = ps.reduce((a, p) => a + (p.evidencias || []).filter(e => e.tipo === 'foto').length, 0);
  const audios = ps.reduce((a, p) => a + (p.evidencias || []).filter(e => e.tipo === 'audio').length, 0);
  const av = avanceGlobal();

  const filtrados = ps.filter(pasaFiltros);

  m.innerHTML = `
  <div class="topbar"><h1>Tablero</h1><div class="sp"></div>
    <button class="btn p" id="nuevoTab">+ Nuevo proceso</button></div>

  <div class="card filtros-asig" style="grid-template-columns:1.5fr 1fr 1fr auto">
    <input type="text" id="tBusca" placeholder="Buscar un proceso…" value="${esc(S.buscaAsig || '')}">
    <select id="tPersona">
      <option value="">Todas las personas</option>
      <option value="__sin__" ${S.filtroPersona === '__sin__' ? 'selected' : ''}>Sin asignar</option>
      ${S.equipo.filter(u => u.rol === 'admin' || u.rol === 'analista').map(u =>
        `<option value="${u.id}" ${S.filtroPersona === u.id ? 'selected' : ''}>${esc(u.nombre)}</option>`).join('')}
    </select>
    <select id="tCuando">
      <option value="">Cualquier fecha de entrega</option>
      ${[['vencidos', 'Vencidos'], ['hoy', 'Hoy'], ['semana', 'Esta semana'],
         ['siguiente', 'Semana siguiente'], ['sinfecha', 'Sin fecha']].map(([k, n]) =>
        `<option value="${k}" ${S.filtroCuando === k ? 'selected' : ''}>${n}</option>`).join('')}
    </select>
    ${(S.buscaAsig || S.filtroPersona || S.filtroCuando)
      ? '<button class="btn sm" id="tLimpiar">Quitar filtros</button>' : ''}
  </div>

  ${panelClinica(ps)}

  <div class="grid g4" style="margin-bottom:16px">
    <div class="kpi"><div class="n">${ps.length}</div><div class="t">Procesos en total</div></div>
    <div class="kpi"><div class="n">${av}%</div><div class="t">Avance promedio</div>
      <div class="bar" style="margin-top:8px"><i style="width:${av}%"></i></div></div>
    <div class="kpi"><div class="n">${porEstado('en_revision') + porEstado('aprobado')}</div><div class="t">Enviados</div></div>
    <div class="kpi"><div class="n">${fotos} / ${audios}</div><div class="t">Fotos / notas de voz</div></div>
  </div>

  <div class="card" style="margin-bottom:16px"><h3>Cada persona</h3>
    <div class="grid g2">
      ${columnasPersonas().filter(c => c.id).map(pe => {
        const sub = filtrados.filter(p => p.responsable === pe.id);
        const x = sub.length ? Math.round(sub.reduce((t, p) => t + avance(p), 0) / sub.length) : 0;
        const env = sub.filter(p => p.estado === 'en_revision' || p.estado === 'aprobado').length;
        const tarde = sub.filter(p => { const pl = textoPlazo(p.fechaLimite); return pl.dias !== null && pl.dias < 0 && p.estado !== 'aprobado'; }).length;
        return `<div class="persona-card" data-persona="${pe.id}">
          <div class="flex" style="margin-bottom:8px">
            <div class="avatar">${esc((pe.nombre || '?').trim()[0].toUpperCase())}
              ${puntoPresencia(pe)}</div>
            <div style="flex:1"><b>${esc(pe.nombre)}</b>
              <div class="tiny">${sub.length} asignado(s) · ${env} enviado(s)${tarde ? ` · <span class="plazo vencido">${tarde} en mora</span>` : ''}</div>
              <div class="tiny">${esc(presencia(pe).texto)}</div></div>
            <div style="text-align:right"><b style="font-size:18px">${x}%</b></div>
          </div>
          <div class="bar"><i style="width:${x}%"></i></div>
          ${sub.length ? `<div class="mini-lista">${[...sub].sort(porCercania).slice(0, 5).map(p =>
              `<a class="mini-item" href="#/proceso/${p.id}">
                 <span class="mini-fecha">${p.fechaLimite ? esc(fechaDia(p.fechaLimite).replace(/^\w+ /, '')) : '—'}</span>
                 <span class="mini-nom">${esc(recortar(p.nombre, 28))}</span></a>`).join('')}${
              sub.length > 5 ? `<div class="tiny" style="padding-top:4px">y ${sub.length - 5} más</div>` : ''}</div>` : ''}
        </div>`;
      }).join('') || '<div class="mut">Agrega personas en Equipo.</div>'}
    </div>
  </div>

  <div class="grid g2">
    <div class="card"><h3>Por estado</h3>
      ${ESTADOS.map(e => {
        const n = porEstado(e.k), pc = ps.length ? Math.round(n / ps.length * 100) : 0;
        return `<div style="margin-bottom:11px"><div class="flex" style="font-size:13px;margin-bottom:4px">
          <span>${esc(e.n)}</span><span class="right mut">${n}</span></div>
          <div class="bar"><i style="width:${pc}%"></i></div></div>`;
      }).join('')}
    </div>
    <div class="card"><h3>Por área</h3>
      ${(S.config.areas || []).map(a => {
        const sub = ps.filter(p => p.area === a); if (!sub.length) return '';
        const x = Math.round(sub.reduce((t, p) => t + avance(p), 0) / sub.length);
        return `<div style="margin-bottom:10px"><div class="flex" style="font-size:13px;margin-bottom:4px">
          <span>${esc(a)}</span><span class="right mut">${sub.length} · ${x}%</span></div>
          <div class="bar"><i style="width:${x}%"></i></div></div>`;
      }).join('') || '<div class="mut">Aún no hay procesos por área.</div>'}
    </div>
  </div>`;

  document.getElementById('nuevoTab').onclick = modalNuevoProceso;

  const bindT = (id, clave) => {
    const el = document.getElementById(id);
    if (el) el.oninput = el.onchange = () => { S[clave] = el.value; tableroAdmin(m); };
  };
  bindT('tBusca', 'buscaAsig'); bindT('tPersona', 'filtroPersona'); bindT('tCuando', 'filtroCuando');
  const tl = document.getElementById('tLimpiar');
  if (tl) tl.onclick = () => {
    S.buscaAsig = ''; S.filtroPersona = ''; S.filtroCuando = ''; tableroAdmin(m);
  };

  m.querySelectorAll('[data-persona]').forEach(el => el.onclick = e => {
    if (e.target.closest('a')) return;
    S.filtros.resp = el.dataset.persona; S.vista = 'procesos'; irA('procesos'); render();
  });
}

/* ── Lista de procesos ────────────────────────────────────────── */
function vistaProcesos(m) {
  const ps = procesosFiltrados();
  const grupos = [
    { k: 'pendiente',  n: etiquetaEstado('pendiente'),  ayuda: 'Todavía se están llenando. Nadie los ha recibido.' },
    { k: 'en_curso',   n: etiquetaEstado('en_curso'),   ayuda: 'En trabajo activo.' },
    { k: 'en_revision',n: etiquetaEstado('en_revision'),ayuda: 'Ya se enviaron. Se pueden seguir editando y reenviar.' },
    { k: 'aprobado',   n: etiquetaEstado('aprobado'),   ayuda: 'Cerrados y validados.' }
  ];

  m.innerHTML = `
  <div class="topbar"><h1>Procesos</h1><div class="sp"></div>
    ${esAdmin() ? '<button class="btn sm" id="verPapelera">Archivados</button>' : ''}
    ${puedeEditar() ? '<button class="btn p" id="nuevoP">+ Nuevo proceso</button>' : ''}</div>

  ${esAdmin() ? '' : esClinica()
    ? '<div class="banner">Todos los procesos que el equipo está levantando en la clínica.</div>'
    : '<div class="banner">Aquí ves los procesos que tienes a cargo.</div>'}

  <div class="card" style="margin-bottom:16px">
    <div class="grid ${esAdmin() ? 'g3' : 'g2'}" style="gap:10px">
      <input type="text" id="fq" placeholder="Buscar por nombre o código…" value="${esc(S.filtros.q)}">
      <select id="fa"><option value="">Todas las áreas</option>${(S.config.areas || []).map(a => `<option ${S.filtros.area === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
      ${esAdmin() ? `<select id="fr"><option value="">Todos los responsables</option>${S.equipo.map(p => `<option value="${p.id}" ${S.filtros.resp === p.id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select>` : ''}
    </div>
  </div>

  ${grupos.map(g => {
    const suyos = ps.filter(p => (p.estado || 'pendiente') === g.k);
    return `<section class="grupo">
      <div class="grupo-cab">
        <span class="pill ${g.k}">${esc(g.n)}</span>
        <span class="tiny">${suyos.length}</span>
        <span class="tiny right">${esc(g.ayuda)}</span>
      </div>
      ${suyos.length ? `<div class="card" style="padding:0"><div class="tw"><table class="t">
        <tbody>${suyos.map(p => filaProceso(p)).join('')}</tbody></table></div></div>`
        : '<div class="grupo-vacio">Ninguno por ahora.</div>'}
    </section>`;
  }).join('')}`;

  const nb = document.getElementById('nuevoP');
  if (nb) nb.onclick = modalNuevoProceso;
  const pb = document.getElementById('verPapelera');
  if (pb) pb.onclick = modalPapelera;

  [['fq', 'q'], ['fa', 'area'], ['fr', 'resp']].forEach(([id, k]) => {
    const el = document.getElementById(id);
    if (el) el.oninput = el.onchange = () => { S.filtros[k] = el.value; vistaProcesos(m); };
  });
  m.querySelectorAll('tbody tr[data-id]').forEach(tr => tr.onclick = () => abrirProceso(tr.dataset.id));
}

function etiquetaEstado(k) {
  return (ESTADOS.find(e => e.k === k) || { n: k }).n;
}

function filaProceso(p) {
  const av = avance(p), ev = p.evidencias || [];
  const plazo = textoPlazo(p.fechaLimite);
  return `<tr data-id="${p.id}" style="cursor:pointer">
    <td class="mut" style="width:74px">${esc(p.codigo || '—')}</td>
    <td><a class="nombre-proc" href="#/proceso/${p.id}"><b>${esc(p.nombre)}</b></a>
      ${p.propuestoPor && !p.responsable ? '<span class="etiqueta-prop">propuesto por la clínica</span>' : ''}
      <div class="tiny">${esc(p.area || 'Sin área')}${p.contacto ? ' · contacto: ' + esc(p.contacto) : ''}</div>
      ${p.notasClinica ? `<div class="tiny nota-mini">⚑ ${esc(recortar(aTextoPlano(p.notasClinica), 90))}</div>` : ''}</td>
    ${esAdmin() ? `<td class="mut" style="width:130px">${esc(nombrePersona(p.responsable))}</td>` : ''}
    <td style="width:120px">${plazo.html}</td>
    <td style="width:120px"><div class="bar"><i style="width:${av}%"></i></div><span class="tiny">${av}%</span></td>
    <td class="tiny" style="width:78px">📷 ${ev.filter(e => e.tipo === 'foto').length} · 🎙 ${ev.filter(e => e.tipo === 'audio').length}</td>
    <td style="width:46px">${p.informeUrl
      ? `<a class="btn sm ic" href="${esc(p.informeUrl)}" target="_blank" rel="noopener"
           title="Abrir el informe" onclick="event.stopPropagation()">📄</a>` : ''}</td>
  </tr>`;
}

/** La fecha de entrega, dicha como la diría una persona. */
function textoPlazo(fecha) {
  if (!fecha) return { html: '<span class="tiny mut">Sin fecha</span>', dias: null };
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const f = new Date(fecha + 'T00:00:00');
  const dias = Math.round((f - hoy) / 86400000);
  let txt, clase;
  if (dias < 0) { txt = `Venció hace ${-dias} día(s)`; clase = 'plazo vencido'; }
  else if (dias === 0) { txt = 'Vence hoy'; clase = 'plazo hoy'; }
  else if (dias === 1) { txt = 'Vence mañana'; clase = 'plazo pronto'; }
  else if (dias <= 3) { txt = `En ${dias} días`; clase = 'plazo pronto'; }
  else { txt = f.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }); clase = 'plazo'; }
  return { html: `<span class="${clase}">${txt}</span>`, dias };
}

function modalPapelera() {
  modal('<h3>Procesos archivados</h3><div id="papBox"><div class="mut">Buscando…</div></div>' +
        '<div class="flex" style="margin-top:14px"><button class="btn right" data-cerrar>Cerrar</button></div>',
  async box => {
    try {
      const d = await api('/papelera');
      const caja = box.querySelector('#papBox');
      if (!d.procesos.length) {
        caja.innerHTML = '<div class="mut">No hay nada archivado. Nada se ha perdido.</div>';
        return;
      }
      caja.innerHTML = `<p class="mut" style="margin-top:-6px">Al eliminar, un proceso no se destruye: queda aquí. Puedes devolverlo con todo lo que tenía.</p>
        <table class="t"><tbody>${d.procesos.map(p => `<tr>
          <td><b>${esc(p.nombre)}</b><div class="tiny">${esc(p.codigo || '')} ${esc(p.area || '')}</div></td>
          <td style="width:110px"><button class="btn sm" data-rest="${p.id}">Recuperar</button></td>
        </tr>`).join('')}</tbody></table>`;
      caja.querySelectorAll('[data-rest]').forEach(b => b.onclick = async () => {
        await api('/procesos/' + b.dataset.rest + '/restaurar', { method: 'POST' });
        const r = await api('/procesos');
        S.procesos = r.procesos;
        cerrarModal(); render(); toast('Proceso recuperado');
      });
    } catch (_) { box.querySelector('#papBox').innerHTML = '<div class="mut">No se pudo consultar.</div>'; }
  });
}

function modalNuevoProceso() {
  const n = S.procesos.length + 1;
  modal(`<h3>Nuevo proceso</h3>
    <label class="f"><span class="lbl">Nombre del proceso <span class="req">*</span></span>
      <input type="text" id="mNombre" placeholder="Ej: Admisión de paciente en urgencias"></label>
    <div class="grid g2">
      <label class="f"><span class="lbl">Código</span><input type="text" id="mCod" value="P-${String(n).padStart(3, '0')}"></label>
      <label class="f"><span class="lbl">Área</span><select id="mArea">${(S.config.areas || []).map(a => `<option>${esc(a)}</option>`).join('')}</select></label>
    </div>
    <div class="grid g2">
      <label class="f"><span class="lbl">¿Con quién hablar en la clínica?</span>
        <input type="text" id="mContacto" placeholder="Nombre y cargo"></label>
      ${esAdmin() ? '<label class="f"><span class="lbl">Fecha de entrega</span><input type="date" id="mFecha"></label>' : ''}
    </div>
    ${esAdmin()
      ? `<label class="f"><span class="lbl">Responsable del levantamiento</span>
          <select id="mResp"><option value="">— Sin asignar —</option>${S.equipo.map(p => `<option value="${p.id}" ${p.id === S.yo.id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select></label>`
      : `<div class="banner" style="margin-bottom:14px">Quedará a tu nombre. Si debe ser de otra persona, pídeselo al administrador.</div>`}
    <div class="flex"><button class="btn" data-cerrar>Cancelar</button><button class="btn p right" id="mOk">Crear y abrir</button></div>`,
  box => {
    box.querySelector('#mOk').onclick = async () => {
      const nombre = box.querySelector('#mNombre').value.trim();
      if (!nombre) { toast('Ponle un nombre al proceso'); return; }
      try {
        const d = await api('/procesos', { method: 'POST', body: {
          nombre, codigo: box.querySelector('#mCod').value.trim(),
          area: box.querySelector('#mArea').value,
          responsable: esAdmin() ? (box.querySelector('#mResp').value || null) : null,
          contacto: box.querySelector('#mContacto').value.trim(),
          fechaLimite: esAdmin() && box.querySelector('#mFecha') ? (box.querySelector('#mFecha').value || null) : null
        }});
        cerrarModal();
        S.procesos.push({ id: d.id, nombre, codigo: box.querySelector('#mCod').value.trim(),
          area: box.querySelector('#mArea').value,
          responsable: esAdmin() ? box.querySelector('#mResp').value : S.yo.id,
          estado: 'pendiente', respuestas: {}, evidencias: [] });
        abrirProceso(d.id);
      } catch (e) { toast('No se pudo crear el proceso'); }
    };
    setTimeout(() => box.querySelector('#mNombre').focus(), 50);
  });
}

/* ── Editor de proceso ────────────────────────────────────────── */
function abrirProceso(id, desdeRuta) {
  const p = S.procesos.find(x => x.id === id); if (!p) return;
  if (!desdeRuta) irA('proceso', id);
  S.draft = JSON.parse(JSON.stringify(p));
  S.draft.respuestas = S.draft.respuestas || {};
  S.draft.evidencias = S.draft.evidencias || [];
  S.procId = id; S.vista = 'proceso'; S.dirty = false; S.idx = 0; S.pasoAbierto = null;
  render();
  revisarBorrador(id);
}

/** Si quedó un respaldo local sin subir (se cayó la red, se cerró el
    navegador), se ofrece recuperarlo en vez de perderlo en silencio. */
async function revisarBorrador(id) {
  if (!puedeEditar()) return;
  let b = null;
  try { b = await Almacen.leerBorrador(id); } catch (_) { return; }
  if (!b || !b.datos) return;

  const servidor = JSON.stringify((S.procesos.find(x => x.id === id) || {}).respuestas || {});
  const local = JSON.stringify(b.datos.respuestas || {});
  if (servidor === local) { Almacen.borrarBorrador(id).catch(() => {}); return; }

  const cuando = new Date(b.ts).toLocaleString('es-CO');
  modal(`<h3>Hay cambios sin guardar en este equipo</h3>
    <p class="mut" style="margin-top:-6px">Se quedaron sin subir el ${esc(cuando)}, probablemente por un corte de conexión. ¿Qué hacemos con ellos?</p>
    <div class="flex" style="margin-top:16px">
      <button class="btn" id="descartar">Descartar</button>
      <button class="btn p right" id="recuperar">Recuperar y guardar</button>
    </div>`, box => {
    box.querySelector('#descartar').onclick = () => {
      Almacen.borrarBorrador(id).catch(() => {});
      cerrarModal();
    };
    box.querySelector('#recuperar').onclick = async () => {
      Object.assign(S.draft, b.datos);
      cerrarModal();
      render();
      await guardarAhora(false);
    };
  });
}

function vistaProceso(m) {
  const p = S.draft; if (!p) { S.vista = 'procesos'; return render(); }
  const av = avance(p), ro = !puedeEditar();

  m.innerHTML = `
  <div class="topbar">
    <button class="btn sm" id="volver">← Procesos</button><div class="sp"></div>
    <span class="tiny" id="estadoGuardado"></span>
    ${ro ? '' : '<button class="btn sm" id="btnGuardar" title="Guardar ahora (Ctrl+S)">Guardar</button>'}
    ${esAdmin() ? '<button class="btn sm" id="btnIA" title="Que Claude analice este levantamiento">✨ Análisis</button>' : ''}
    ${p.informeUrl ? '<button class="btn sm" id="btnInforme" title="Ver y compartir el informe enviado">📄 Informe</button>' : ''}
    ${ro ? '' : '<button class="btn sm" id="btnHist" title="Ver y recuperar versiones anteriores">🕘 Historial</button>'}
    ${ro ? '' : '<button class="btn sm" id="btnQR">📱 Celular</button>'}
    ${ro ? '' : `<button class="btn sm p" id="btnEnviar">${p.enviosTotal ? '↻ Reenviar' : '✈ Enviar'}</button>`}
    ${ro ? '' : '<button class="btn sm danger" id="btnBorrar">Archivar</button>'}
  </div>
  <div class="card" style="margin-bottom:16px">
    <input type="text" id="pNombre" value="${esc(p.nombre)}" ${ro ? 'disabled' : ''}
      style="font-size:20px;font-weight:600;border:0;padding:0 0 8px;background:none">
    <div class="grid g4" style="gap:10px;margin-top:6px">
      <label class="f" style="margin:0"><span class="lbl">Código</span><input type="text" id="pCod" value="${esc(p.codigo || '')}" ${ro ? 'disabled' : ''}></label>
      <label class="f" style="margin:0"><span class="lbl">Área</span><select id="pArea" ${ro ? 'disabled' : ''}>${(S.config.areas || []).map(a => `<option ${p.area === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
      <label class="f" style="margin:0"><span class="lbl">Responsable${esAdmin() ? '' : ' <span class="tiny">(lo asigna el admin)</span>'}</span><select id="pResp" ${ro || !esAdmin() ? 'disabled' : ''}><option value="">— Sin asignar —</option>${S.equipo.map(x => `<option value="${x.id}" ${p.responsable === x.id ? 'selected' : ''}>${esc(x.nombre)}</option>`).join('')}</select></label>
      <label class="f" style="margin:0"><span class="lbl">Estado</span><select id="pEstado" ${ro ? 'disabled' : ''}>${ESTADOS.map(e => `<option value="${e.k}" ${p.estado === e.k ? 'selected' : ''}>${e.n}</option>`).join('')}</select></label>
    </div>
    <div class="grid g2" style="gap:10px;margin-top:10px">
      ${esAdmin()
        ? `<label class="f" style="margin:0"><span class="lbl">Fecha de entrega</span>
            <input type="date" id="pFecha" value="${esc((p.fechaLimite || '').slice(0, 10))}"></label>`
        : `<div class="f" style="margin:0"><span class="lbl">Fecha de entrega</span>
            <div class="dato-fijo">${p.fechaLimite ? textoPlazo(p.fechaLimite).html + ` <span class="tiny">(${esc(p.fechaLimite.slice(0, 10))})</span>` : '<span class="tiny">Todavía sin fecha</span>'}
              <div class="tiny" style="margin-top:3px">La define la coordinación del levantamiento.</div></div></div>`}
      <label class="f" style="margin:0"><span class="lbl">¿Con quién hablar en la clínica?</span>
        <input type="text" id="pContacto" value="${esc(p.contacto || '')}" placeholder="Nombre y cargo de quien conoce el proceso" ${ro ? 'disabled' : ''}></label>
    </div>
    ${p.notaRevision && p.estado === 'en_curso' ? `<div class="cuadro-devuelto">
      <div class="cc-cab"><span class="cd-et">↩ Devuelto para completar</span>
        <span class="tiny">${p.revisadoEn ? esc(fechaLarga(p.revisadoEn)) : ''}</span></div>
      <div class="cc-lectura">${esc(p.notaRevision)}</div>
      <div class="tiny" style="margin-top:8px">Cuando lo corrijas, vuelve a pulsar Enviar.</div>
    </div>` : ''}
    ${cuadroClinica(p)}
    ${p.enviosTotal ? `<div class="aviso-env tiny" style="margin-top:12px;padding:8px 12px;border-radius:8px;background:color-mix(in srgb,var(--ok) 12%,transparent)">
      ✓ Enviado ${p.enviosTotal} ${p.enviosTotal === 1 ? 'vez' : 'veces'}. Puedes seguir editando y subiendo; al reenviar se actualiza el informe con el mismo enlace.
    </div>` : ''}
    <div style="margin-top:14px" class="flex"><span class="tiny">Avance</span>
      <div class="bar" style="flex:1"><i id="avBar" style="width:${av}%"></i></div>
      <span class="tiny" id="avTxt">${av}%</span></div>
  </div>
  <div id="secciones"></div>`;

  conectarCuadroClinica(p);

  const bGuardar = document.getElementById('btnGuardar');
  if (bGuardar) bGuardar.onclick = () => guardarAhora(false);

  document.getElementById('volver').onclick = async () => {
    if (S.dirty && puedeEditar()) {
      const ok = await guardarAhora(true);
      if (!ok && !confirm('No se pudo guardar en el servidor. Los cambios quedaron respaldados en este equipo. ¿Salir de todos modos?')) return;
    }
    S.vista = 'procesos'; S.procId = null; S.draft = null; irA('procesos'); render();
  };

  pintarEstadoGuardado(S.dirty ? 'escribiendo' : 'guardado');
  const be = document.getElementById('btnEnviar');
  if (be) be.onclick = () => enviarProceso(p);

  const bia = document.getElementById('btnIA');
  if (bia) bia.onclick = () => modalAnalisis(p);

  const bi = document.getElementById('btnInforme');
  if (bi) bi.onclick = () => modalInforme(p);

  const bh = document.getElementById('btnHist');
  if (bh) bh.onclick = () => modalHistorial(p);

  const bq = document.getElementById('btnQR');
  if (bq) bq.onclick = () => modalQR(p, '');

  const bb = document.getElementById('btnBorrar');
  if (bb) bb.onclick = () => modal(
    `<h3>Archivar proceso</h3><p><b>${esc(p.nombre)}</b> saldrá de la lista, pero no se borra nada: el administrador lo puede recuperar completo desde “Archivados”.</p>
     <div class="flex"><button class="btn" data-cerrar>Cancelar</button>
     <button class="btn p right" id="okDel" style="background:var(--bad);border-color:var(--bad)">Archivar</button></div>`,
    b => b.querySelector('#okDel').onclick = async () => {
      await api('/procesos/' + p.id, { method: 'DELETE' });
      S.procesos = S.procesos.filter(x => x.id !== p.id);
      cerrarModal(); S.vista = 'procesos'; S.draft = null; render(); toast('Proceso archivado');
    });

  if (!ro) [['pNombre', 'nombre'], ['pCod', 'codigo'], ['pArea', 'area'],
            ['pResp', 'responsable'], ['pEstado', 'estado'],
            ['pFecha', 'fechaLimite'], ['pContacto', 'contacto']].forEach(([id, campo]) => {
    const el = document.getElementById(id);
    if (el && !el.disabled) el.oninput = el.onchange = () => { p[campo] = el.value; guardarDebounce(); };
  });

  pintarSecciones();
}

function refrescarAvance() {
  const av = avance(S.draft);
  const b = document.getElementById('avBar'), t = document.getElementById('avTxt');
  if (b) b.style.width = av + '%';
  if (t) t.textContent = av + '%';
}

/* ═══════════════════════════════════════════════════════════════
   El formulario: una pregunta a la vez.

   El levantamiento lo hacen personas que están entrevistando a otras
   personas, muchas veces de pie y con poco tiempo. Una pantalla con
   cuarenta campos abruma; una con una sola pregunta, su explicación y
   un ejemplo, se contesta sola.
   ═══════════════════════════════════════════════════════════════ */

/** Todos los campos de la plantilla, en orden, con su sección. */
function camposFlat() {
  const out = [];
  (S.plantilla.secciones || []).forEach((sec, si) => {
    (sec.campos || []).forEach(c => out.push({ sec, si, c }));
  });
  return out;
}

function pintarSecciones() {
  const cont = document.getElementById('secciones');
  if (!cont) return;
  const p = S.draft;
  const todos = camposFlat();
  if (!todos.length) { cont.innerHTML = '<div class="empty">La plantilla no tiene campos.</div>'; return; }

  if (S.modo === 'todo') return pintarTodo(cont, todos);
  pintarGuiado(cont, todos, p);
}

function barraModo() {
  return `<div class="modo-bar">
    <button class="btn sm ${S.modo === 'guiado' ? 'p' : ''}" data-modo="guiado">Una pregunta</button>
    <button class="btn sm ${S.modo === 'todo' ? 'p' : ''}" data-modo="todo">Ver todo</button>
    <span class="right tiny" id="mapaAviso"></span>
  </div>`;
}

function pintarGuiado(cont, todos, p) {
  S.idx = Math.max(0, Math.min(S.idx, todos.length - 1));
  const { sec, si, c } = todos[S.idx];
  const contestadas = todos.filter(x => tieneValor(x.c, p.respuestas[x.c.id])).length;
  const pc = Math.round(contestadas / todos.length * 100);
  const ultima = S.idx === todos.length - 1;
  const ro = !puedeEditar();

  cont.innerHTML = barraModo() + `
    <div class="guia">
      <div class="guia-cab">
        <div class="guia-sec">${esc(sec.nombre)}</div>
        <div class="guia-pos">Pregunta ${S.idx + 1} de ${todos.length}</div>
      </div>
      <div class="bar" style="margin-bottom:22px"><i style="width:${pc}%"></i></div>

      <h2 class="guia-preg">${esc(c.pregunta || c.etiqueta)}${c.obligatorio ? '<span class="req">*</span>' : ''}</h2>
      ${c.ayuda ? `<p class="guia-ayuda">${esc(c.ayuda)}</p>` : ''}
      ${c.ejemplo ? `<div class="guia-ej"><b>Por ejemplo:</b> ${esc(c.ejemplo)}</div>` : ''}

      <div class="guia-campo">${campoHTML(c, p.respuestas[c.id], true)}</div>

      <div class="pasos-pie">
        <button class="btn grande" id="antes" ${S.idx === 0 ? 'disabled' : ''}>← Anterior</button>
        <span class="aviso-campo">
          ${c.obligatorio ? 'Esta pregunta hay que responderla' : 'Si no sabe, puede seguir y volver después'}
        </span>
        ${ultima
          ? (ro ? '' : '<button class="btn p grande" id="finalizar">✈ Enviar el proceso</button>')
          : '<button class="btn p grande" id="despues">Siguiente →</button>'}
      </div>
    </div>

    <div class="mapa">
      <div class="tiny" style="margin-bottom:8px">Ir a cualquier pregunta:</div>
      ${(S.plantilla.secciones || []).map((s2, i2) => {
        const suyos = todos.map((x, gi) => ({ x, gi })).filter(o => o.x.si === i2);
        const hechos = suyos.filter(o => tieneValor(o.x.c, p.respuestas[o.x.c.id])).length;
        return `<div class="mapa-sec">
          <div class="mapa-nom">${esc(s2.nombre)} <span class="tiny">${hechos}/${suyos.length}</span></div>
          <div class="mapa-pts">${suyos.map(o => {
            const lleno = tieneValor(o.x.c, p.respuestas[o.x.c.id]);
            const act = o.gi === S.idx;
            return `<button class="pt ${act ? 'act' : (lleno ? 'ok' : '')}" data-ir="${o.gi}"
              title="${esc(o.x.c.etiqueta)}">${lleno && !act ? '✓' : ''}</button>`;
          }).join('')}</div>
        </div>`;
      }).join('')}
    </div>`;

  conectarBarra(cont);
  const ba = cont.querySelector('#antes');
  if (ba) ba.onclick = () => irACampo(S.idx - 1);
  const bd = cont.querySelector('#despues');
  if (bd) bd.onclick = () => irACampo(S.idx + 1);
  const bf = cont.querySelector('#finalizar');
  if (bf) bf.onclick = async () => { await guardarAhora(true); enviarProceso(S.draft); };
  cont.querySelectorAll('[data-ir]').forEach(b => b.onclick = () => irACampo(+b.dataset.ir));

  conectarCampos(cont);
  pintarEvidencias(S.draft);

  // El foco cae en el campo, para poder escribir sin tocar el ratón.
  const primero = cont.querySelector('.guia-campo input, .guia-campo textarea, .guia-campo select');
  if (primero && !ro) setTimeout(() => primero.focus(), 60);
}

function pintarTodo(cont, todos) {
  const p = S.draft;
  cont.innerHTML = barraModo() + (S.plantilla.secciones || []).map(sec => {
    const llenos = (sec.campos || []).filter(c => tieneValor(c, p.respuestas[c.id])).length;
    return `<section class="sec">
      <header style="cursor:default"><h4>${esc(sec.nombre)}</h4>
        <span class="cnt">${llenos}/${(sec.campos || []).length}</span></header>
      <div class="body">${(sec.campos || []).map(c => `
        <div class="campo-largo">
          <div class="lbl">${esc(c.pregunta || c.etiqueta)}${c.obligatorio ? '<span class="req">*</span>' : ''}</div>
          ${c.ayuda ? `<div class="hint">${esc(c.ayuda)}</div>` : ''}
          ${campoHTML(c, p.respuestas[c.id], false)}
        </div>`).join('')}</div>
    </section>`;
  }).join('');

  conectarBarra(cont);
  conectarCampos(cont);
  pintarEvidencias(S.draft);
}

function conectarBarra(cont) {
  cont.querySelectorAll('[data-modo]').forEach(b => b.onclick = async () => {
    if (S.dirty && puedeEditar()) await guardarAhora(true);
    S.modo = b.dataset.modo;
    pintarSecciones();
  });
}

/** Moverse entre preguntas guarda lo escrito antes de saltar. */
async function irACampo(n) {
  const total = camposFlat().length;
  if (n < 0 || n >= total) return;
  if (S.dirty && puedeEditar()) await guardarAhora(true);
  S.idx = n;
  pintarSecciones();
  const g = document.querySelector('.guia');
  if (g) g.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* Enter en un campo de una línea pasa a la siguiente pregunta. */
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey || S.vista !== 'proceso' || S.modo !== 'guiado') return;
  const t = e.target;
  if (t && t.tagName === 'INPUT' && t.dataset.campo) { e.preventDefault(); irACampo(S.idx + 1); }
});

function campoHTML(c, v, grande) {
  const ro = !puedeEditar() ? 'disabled' : '';
  const id = 'c_' + c.id;
  const alto = grande ? ' style="min-height:150px;font-size:16px"' : '';
  let ctrl = '';

  if (c.tipo === 'texto') ctrl = `<input type="text" id="${id}" data-campo="${c.id}" value="${esc(v || '')}" ${ro}>`;
  else if (c.tipo === 'numero') ctrl = `<input type="number" id="${id}" data-campo="${c.id}" value="${esc(v || '')}" ${ro}>`;
  else if (c.tipo === 'fecha') ctrl = `<input type="date" id="${id}" data-campo="${c.id}" value="${esc(v || '')}" ${ro}>`;
  else if (c.tipo === 'parrafo') ctrl = editorHTML(c, v, grande, !!ro);
  else if (c.tipo === 'lista') {
    const ops = opcionesDe(c);
    const esOtro = v && !ops.includes(v);
    ctrl = `<select id="${id}" data-lista="${c.id}" ${ro}><option value="">—</option>${
      ops.map(o => `<option ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('')
    }<option value="__otro__" ${esOtro ? 'selected' : ''}>Otro…</option></select>
    <input type="text" data-otro-lista="${c.id}" value="${esOtro ? esc(v) : ''}"
      placeholder="Escriba cuál" style="margin-top:8px${esOtro ? '' : ';display:none'}" ${ro}>`;
  }
  else if (c.tipo === 'si_no') ctrl = `<select id="${id}" data-campo="${c.id}" ${ro}><option value="">—</option><option value="si" ${v === 'si' ? 'selected' : ''}>Sí</option><option value="no" ${v === 'no' ? 'selected' : ''}>No</option></select>`;
  else if (c.tipo === 'persona') ctrl = `<select id="${id}" data-campo="${c.id}" ${ro}><option value="">—</option>${S.equipo.map(x => `<option value="${x.id}" ${v === x.id ? 'selected' : ''}>${esc(x.nombre)}</option>`).join('')}</select>`;
  else if (c.tipo === 'procesos') {
    const sel = Array.isArray(v) ? v : [];
    const otros = (S.indice || []).filter(x => !S.draft || x.id !== S.draft.id);
    const porArea = {};
    otros.forEach(x => { (porArea[x.area || 'Sin área'] = porArea[x.area || 'Sin área'] || []).push(x); });

    ctrl = otros.length
      ? `<div class="enlaces-caja">
          <div class="enlaces" data-procesos="${c.id}">
            ${Object.entries(porArea).map(([a, lista]) => `
              <div class="enlace-area">
                <div class="tiny enlace-area-nom">${esc(a)}</div>
                ${lista.map(x => `<label class="chip ${sel.includes(x.id) ? 'marcado' : ''}" style="cursor:pointer">
                  <input type="checkbox" value="${x.id}" ${sel.includes(x.id) ? 'checked' : ''} ${ro} style="width:auto;margin:0">
                  ${esc(x.nombre)}</label>`).join('')}
              </div>`).join('')}
          </div>
          <div class="tiny enlaces-nota">
            ¿No aparece el que le mencionaron? Es normal: significa que todavía nadie lo ha
            levantado. No marque nada — quedó escrito en la pregunta anterior y se enlaza solo
            cuando ese proceso exista.
          </div>
        </div>`
      : `<div class="enlaces-caja"><div class="mut">Este es el primer proceso registrado, así que
          todavía no hay con qué enlazarlo. Se enlaza solo más adelante, cuando el equipo levante
          los que van antes y después.</div></div>`;
  }
  else if (c.tipo === 'multi') {
    const sel = Array.isArray(v) ? v : [];
    const ops = opcionesDe(c);
    const otros = sel.filter(x => !ops.includes(x));
    ctrl = `<div class="flex wrap" data-multi="${c.id}">${ops.map(o =>
      `<label class="chip" style="cursor:pointer"><input type="checkbox" value="${esc(o)}" ${sel.includes(o) ? 'checked' : ''} ${ro} style="width:auto;margin:0"> ${esc(o)}</label>`).join('')}</div>
    <input type="text" data-otro-multi="${c.id}" value="${esc(otros.join(', '))}"
      placeholder="Otro (separe con comas si son varios)" style="margin-top:10px" ${ro}>`;
  }
  else if (c.tipo === 'pasos') {
    const inicial = S.draft && S.draft.responsable ? nombrePersona(S.draft.responsable) : '';
    const rows = Array.isArray(v) && v.length ? v
      : [{ actividad: '', responsable: inicial, sistema: '', tiempo: '', detalle: '', subtareas: [] }];
    ctrl = `${listaSugerencias('sug-resp', sugerenciasResponsable())}
      ${listaSugerencias('sug-sist', sugerenciasSistema())}
      ${EXPLICA_NIVELES}
      <div class="rowlist" data-pasos="${c.id}">
        ${rows.map((r, i) => pasoHTML(r, i, ro, c.id)).join('')}
      </div>
      ${ro ? '' : `<button class="btn sm" data-addpaso="${c.id}" style="margin-top:10px">+ Agregar otra actividad</button>`}`;
  }

  return `<div class="f" data-wrap="${c.id}">
    ${grande ? '' : `<span class="lbl">${esc(c.etiqueta)}${c.obligatorio ? '<span class="req">*</span>' : ''}</span>`}
    ${ctrl}
    ${ro ? '' : `<div class="ftools">
      <button class="btn accion" data-mic="${c.id}"><span class="ico">🎙</span> Grabar voz</button>
      <button class="btn accion" data-cam="${c.id}"><span class="ico">📷</span> Tomar foto</button>
      <button class="btn accion" data-file="${c.id}"><span class="ico">🖼</span> Subir imagen</button>
      <button class="btn accion" data-qr="${c.id}"><span class="ico">📱</span> Usar el celular</button>
      <span class="rec-slot" data-recslot="${c.id}"></span></div>`}
    <div class="ev" data-ev="${c.id}"></div>
  </div>`;
}

/** Nombres que se ofrecen como sugerencia en la columna Responsable. */
function sugerenciasResponsable() {
  const nombres = S.equipo.map(x => x.nombre);
  const roles = ['Admisionista', 'Enfermera', 'Médico', 'Optómetra', 'Auxiliar',
                 'Facturación', 'Cajera', 'Coordinadora', 'Paciente', 'Acompañante',
                 'Portería', 'Call center'];
  return [...new Set(nombres.concat(roles))];
}

/** Los sistemas salen del catálogo configurable, no de una lista fija. */
function sugerenciasSistema() {
  const cat = (S.config.catalogos || []).find(x => x.id === 'cat_sistemas');
  return cat ? (cat.opciones || []) : [];
}

function listaSugerencias(id, valores) {
  return `<datalist id="${id}">${valores.map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;
}

/** Las subtareas se guardaban como texto suelto; ahora cada una es un
    objeto con su propia descripción y su propia evidencia. Esto convierte
    lo viejo al leerlo, sin pedirle nada a nadie. */
function normalizarSub(t) {
  if (typeof t === 'string') return { texto: t, detalle: '' };
  return { texto: (t && t.texto) || '', detalle: (t && t.detalle) || '' };
}

/* La explicación de qué es cada nivel. Es lo primero que ve quien llena
   esta parte, porque es donde más se confunde la gente. */
const EXPLICA_NIVELES = `<div class="niveles">
  <div class="niv">
    <span class="et">El proceso</span>
    <span class="ej">Lo grande: “Atender al paciente en admisiones”</span>
  </div>
  <div class="flecha">▸</div>
  <div class="niv">
    <span class="et">Cada actividad</span>
    <span class="ej">Un momento con principio y fin: “Registrarlo en Agilmed”.
      Si cambia de lugar, de sistema o de persona, ya es <b>otra actividad</b>.</span>
  </div>
  <div class="flecha">▸</div>
  <div class="niv">
    <span class="et">Las sub-actividades</span>
    <span class="ej">Los pasitos de adentro: “Buscar por cédula”, “Verificar la EPS”</span>
  </div>
</div>`;

/** Una actividad, con su descripción y sus sub-actividades. */
function pasoHTML(r, i, ro, cid) {
  const subs = (Array.isArray(r.subtareas) ? r.subtareas : []).map(normalizarSub);
  const hayDetalle = (r.detalle || '').trim() || subs.length;
  const abierto = S.pasoAbierto === cid + '-' + i;

  return `<div class="actividad ${abierto ? 'abierta' : ''}" data-i="${i}">
    <div class="act-fila">
      <span class="num">${i + 1}</span>
      <input type="text" data-k="actividad" value="${esc(r.actividad || '')}"
        placeholder="Actividad ${i + 1}: ¿qué hace en este momento?" ${ro}>
      <input type="text" data-k="responsable" value="${esc(r.responsable || '')}"
        placeholder="¿Quién?" list="sug-resp" ${ro}>
      <input type="text" data-k="sistema" value="${esc(r.sistema || '')}"
        placeholder="¿Dónde lo registra?" list="sug-sist" ${ro}>
      <input type="text" data-k="tiempo" value="${esc(r.tiempo || '')}"
        placeholder="¿Cuánto tarda?" ${ro}>
      <button class="btn detalle ${hayDetalle ? 'con-detalle' : ''}" data-abrir="${cid}-${i}">
        ${abierto ? '▾ Cerrar' : (hayDetalle ? `Detalle${subs.length ? ' · ' + subs.length : ''}` : '+ Detalle')}</button>
      ${ro ? '<span></span>' : `<button class="btn quitar" data-delpaso="${i}" title="Quitar esta actividad">✕</button>`}
    </div>

    ${abierto ? `<div class="act-detalle">
      <div class="f">
        <span class="lbl">¿Cómo se hace esta actividad?</span>
        <span class="hint">Lo que le explicaría a alguien que llega nuevo. Qué abre, qué busca, qué revisa.</span>
        <textarea data-detalle="${i}" ${ro}
          placeholder="Ej: Entro a Agilmed por el módulo de Admisiones y busco al paciente por número de cédula.">${esc(r.detalle || '')}</textarea>
        ${ro ? '' : herramientasEvidencia(`${cid}:${i}`, 'esta actividad')}
        <div class="ev" data-ev="${cid}:${i}"></div>
      </div>

      <div class="sub-cab">
        <span class="lbl" style="margin:0;flex:1">Sub-actividades: los pasitos de adentro</span>
        <span class="tiny">${subs.length}</span>
      </div>
      <div class="subtareas" data-subs="${i}">
        ${subs.map((t, j) => `<div class="sub" data-j="${j}">
          <div class="sub-fila">
            <span class="vi">${i + 1}.${j + 1}</span>
            <input type="text" data-sub="${j}" value="${esc(t.texto)}"
              placeholder="Ej: Verificar que la EPS esté activa" ${ro}>
            ${ro ? '' : `<button class="btn quitar" data-delsub="${i}-${j}" title="Quitar este pasito">✕</button>`}
          </div>
          <textarea data-subdet="${j}" class="sub-det" ${ro}
            placeholder="Detalle de este pasito (opcional)">${esc(t.detalle)}</textarea>
          ${ro ? '' : herramientasEvidencia(`${cid}:${i}:${j}`, 'este pasito')}
          <div class="ev" data-ev="${cid}:${i}:${j}"></div>
        </div>`).join('')}
      </div>
      ${ro ? '' : `<button class="btn sm" data-addsub="${i}" style="margin-top:8px">+ Sub-actividad</button>`}
    </div>` : ''}
  </div>`;
}

/** Los mismos botones de evidencia, reutilizables en cualquier nivel. */
function herramientasEvidencia(ref, queEs) {
  return `<div class="ftools">
    <button class="btn accion" data-mic="${ref}" title="Grabar audio sobre ${queEs}"><span class="ico">🎙</span> Grabar</button>
    <button class="btn accion" data-cam="${ref}" title="Tomar foto de ${queEs}"><span class="ico">📷</span> Foto</button>
    <button class="btn accion" data-file="${ref}"><span class="ico">🖼</span> Subir</button>
    <button class="btn accion" data-qr="${ref}"><span class="ico">📱</span> Celular</button>
    <span class="rec-slot" data-recslot="${ref}"></span>
  </div>`;
}

function conectarCampos(cont) {
  if (!puedeEditar()) return;
  const p = S.draft;

  cont.querySelectorAll('[data-campo]').forEach(el => {
    el.oninput = el.onchange = () => {
      p.respuestas[el.dataset.campo] = el.value; refrescarAvance(); guardarDebounce();
    };
  });

  cont.querySelectorAll('[data-multi]').forEach(box => {
    box.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = () => {
      const cid = box.dataset.multi;
      const marcados = [...box.querySelectorAll('input:checked')].map(x => x.value);
      const libre = cont.querySelector(`[data-otro-multi="${cid}"]`);
      const libres = libre ? libre.value.split(',').map(x => x.trim()).filter(Boolean) : [];
      p.respuestas[cid] = marcados.concat(libres);
      refrescarAvance(); guardarDebounce();
    });
  });

  // ── Actividades ────────────────────────────────────────────────
  cont.querySelectorAll('[data-pasos]').forEach(box => {
    const cid = box.dataset.pasos;
    const filas = () => [...box.querySelectorAll('.actividad[data-i]')];

    /** Lee la tabla sin perder el detalle ni las subtareas de las filas cerradas. */
    const leer = () => filas().map(fila => {
      const i = +fila.dataset.i;
      const previo = (p.respuestas[cid] || [])[i] || {};
      const o = Object.assign({}, previo);
      fila.querySelectorAll('.act-fila input[data-k]').forEach(inp => o[inp.dataset.k] = inp.value);
      const det = fila.querySelector('[data-detalle]');
      if (det) o.detalle = det.value;
      const subs = fila.querySelector('[data-subs]');
      if (subs) {
        o.subtareas = [...subs.querySelectorAll('.sub[data-j]')].map(el => ({
          texto: (el.querySelector('input[data-sub]') || {}).value || '',
          detalle: (el.querySelector('textarea[data-subdet]') || {}).value || ''
        })).filter(x => x.texto.trim() || x.detalle.trim());
      }
      return o;
    });

    const aplicar = () => { p.respuestas[cid] = leer(); refrescarAvance(); guardarDebounce(); };

    box.querySelectorAll('input[data-k], [data-detalle], input[data-sub], [data-subdet]')
       .forEach(i => i.oninput = aplicar);

    box.querySelectorAll('[data-abrir]').forEach(b => b.onclick = () => {
      p.respuestas[cid] = leer();
      S.pasoAbierto = S.pasoAbierto === b.dataset.abrir ? null : b.dataset.abrir;
      pintarSecciones();
    });

    box.querySelectorAll('[data-delpaso]').forEach(b => b.onclick = () => {
      const rows = leer(); rows.splice(+b.dataset.delpaso, 1);
      p.respuestas[cid] = rows.length ? rows : [{ actividad: '', responsable: '', sistema: '', tiempo: '' }];
      S.pasoAbierto = null; guardarDebounce(); pintarSecciones();
    });

    box.querySelectorAll('[data-addsub]').forEach(b => b.onclick = () => {
      const rows = leer(); const i = +b.dataset.addsub;
      rows[i].subtareas = (rows[i].subtareas || []).map(normalizarSub).concat([{ texto: '', detalle: '' }]);
      p.respuestas[cid] = rows; guardarDebounce(); pintarSecciones();
    });

    box.querySelectorAll('[data-delsub]').forEach(b => b.onclick = () => {
      const [i, j] = b.dataset.delsub.split('-').map(Number);
      const rows = leer();
      rows[i].subtareas = (rows[i].subtareas || []).map(normalizarSub).filter((_, k) => k !== j);
      p.respuestas[cid] = rows; guardarDebounce(); pintarSecciones();
    });
  });

  cont.querySelectorAll('[data-addpaso]').forEach(b => b.onclick = () => {
    const cid = b.dataset.addpaso;
    const box = cont.querySelector(`[data-pasos="${cid}"]`);
    const rows = [...box.querySelectorAll('.actividad[data-i]')].map(fila => {
      const i = +fila.dataset.i;
      const o = Object.assign({}, (p.respuestas[cid] || [])[i] || {});
      fila.querySelectorAll('.act-fila input[data-k]').forEach(inp => o[inp.dataset.k] = inp.value);
      return o;
    });
    // La actividad nueva hereda el responsable de la anterior; si es la
    // primera, se propone quien tiene el proceso a cargo. Siempre se puede
    // sobrescribir escribiendo otro nombre.
    const previo = rows.length ? (rows[rows.length - 1].responsable || '') : '';
    const porDefecto = previo || (p.responsable ? nombrePersona(p.responsable) : '');
    rows.push({ actividad: '', responsable: porDefecto, sistema: '',
                tiempo: '', detalle: '', subtareas: [] });
    p.respuestas[cid] = rows; guardarDebounce(); pintarSecciones();
  });

  conectarEditores(cont);

  // Listas con opción "Otro"
  cont.querySelectorAll('[data-lista]').forEach(sel => {
    const cid = sel.dataset.lista;
    const libre = cont.querySelector(`[data-otro-lista="${cid}"]`);
    const aplicar = () => {
      const esOtro = sel.value === '__otro__';
      if (libre) libre.style.display = esOtro ? '' : 'none';
      p.respuestas[cid] = esOtro ? (libre ? libre.value : '') : sel.value;
      refrescarAvance(); guardarDebounce();
    };
    sel.onchange = () => { aplicar(); if (sel.value === '__otro__' && libre) libre.focus(); };
    if (libre) libre.oninput = aplicar;
  });

  cont.querySelectorAll('[data-procesos]').forEach(box => {
    box.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = () => {
      p.respuestas[box.dataset.procesos] = [...box.querySelectorAll('input:checked')].map(x => x.value);
      cb.closest('.chip').classList.toggle('marcado', cb.checked);
      refrescarAvance(); guardarDebounce();
    });
  });

  cont.querySelectorAll('[data-otro-multi]').forEach(inp => {
    const cid = inp.dataset.otroMulti;
    inp.oninput = () => {
      const box = cont.querySelector(`[data-multi="${cid}"]`);
      const marcados = box ? [...box.querySelectorAll('input:checked')].map(x => x.value) : [];
      const libres = inp.value.split(',').map(x => x.trim()).filter(Boolean);
      p.respuestas[cid] = marcados.concat(libres);
      refrescarAvance(); guardarDebounce();
    };
  });

  cont.querySelectorAll('[data-mic]').forEach(b => b.onclick = () => toggleGrabacion(b.dataset.mic));
  cont.querySelectorAll('[data-cam]').forEach(b => b.onclick = () => pedirImagen(b.dataset.cam, true));
  cont.querySelectorAll('[data-file]').forEach(b => b.onclick = () => pedirImagen(b.dataset.file, false));
  cont.querySelectorAll('[data-qr]').forEach(b => b.onclick = () => modalQR(S.draft, b.dataset.qr));
}

/* ── Evidencias ───────────────────────────────────────────────── */
function pintarEvidencias(p) {
  if (!p) return;
  const evs = p.evidencias || [];
  const campos = camposFlat();

  document.querySelectorAll('[data-ev]').forEach(box => {
    const cid = box.dataset.ev;
    const mias = evs.filter(e => e.campo === cid);
    box.innerHTML = mias.map(e => {
      const url = '/media/' + e.mediaId;
      const cel = e.origen === 'celular' ? '📱' : '';
      const acciones = puedeEditar() ? `
        <select class="mover" data-mover="${e.id}" title="Mover a otra pregunta">
          <option value="">Mover a…</option>
          ${campos.filter(x => x.c.id !== cid).map(x =>
            `<option value="${x.c.id}">${esc(x.c.etiqueta)}</option>`).join('')}
        </select>
        <button class="x" data-del="${e.id}" title="Eliminar">×</button>` : '';

      if (e.tipo === 'nota')
        return `<div class="ev-item nota">
          <div class="txt">${esc(e.nota || '')}</div>
          <div class="pie"><span class="tiny">Nota escrita ${cel}</span>${acciones}</div></div>`;

      if (e.tipo === 'foto')
        return `<div class="ev-item">
          <img class="thumb" src="${url}" alt="evidencia" data-big="${url}">
          <div class="pie">${cel ? '<span class="tiny">📱</span>' : ''}${acciones}</div></div>`;

      const dur = e.duracion ? `${Math.floor(e.duracion / 60)}:${String(e.duracion % 60).padStart(2, '0')}` : '';
      return `<div class="ev-item audio">
        <audio controls preload="none" src="${url}"></audio>
        <div class="pie"><span class="tiny">${dur} ${cel}</span>${acciones}</div></div>`;
    }).join('');

    box.querySelectorAll('[data-big]').forEach(i => i.onclick = () => lightbox(i.dataset.big));
    box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => borrarEvidencia(b.dataset.del));
    box.querySelectorAll('[data-mover]').forEach(sel => sel.onchange = () => {
      if (sel.value) moverEvidencia(sel.dataset.mover, sel.value);
    });
  });
}

/** Reubica una foto o audio que quedó en la pregunta equivocada. */
async function moverEvidencia(eid, campoDestino) {
  const p = S.draft;
  try {
    await api('/evidencias/' + eid, { method: 'PUT', body: { campo: campoDestino } });
    const ev = (p.evidencias || []).find(e => e.id === eid);
    if (ev) ev.campo = campoDestino;
    sincronizarEvidencias(p);
    pintarEvidencias(p);
    const destino = camposFlat().find(x => x.c.id === campoDestino);
    toast('Movido a: ' + (destino ? destino.c.etiqueta : 'otra pregunta'));
  } catch (_) { toast('No se pudo mover'); }
}

async function borrarEvidencia(eid) {
  const p = S.draft; if (!p) return;
  try {
    await api('/evidencias/' + eid, { method: 'DELETE' });
    p.evidencias = (p.evidencias || []).filter(e => e.id !== eid);
    sincronizarEvidencias(p);
    pintarEvidencias(p);
  } catch (_) { toast('No se pudo eliminar'); }
}

function sincronizarEvidencias(p) {
  const i = S.procesos.findIndex(x => x.id === p.id);
  if (i >= 0) S.procesos[i].evidencias = JSON.parse(JSON.stringify(p.evidencias || []));
}

async function subirEvidencia(campo, tipo, blob, nombre, duracion) {
  const p = S.draft;
  // Se escribe primero en la cola local: si falla la red, se reintenta solo.
  await Almacen.encolarArchivo({
    url: '/api/procesos/' + p.id + '/evidencias',
    procesoId: p.id, blob, nombre,
    campos: { tipo, campo: campo || '', duracion: String(duracion || 0) }
  });
  toast(navigator.onLine ? 'Guardando…' : 'Guardado local — se sube al recuperar señal');
  pintarEvidencias(p);
}

/* Cuando la cola confirma una subida, se refresca el proceso desde el servidor
   para que la evidencia quede con su id real. */
Almacen.alCambiar(async (n, detalle) => {
  pintarBadgeCola(n);
  if (!detalle || !detalle.subido) return;
  const pid = detalle.subido.procesoId;
  try {
    const d = await api('/procesos');
    S.procesos = d.procesos;
    if (S.draft && S.draft.id === pid) {
      const fresco = S.procesos.find(x => x.id === pid);
      if (fresco) { S.draft.evidencias = fresco.evidencias; pintarEvidencias(S.draft); }
    }
  } catch (_) {}
});

function pintarBadgeCola(n) {
  let el = document.getElementById('badgeCola');
  if (!n) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'badgeCola';
    el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:100;background:var(--brand);' +
      'color:#fff;border-radius:99px;padding:9px 16px;font-size:13px;font-weight:600;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.25)';
    document.body.appendChild(el);
  }
  el.textContent = navigator.onLine
    ? `⇡ Subiendo ${n} archivo(s)…`
    : `⚠ ${n} archivo(s) esperando señal`;
}

function pedirImagen(campo, camara) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = !camara;
  if (camara) inp.setAttribute('capture', 'environment');
  inp.onchange = async () => {
    for (const f of inp.files) {
      const b = await comprimir(f);
      await subirEvidencia(campo, 'foto', b, 'foto.jpg', 0);
    }
  };
  inp.click();
}

function comprimir(file, max = 1600, q = 0.82) {
  return new Promise(res => {
    const img = new Image(), fr = new FileReader();
    fr.onload = () => {
      img.onload = () => {
        let w = img.width, h = img.height;
        if (Math.max(w, h) > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        cv.toBlob(b => res(b || file), 'image/jpeg', q);
      };
      img.onerror = () => res(file);
      img.src = fr.result;
    };
    fr.onerror = () => res(file);
    fr.readAsDataURL(file);
  });
}

/* ── Grabación de voz ─────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════
   Grabación de voz

   Las entrevistas duran minutos, no segundos, y el navegador conspira
   contra eso: apaga la pantalla, suspende la pestaña, corta el micrófono.
   Por eso aquí hay más defensas que en el resto de la aplicación.
   ═══════════════════════════════════════════════════════════════ */
async function toggleGrabacion(ref) {
  if (S.rec) { detenerGrabacion(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    toast('Este navegador no permite grabar'); return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });
  } catch (_) { toast('Sin permiso de micrófono'); return; }

  let mime = 'audio/webm', ext = 'webm';
  if (window.MediaRecorder.isTypeSupported && !MediaRecorder.isTypeSupported('audio/webm')) {
    if (MediaRecorder.isTypeSupported('audio/mp4')) { mime = 'audio/mp4'; ext = 'm4a'; }
    else { mime = ''; ext = 'm4a'; }
  }

  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const trozos = [];
  const grupo = 'g_' + Date.now();
  let n = 0;
  const tipoReal = () => (mr.mimeType ? mr.mimeType.split(';')[0] : (mime || 'audio/mp4'));

  mr.ondataavailable = e => {
    if (!e.data || !e.data.size) return;
    trozos.push(e.data);
    // Cada trozo se guarda en disco apenas llega: si el navegador mata la
    // página a mitad de la entrevista, lo grabado hasta ahí no se pierde.
    Almacen.guardarTrozo(grupo, {
      campo: ref, tipo: tipoReal(), nombre: 'nota.' + ext,
      duracion: S.recT, procesoId: S.draft ? S.draft.id : ''
    }, e.data, n++).catch(() => {});
  };

  mr.onerror = () => { toast('La grabación se interrumpió. Se guarda lo que alcanzó.'); detenerGrabacion(); };

  mr.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    soltarPantalla();
    const blob = new Blob(trozos, { type: tipoReal() });
    Almacen.borrarGrabacion(grupo).catch(() => {});
    if (blob.size) await subirEvidencia(ref, 'audio', blob, 'nota.' + ext, S.recT);
    else toast('No se grabó nada. Revisa el permiso del micrófono.');
  };

  // Si el micrófono se corta solo (bloqueo de pantalla, otra app lo toma),
  // no se pierde: se cierra la grabación y se sube lo que haya.
  stream.getAudioTracks().forEach(t => {
    t.onended = () => { if (S.rec) { toast('El micrófono se cerró. Se guarda lo grabado.'); detenerGrabacion(); } };
  });

  mr.start(4000);                    // un trozo cada 4 segundos
  S.rec = mr; S.recCampo = ref; S.recT = 0;
  mantenerPantalla();
  panelGrabando();

  S.recTimer = setInterval(() => {
    S.recT++;
    const t = document.getElementById('recTime');
    if (t) t.textContent = Math.floor(S.recT / 60) + ':' + String(S.recT % 60).padStart(2, '0');
    if (mr.state === 'inactive' && S.rec) { detenerGrabacion(); return; }
    if (S.recT >= 3600) detenerGrabacion();          // tope de una hora
  }, 1000);
}

/** Panel a pantalla completa: además de ser claro, evita que la página
    se redibuje por debajo y deje la grabación huérfana. */
function panelGrabando() {
  const d = document.createElement('div');
  d.className = 'grabando'; d.id = 'panelGrab';
  d.innerHTML = `
    <div class="onda">🎙</div>
    <div class="t" id="recTime">0:00</div>
    <div style="opacity:.75;font-size:14px">Grabando</div>
    <button class="btn p" id="gStop" style="padding:14px 34px;font-size:16px">Detener y guardar</button>
    <div class="tiny" style="color:#9fb0c0;max-width:280px;text-align:center">
      Se guarda cada 4 segundos. Puede hablar todo lo que necesite: el tope es una hora.
    </div>`;
  document.body.appendChild(d);
  document.getElementById('gStop').onclick = detenerGrabacion;
}

function detenerGrabacion() {
  if (!S.rec) return;
  const mr = S.rec;
  S.rec = null;
  clearInterval(S.recTimer);
  try { if (mr.state !== 'inactive') mr.stop(); } catch (_) {}
  const panel = document.getElementById('panelGrab');
  if (panel) panel.remove();
  const slot = document.querySelector(`[data-recslot="${S.recCampo}"]`);
  if (slot) slot.innerHTML = '';
  S.recCampo = null;
}

/* Mantener la pantalla encendida mientras se graba. Sin esto, el equipo se
   bloquea a los pocos segundos y el micrófono se corta con él. */
let _wake = null;
async function mantenerPantalla() {
  try { if ('wakeLock' in navigator) _wake = await navigator.wakeLock.request('screen'); }
  catch (_) {}
}
function soltarPantalla() {
  try { if (_wake) { _wake.release(); _wake = null; } } catch (_) {}
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.rec && !_wake) mantenerPantalla();
});

/** Al abrir la app, sube lo que quedó de una grabación interrumpida. */
async function recuperarGrabacionesPendientes() {
  try {
    const gs = await Almacen.recuperarGrabaciones();
    for (const g of gs) {
      if (!g.procesoId || !g.trozos.length) continue;
      const blob = new Blob(g.trozos, { type: g.tipo || 'audio/webm' });
      await Almacen.encolarArchivo({
        url: '/api/procesos/' + g.procesoId + '/evidencias',
        procesoId: g.procesoId, blob, nombre: g.nombre || 'nota.webm',
        campos: { tipo: 'audio', campo: g.campo || '', duracion: String(g.duracion || 0) }
      });
      await Almacen.borrarGrabacion(g.id);
      toast('Se recuperó una grabación interrumpida');
    }
  } catch (_) {}
}

function lightbox(src) {
  const d = document.createElement('div');
  d.className = 'lightbox';
  d.innerHTML = `<img src="${src}">`;
  d.onclick = () => d.remove();
  document.body.appendChild(d);
}

/* ── Equipo ───────────────────────────────────────────────────── */
function vistaEquipo(m) {
  m.innerHTML = `
  <div class="topbar"><h1>Equipo</h1><div class="sp"></div>
    ${esAdmin() ? '<button class="btn p" id="addP">+ Agregar persona</button>' : ''}</div>
  <div class="banner">
    Cada persona entra con su usuario desde el computador o el celular.<br>
    ${ROLES.map(r => `<b>${esc(r.n.split(' — ')[0].split(' / ')[0])}</b>: ${esc(r.d.split('.')[0])}.`).join('<br>')}
  </div>
  <div class="card"><div class="tw"><table class="t">
    <thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Contacto</th><th>Procesos</th>${esAdmin() ? '<th style="width:90px"></th>' : ''}</tr></thead>
    <tbody>${S.equipo.map(p => {
      const n = S.procesos.filter(x => x.responsable === p.id).length;
      const pr = presencia(p);
      return `<tr><td><span class="flex" style="gap:8px">${puntoPresencia(p)}<b>${esc(p.nombre)}</b></span>
          <div class="tiny" style="margin-left:18px">${esc(pr.texto)}</div></td>
        <td class="mut">${esc(p.usuario)}</td>
        <td><span class="chip">${esc((ROLES.find(r => r.k === p.rol) || { n: p.rol }).n)}</span></td><td class="mut">${esc(p.contacto || '—')}</td><td>${n}</td>
        ${esAdmin() ? `<td><button class="btn sm ic" data-edit="${p.id}">✎</button>
          ${p.id !== S.yo.id ? `<button class="btn sm ic danger" data-del="${p.id}">×</button>` : ''}</td>` : ''}</tr>`;
    }).join('')}</tbody></table></div></div>`;

  const a = document.getElementById('addP'); if (a) a.onclick = () => modalPersona();
  m.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => modalPersona(persona(b.dataset.edit)));
  m.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    await api('/usuarios/' + b.dataset.del, { method: 'DELETE' });
    S.equipo = S.equipo.filter(x => x.id !== b.dataset.del);
    render(); toast('Persona desactivada');
  });
}

function modalPersona(p) {
  const ed = !!p;
  modal(`<h3>${ed ? 'Editar persona' : 'Agregar persona'}</h3>
    <div class="grid g2">
      <label class="f"><span class="lbl">Nombre <span class="req">*</span></span><input type="text" id="eNom" value="${esc(ed ? p.nombre : '')}"></label>
      <label class="f"><span class="lbl">Usuario ${ed ? '' : '<span class="req">*</span>'}</span>
        <input type="text" id="eUsr" value="${esc(ed ? p.usuario : '')}" ${ed ? 'disabled' : ''} autocapitalize="none"></label>
    </div>
    <div class="grid g2">
      <label class="f"><span class="lbl">Rol</span><select id="eRol">
        ${ROLES.map(r => `<option value="${r.k}" ${ed && p.rol === r.k ? 'selected' : (!ed && r.k === 'analista' ? 'selected' : '')}>${esc(r.n)}</option>`).join('')}</select>
        <span class="hint" id="rolAyuda" style="margin-top:6px"></span></label>
      <label class="f"><span class="lbl">Contacto</span><input type="text" id="eCon" value="${esc(ed ? p.contacto || '' : '')}"></label>
    </div>
    <label class="f"><span class="lbl">${ed ? 'Nueva contraseña (opcional)' : 'Contraseña'} ${ed ? '' : '<span class="req">*</span>'}</span>
      <input type="password" id="ePwd" autocomplete="new-password" placeholder="Mínimo 8 caracteres"></label>
    <div class="flex"><button class="btn" data-cerrar>Cancelar</button><button class="btn p right" id="eOk">Guardar</button></div>`,
  box => {
    // La descripción cambia con la selección: los nombres de rol solos no
    // dicen gran cosa, y equivocarse aquí da acceso de más o de menos.
    const selRol = box.querySelector('#eRol');
    const ayuda = box.querySelector('#rolAyuda');
    const pintarAyuda = () => {
      const r = ROLES.find(x => x.k === selRol.value);
      ayuda.textContent = r ? r.d : '';
    };
    selRol.onchange = pintarAyuda;
    pintarAyuda();

    box.querySelector('#eOk').onclick = async () => {
      const body = {
        nombre: box.querySelector('#eNom').value.trim(),
        rol: box.querySelector('#eRol').value,
        contacto: box.querySelector('#eCon').value.trim()
      };
      const pwd = box.querySelector('#ePwd').value;
      if (pwd) body.password = pwd;
      if (!body.nombre) { toast('Falta el nombre'); return; }
      try {
        if (ed) await api('/usuarios/' + p.id, { method: 'PUT', body });
        else {
          body.usuario = box.querySelector('#eUsr').value.trim().toLowerCase();
          if (!body.usuario) { toast('Falta el usuario'); return; }
          if (!pwd) { toast('Define una contraseña'); return; }
          await api('/usuarios', { method: 'POST', body });
        }
        const d = await api('/usuarios');
        S.equipo = d.equipo; cerrarModal(); render(); toast('Guardado');
      } catch (e) {
        const c = (e.data && e.data.error) || '';
        toast(c === 'usuario_ya_existe' ? 'Ese usuario ya existe' : (c || 'No se pudo guardar'));
      }
    };
  });
}

/* ── Constructor de plantilla ─────────────────────────────────── */
function vistaPlantilla(m) {
  if (!esAdmin()) { m.innerHTML = '<div class="empty">Solo el administrador puede editar la plantilla.</div>'; return; }
  S.editandoPlantilla = true;
  const t = S.plantilla;

  m.innerHTML = `
  <div class="topbar"><h1>Plantilla</h1><div class="sp"></div>
    <button class="btn" id="addSec">+ Sección</button>
    <button class="btn p" id="saveTpl">Guardar plantilla</button></div>
  <div class="banner">Esta es la estructura con la que se levanta cada proceso. Al cambiarla, todos los procesos usan la nueva versión; las respuestas de campos eliminados dejan de mostrarse pero quedan guardadas en la base.</div>
  <div id="tplBox">${(t.secciones || []).map((s, i) => secEditorHTML(s, i)).join('')}</div>`;

  document.getElementById('addSec').onclick = () => {
    leerPlantilla(m);
    t.secciones.push({ id: 's_' + Math.random().toString(36).slice(2, 9), nombre: 'Nueva sección', campos: [] });
    vistaPlantilla(m);
  };
  document.getElementById('saveTpl').onclick = async () => {
    leerPlantilla(m);
    try {
      await api('/plantilla', { method: 'PUT', body: { secciones: t.secciones } });
      S.editandoPlantilla = false; toast('Plantilla guardada'); render();
    } catch (_) { toast('No se pudo guardar la plantilla'); }
  };

  m.querySelectorAll('[data-addcampo]').forEach(b => b.onclick = () => {
    leerPlantilla(m);
    t.secciones[+b.dataset.addcampo].campos.push({
      id: 'f_' + Math.random().toString(36).slice(2, 9),
      etiqueta: 'Nuevo campo', tipo: 'texto', obligatorio: false,
      opciones: [], ayuda: '', pregunta: '', ejemplo: '', catalogo: ''
    });
    vistaPlantilla(m);
  });
  m.querySelectorAll('[data-delsec]').forEach(b => b.onclick = () => {
    leerPlantilla(m); t.secciones.splice(+b.dataset.delsec, 1); vistaPlantilla(m);
  });
  m.querySelectorAll('[data-upsec]').forEach(b => b.onclick = () => {
    leerPlantilla(m); const i = +b.dataset.upsec;
    if (i > 0) { const [x] = t.secciones.splice(i, 1); t.secciones.splice(i - 1, 0, x); }
    vistaPlantilla(m);
  });
  m.querySelectorAll('[data-downsec]').forEach(b => b.onclick = () => {
    leerPlantilla(m); const i = +b.dataset.downsec;
    if (i < t.secciones.length - 1) { const [x] = t.secciones.splice(i, 1); t.secciones.splice(i + 1, 0, x); }
    vistaPlantilla(m);
  });
  m.querySelectorAll('.cTipo, .cCat').forEach(sel => sel.onchange = () => {
    leerPlantilla(m); vistaPlantilla(m);
  });
  m.querySelectorAll('[data-delcampo]').forEach(b => b.onclick = () => {
    leerPlantilla(m);
    const [si, ci] = b.dataset.delcampo.split('-').map(Number);
    t.secciones[si].campos.splice(ci, 1); vistaPlantilla(m);
  });
}

function secEditorHTML(s, si) {
  const cats = S.config.catalogos || [];
  return `<section class="sec" data-si="${si}"><header style="cursor:default">
    <input type="text" class="secNom" value="${esc(s.nombre)}" style="font-weight:600;max-width:340px">
    <div class="right flex" style="gap:5px">
      <button class="btn sm ic" data-upsec="${si}">↑</button>
      <button class="btn sm ic" data-downsec="${si}">↓</button>
      <button class="btn sm ic danger" data-delsec="${si}">×</button>
    </div></header>
    <div class="body">
      ${(s.campos || []).map((c, ci) => {
        const esLista = c.tipo === 'lista' || c.tipo === 'multi';
        return `<div class="campo-edit" data-ci="${ci}">
          <div class="flex" style="gap:8px;margin-bottom:8px">
            <input type="text" class="cEt" value="${esc(c.etiqueta)}" placeholder="Nombre corto del campo" style="flex:1.3">
            <select class="cTipo" style="flex:1">${TIPOS_CAMPO.map(t => `<option value="${t.k}" ${c.tipo === t.k ? 'selected' : ''}>${t.n}</option>`).join('')}</select>
            <label class="tiny flex" style="gap:5px;white-space:nowrap">
              <input type="checkbox" class="cObl" ${c.obligatorio ? 'checked' : ''} style="width:auto"> Obligatorio</label>
            <button class="btn sm ic danger" data-delcampo="${si}-${ci}">×</button>
          </div>

          <input type="text" class="cPreg" value="${esc(c.pregunta || '')}"
            placeholder="¿Cómo se lo pregunta a la persona? Ej: ¿Qué tiene que pasar para que usted empiece?"
            style="margin-bottom:6px">
          <input type="text" class="cAyuda" value="${esc(c.ayuda || '')}"
            placeholder="Aclaración: qué se espera que responda" style="margin-bottom:6px">
          <input type="text" class="cEjem" value="${esc(c.ejemplo || '')}"
            placeholder="Respuesta de ejemplo, para que no arranque de cero">

          ${esLista ? `<div class="flex" style="gap:8px;margin-top:8px">
            <select class="cCat" style="max-width:190px">
              <option value="">Opciones propias</option>
              ${cats.map(x => `<option value="${x.id}" ${c.catalogo === x.id ? 'selected' : ''}>${esc(x.nombre)}</option>`).join('')}
            </select>
            <input type="text" class="cOpc" value="${esc((c.opciones || []).join(' | '))}"
              placeholder="Opción 1 | Opción 2" ${c.catalogo ? 'disabled' : ''} style="flex:1">
          </div>` : ''}
        </div>`;
      }).join('')}
      <button class="btn sm" data-addcampo="${si}" style="margin-top:6px">+ Campo</button>
    </div></section>`;
}

function leerPlantilla(m) {
  const t = S.plantilla;
  m.querySelectorAll('section[data-si]').forEach(sec => {
    const si = +sec.dataset.si;
    t.secciones[si].nombre = sec.querySelector('.secNom').value;
    sec.querySelectorAll('.campo-edit[data-ci]').forEach(row => {
      const c = t.secciones[si].campos[+row.dataset.ci];
      const val = sel => { const e = row.querySelector(sel); return e ? e.value : ''; };
      c.etiqueta = val('.cEt');
      c.tipo = val('.cTipo');
      c.pregunta = val('.cPreg');
      c.ayuda = val('.cAyuda');
      c.ejemplo = val('.cEjem');
      c.obligatorio = row.querySelector('.cObl').checked;
      if (c.tipo === 'lista' || c.tipo === 'multi') {
        c.catalogo = val('.cCat');
        c.opciones = c.catalogo ? [] : val('.cOpc').split('|').map(x => x.trim()).filter(Boolean);
      } else { c.opciones = []; c.catalogo = ''; }
    });
  });
}

/* ── Ajustes ──────────────────────────────────────────────────── */
function vistaAjustes(m) {
  m.innerHTML = `
  <div class="topbar"><h1>Ajustes</h1></div>
  <div class="grid g2">
    ${esAdmin() ? `<div class="card">
      <h3>Proyecto</h3>
      <label class="f"><span class="lbl">Nombre del proyecto</span><input type="text" id="aProy" value="${esc(S.config.proyecto || '')}"></label>
      <label class="f"><span class="lbl">Organización</span><input type="text" id="aOrg" value="${esc(S.config.organizacion || '')}"></label>
      <label class="f"><span class="lbl">Áreas (una por línea)</span><textarea id="aAreas" style="min-height:150px">${esc((S.config.areas || []).join('\n'))}</textarea></label>

      <h3 style="margin-top:22px">Estados del flujo</h3>
      <p class="mut" style="font-size:13px;margin-top:-4px">Cámbiales el nombre para que hablen como tu equipo. El orden y el comportamiento no cambian.</p>
      <div class="grid g2" style="gap:10px">
        ${ESTADOS_BASE.map(e => {
          const act = (S.config.estados || ESTADOS_BASE).find(x => x.k === e.k) || e;
          return `<label class="f" style="margin:0"><span class="lbl">${e.n}</span>
            <input type="text" data-estado="${e.k}" value="${esc(act.n)}"></label>`;
        }).join('')}
      </div>

      <h3 style="margin-top:22px">Listas desplegables</h3>
      <p class="mut" style="font-size:13px;margin-top:-4px">Cada lista se puede usar en cualquier campo de la plantilla. Si cambias una opción aquí, cambia en todos los campos que la usan.</p>
      <div id="cats">${(S.config.catalogos || []).map((c, i) => catHTML(c, i)).join('')}</div>
      <button class="btn sm" id="addCat" style="margin-bottom:16px">+ Nueva lista</button>

      <div><button class="btn p" id="aOk">Guardar configuración</button></div>
    </div>` : '<div class="card"><h3>Proyecto</h3><p class="mut">Solo el administrador puede cambiar la configuración.</p></div>'}

    <div>
      <div class="card" style="margin-bottom:14px">
        <h3>Exportar</h3>
        <p class="mut">Descarga lo levantado para el informe o para el equipo de desarrollo.</p>
        <div class="flex wrap" style="gap:8px;margin-top:10px">
          <a class="btn" href="/api/export/csv">⤓ CSV de procesos</a>
          <a class="btn" href="/api/export/json">⤓ JSON completo</a>
        </div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <h3>Mi cuenta</h3>
        <label class="f"><span class="lbl">Contraseña actual</span><input type="password" id="pwA" autocomplete="current-password"></label>
        <label class="f"><span class="lbl">Nueva contraseña</span><input type="password" id="pwB" autocomplete="new-password" placeholder="Mínimo 8 caracteres"></label>
        <button class="btn" id="pwOk">Cambiar contraseña</button>
      </div>
      ${esAdmin() ? `<div class="card" style="margin-bottom:14px">
        <h3>Análisis con Claude</h3>
        <p class="mut">Con una llave de Anthropic, cada proceso puede pedir un análisis:
          resumen, paso a paso ordenado, mejoras, automatizaciones y conexiones sugeridas.
          El análisis nunca modifica el levantamiento; solo se adjunta lo que apruebes.</p>
        <div id="iaConf" class="mut" style="margin-top:10px">Consultando…</div>
      </div>` : ''}

      <div class="card">
        <h3>Apariencia</h3>
        <div class="flex" style="gap:8px">
          <button class="btn sm" data-tema="light">Claro</button>
          <button class="btn sm" data-tema="dark">Oscuro</button>
          <button class="btn sm" data-tema="">Automático</button>
        </div>
      </div>
    </div>
  </div>`;

  const addC = document.getElementById('addCat');
  if (addC) addC.onclick = () => {
    S.config.catalogos = leerCatalogos();
    S.config.catalogos.push({ id: 'cat_' + Math.random().toString(36).slice(2, 8), nombre: 'Nueva lista', opciones: [] });
    vistaAjustes(m);
  };
  m.querySelectorAll('[data-delcat]').forEach(b => b.onclick = () => {
    const cats = leerCatalogos();
    cats.splice(+b.dataset.delcat, 1);
    S.config.catalogos = cats;
    vistaAjustes(m);
  });

  const ok = document.getElementById('aOk');
  if (ok) ok.onclick = async () => {
    try {
      const d = await api('/config', { method: 'PUT', body: {
        proyecto: document.getElementById('aProy').value.trim(),
        organizacion: document.getElementById('aOrg').value.trim(),
        areas: document.getElementById('aAreas').value.split('\n').map(x => x.trim()).filter(Boolean),
        estados: [...document.querySelectorAll('[data-estado]')].map(i => ({ k: i.dataset.estado, n: i.value.trim() })),
        catalogos: leerCatalogos()
      }});
      S.config = d.config;
      if (Array.isArray(d.config.estados) && d.config.estados.length === 4) ESTADOS = d.config.estados;
      toast('Configuración guardada'); render();
    } catch (_) { toast('No se pudo guardar'); }
  };

  document.getElementById('pwOk').onclick = async () => {
    const actual = document.getElementById('pwA').value;
    const nueva = document.getElementById('pwB').value;
    if (!actual || !nueva) { toast('Completa las dos casillas'); return; }
    try {
      await api('/me/password', { method: 'POST', body: { actual, nueva } });
      document.getElementById('pwA').value = ''; document.getElementById('pwB').value = '';
      toast('Contraseña actualizada');
    } catch (e) {
      const c = (e.data && e.data.error) || '';
      toast(c === 'password_actual_incorrecta' ? 'La contraseña actual no coincide' : (c || 'No se pudo cambiar'));
    }
  };

  if (esAdmin()) pintarConfigIA();

  m.querySelectorAll('[data-tema]').forEach(b => b.onclick = () => {
    const t = b.dataset.tema;
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('lp_tema', t); } catch (_) {}
  });
}

/* ── Modal ────────────────────────────────────────────────────── */
function modal(html, cb) {
  cerrarModal();
  const d = document.createElement('div');
  d.className = 'modal'; d.id = 'modalBox';
  d.innerHTML = `<div class="box">${html}</div>`;
  d.onclick = e => { if (e.target === d) cerrarModal(); };
  document.body.appendChild(d);
  d.querySelectorAll('[data-cerrar]').forEach(b => b.onclick = cerrarModal);
  if (cb) cb(d.querySelector('.box'));
}
function cerrarModal() {
  const d = document.getElementById('modalBox');
  if (d) d.remove();
}

/* ── Arranque menor ───────────────────────────────────────────── */
try { const t = localStorage.getItem('lp_tema'); if (t) document.documentElement.setAttribute('data-theme', t); } catch (_) {}
window.addEventListener('beforeunload', e => {
  if (S.dirty) { respaldarLocal(); e.preventDefault(); e.returnValue = ''; }
});

/* ═══════════════════════════════════════════════════════════════
   Captura desde el celular: enlace + QR
   ═══════════════════════════════════════════════════════════════ */
async function modalQR(p, campoId) {
  const campo = campoId
    ? (camposPlanos().find(c => c.id === campoId) || {}).etiqueta || ''
    : '';

  modal(`<h3>Capturar desde el celular</h3>
    <p class="mut" style="margin-top:-6px">
      ${campo ? `Todo lo que captures entrará en <b>${esc(campo)}</b>.`
              : 'Podrás elegir la pregunta desde el celular.'}
    </p>
    <div id="qrBox" style="text-align:center;padding:18px 0">
      <div class="mut">Generando enlace…</div>
    </div>
    <div id="qrInfo"></div>
    <div class="flex" style="margin-top:14px">
      <button class="btn" data-cerrar>Cerrar</button>
      <button class="btn right" id="qrCopiar">Copiar enlace</button>
    </div>`, async box => {
    try {
      const d = await api('/procesos/' + p.id + '/capture-link', {
        method: 'POST', body: { campo: campoId || '' }
      });

      box.querySelector('#qrBox').innerHTML = d.qr
        ? `<div style="display:inline-block;background:#fff;padding:12px;border-radius:12px">${d.qr}</div>`
        : '<div class="mut">QR no disponible; usa el enlace de abajo.</div>';

      box.querySelector('#qrInfo').innerHTML = `
        <ol class="mut" style="padding-left:18px;line-height:1.8;margin:0 0 12px">
          <li>Abre la cámara del celular y apunta al código.</li>
          <li>Toca 📷 para fotos o 🎙 para grabar la entrevista.</li>
          <li>Todo cae en este proceso automáticamente. No hay que iniciar sesión.</li>
        </ol>
        <input type="text" id="qrUrl" value="${esc(d.url)}" readonly style="font-size:12px">
        <div class="tiny" style="margin-top:8px">
          El enlace vence en ${d.horas} horas y solo sirve para este proceso.
          Al generar uno nuevo, el anterior deja de funcionar.
        </div>`;

      box.querySelector('#qrCopiar').onclick = async () => {
        try {
          await navigator.clipboard.writeText(d.url);
          toast('Enlace copiado');
        } catch (_) {
          box.querySelector('#qrUrl').select();
          toast('Selecciona y copia el enlace');
        }
      };
    } catch (_) {
      box.querySelector('#qrBox').innerHTML = '<div class="mut">No se pudo generar el enlace.</div>';
    }
  });
}

/* Arranque de la cola: reintenta lo que quedó pendiente de sesiones previas. */
Almacen.procesar();
recuperarGrabacionesPendientes();
Almacen.contar().then(n => { if (n) pintarBadgeCola(n); });
window.addEventListener('online', () => pintarBadgeCola(0) || Almacen.procesar());

/* ═══════════════════════════════════════════════════════════════
   Enviar el proceso y compartirlo en formato legible
   ═══════════════════════════════════════════════════════════════ */
async function enviarProceso(p, forzar) {
  // Lo pendiente en la cola se sube primero: no se envía un informe
  // al que le falten fotos o audios por subir.
  const pend = (await Almacen.pendientes(p.id)).length;
  if (pend && !forzar) {
    toast(`Faltan ${pend} archivo(s) por subir. Espera un momento…`);
    Almacen.procesar();
    return;
  }

  try {
    const d = await api('/procesos/' + p.id + '/enviar', {
      method: 'POST', body: { forzar: !!forzar }
    });
    p.estado = 'en_revision';
    p.enviosTotal = d.numero;
    p.informeUrl = d.url;
    const i = S.procesos.findIndex(x => x.id === p.id);
    if (i >= 0) {
      S.procesos[i].estado = 'en_revision';
      S.procesos[i].enviosTotal = d.numero;
      S.procesos[i].informeUrl = d.url;
    }
    modalCompartir(p, d);
  } catch (e) {
    if (e.status === 422) return modalFaltantes(p, e.data);
    toast('No se pudo enviar');
  }
}

function modalFaltantes(p, d) {
  modal(`<h3>Faltan campos obligatorios</h3>
    <p class="mut" style="margin-top:-6px">El levantamiento va en ${d.avance}%. Sin estos datos, quien reciba el informe va a tener que preguntarte:</p>
    <ul style="font-size:14px;line-height:1.8;padding-left:20px;max-height:220px;overflow:auto">
      ${d.faltan.map(f => `<li>${esc(f)}</li>`).join('')}
    </ul>
    <div class="flex" style="margin-top:16px">
      <button class="btn" data-cerrar>Seguir completando</button>
      <button class="btn p right" id="forzar">Enviar así</button>
    </div>`, box => {
    box.querySelector('#forzar').onclick = () => { cerrarModal(); enviarProceso(p, true); };
  });
}

function modalCompartir(p, d) {
  const wa = 'https://wa.me/?text=' + encodeURIComponent(d.texto);
  const asunto = `Levantamiento: ${p.nombre}`;
  const correo = 'mailto:?subject=' + encodeURIComponent(asunto) +
                 '&body=' + encodeURIComponent(d.texto);

  modal(`<h3>${d.numero > 1 ? `Reenviado (envío #${d.numero})` : 'Proceso enviado'}</h3>
    <p class="mut" style="margin-top:-6px">
      Quedó registrado en el proceso con ${d.fotos} foto(s) y ${d.audios} nota(s) de voz, al ${d.avance}%.
    </p>

    <div class="banner" style="margin:14px 0">
      Comparte el <b>enlace</b>, no un archivo. Se abre en el navegador del celular y ahí
      se ven las fotos y se <b>escuchan los audios</b>. Un PDF no puede reproducirlos.
    </div>

    <div class="flex wrap" style="gap:8px;margin-bottom:14px">
      <a class="btn p" href="${wa}" target="_blank" rel="noopener">📲 WhatsApp</a>
      <a class="btn" href="${correo}">✉ Correo</a>
      <a class="btn" href="${esc(d.url)}" target="_blank" rel="noopener">👁 Ver informe</a>
    </div>

    <span class="lbl">Enlace del informe</span>
    <input type="text" id="shUrl" value="${esc(d.url)}" readonly style="font-size:12px">

    <span class="lbl" style="margin-top:14px">Mensaje listo para pegar</span>
    <textarea id="shTxt" readonly style="min-height:130px;font-size:13px">${esc(d.texto)}</textarea>

    <div class="flex" style="margin-top:14px">
      <button class="btn" id="copiarTxt">Copiar mensaje</button>
      <button class="btn right" data-cerrar>Cerrar</button>
    </div>
    <div class="tiny" style="margin-top:12px">
      El enlace sigue vivo: si completas más datos y vuelves a enviar, quien ya lo tiene
      ve la versión actualizada sin que le mandes nada nuevo. Puedes anularlo desde
      el proceso si ya no quieres que se vea.
    </div>`, box => {
    box.querySelector('#copiarTxt').onclick = async () => {
      try { await navigator.clipboard.writeText(d.texto); toast('Mensaje copiado'); }
      catch (_) { box.querySelector('#shTxt').select(); toast('Selecciona y copia'); }
    };
  });
}

/* ═══════════════════════════════════════════════════════════════
   Asignación: cada persona por separado
   ═══════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════
   Asignación

   Un tablero por persona y unos pocos filtros. Se reparte arrastrando
   tarjetas de una columna a otra.
   ═══════════════════════════════════════════════════════════════ */
/* Los grupos en que se parte el trabajo de cada persona. El orden importa:
   arriba lo que aprieta, abajo lo que puede esperar. */
const GRUPOS_FECHA = [
  { k: 'vencidos',  n: 'Vencidos',         abierto: true,  urgente: true },
  { k: 'hoy',       n: 'Hoy',              abierto: true,  urgente: true },
  { k: 'semana',    n: 'Esta semana',      abierto: true },
  { k: 'siguiente', n: 'Semana siguiente', abierto: false },
  { k: 'despues',   n: 'Más adelante',     abierto: false },
  { k: 'sinfecha',  n: 'Sin fecha',        abierto: false }
];

const GRUPOS_ESTADO = [
  { k: 'pendiente',   n: 'En borrador', abierto: true },
  { k: 'en_curso',    n: 'En curso',    abierto: true },
  { k: 'en_revision', n: 'Enviados',    abierto: false },
  { k: 'aprobado',    n: 'Aprobados',   abierto: false }
];

function vistaAsignacion(m) {
  S.agrupar = S.agrupar || 'fecha';
  S.cerradosAsig = S.cerradosAsig || new Set();
  S.filtroPersona = S.filtroPersona || '';
  S.filtroCuando = S.filtroCuando || '';
  S.buscaAsig = S.buscaAsig || '';
  const grupos = S.agrupar === 'fecha' ? GRUPOS_FECHA : GRUPOS_ESTADO;
  const columnas = columnasPersonas()
    .filter(c => !S.filtroPersona || c.id === S.filtroPersona);

  m.innerHTML = `
  <div class="topbar"><h1>Asignación</h1><div class="sp"></div>
    <div class="tabs">
      <button class="tab ${S.agrupar === 'fecha' ? 'on' : ''}" data-agrupar="fecha">Por fecha</button>
      <button class="tab ${S.agrupar === 'estado' ? 'on' : ''}" data-agrupar="estado">Por estado</button>
    </div>
    <button class="btn sm" id="organizar">⚙ Columnas</button>
    <button class="btn sm" id="plegarTodo">${S.cerradosAsig.size ? 'Abrir todo' : 'Cerrar todo'}</button>
  </div>

  <div class="card filtros-asig">
    <input type="text" id="fBusca" placeholder="Buscar un proceso…" value="${esc(S.buscaAsig)}">
    <select id="fPersona">
      <option value="">Todas las personas</option>
      <option value="__sin__" ${S.filtroPersona === '__sin__' ? 'selected' : ''}>Sin asignar</option>
      ${S.equipo.filter(u => u.rol === 'admin' || u.rol === 'analista').map(u =>
        `<option value="${u.id}" ${S.filtroPersona === u.id ? 'selected' : ''}>${esc(u.nombre)}</option>`).join('')}
    </select>
    <select id="fCuando">
      <option value="">Cualquier fecha de entrega</option>
      ${[['vencidos', 'Vencidos'], ['hoy', 'Hoy'], ['semana', 'Esta semana'],
         ['siguiente', 'Semana siguiente'], ['sinfecha', 'Sin fecha']].map(([k, n]) =>
        `<option value="${k}" ${S.filtroCuando === k ? 'selected' : ''}>${n}</option>`).join('')}
    </select>
    <div class="tabs densidad">
      ${[['comodo', 'Cómodo'], ['compacto', 'Compacto'], ['minimo', 'Todos']].map(([k, n]) =>
        `<button class="tab ${leerPreferencias().densidad === k ? 'on' : ''}" data-dens="${k}"
          title="${k === 'minimo' ? 'Lo más apretado posible, para ver a todo el equipo de una' : ''}">${n}</button>`).join('')}
    </div>
    ${(S.buscaAsig || S.filtroPersona || S.filtroCuando)
      ? '<button class="btn sm" id="limpiarF">Quitar filtros</button>' : ''}
  </div>

  ${esAdmin()
    ? '<div class="tiny" style="margin-bottom:12px">Arrastra una tarjeta a la columna de otra persona para reasignarla. Dentro de cada cajón van de la fecha más cercana a la más lejana.</div>'
    : '<div class="banner">Solo el administrador reparte los procesos.</div>'}

  <div class="tablero ${leerPreferencias().densidad}">
    ${columnas.map((col, i) => columnaPersona(col, grupos, i)).join('')}
  </div>
  ${leerPreferencias().ocultas.length
    ? `<div class="tiny" style="margin-top:12px">${leerPreferencias().ocultas.length} columna(s) ocultas ·
       <a href="#" id="verOcultas">mostrar todas</a></div>` : ''}`;

  const bind = (id, clave) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.oninput = el.onchange = () => { S[clave] = el.value; vistaAsignacion(m); };
  };
  bind('fBusca', 'buscaAsig'); bind('fPersona', 'filtroPersona'); bind('fCuando', 'filtroCuando');
  document.getElementById('organizar').onclick = () => modalColumnas(m);

  m.querySelectorAll('[data-dens]').forEach(b => b.onclick = () => {
    leerPreferencias().densidad = b.dataset.dens;
    guardarPreferencias(); vistaAsignacion(m);
  });

  const vo = document.getElementById('verOcultas');
  if (vo) vo.onclick = e => {
    e.preventDefault();
    leerPreferencias().ocultas = [];
    guardarPreferencias(); vistaAsignacion(m);
  };

  const lf = document.getElementById('limpiarF');
  if (lf) lf.onclick = () => {
    S.buscaAsig = ''; S.filtroPersona = ''; S.filtroCuando = ''; vistaAsignacion(m);
  };

  m.querySelectorAll('[data-agrupar]').forEach(b => b.onclick = () => {
    S.agrupar = b.dataset.agrupar;
    S.cerradosAsig = new Set(); S.tocadoAsig = false;
    vistaAsignacion(m);
  });

  document.getElementById('plegarTodo').onclick = () => {
    S.tocadoAsig = true;
    if (S.cerradosAsig.size) S.cerradosAsig = new Set();
    else columnasPersonas().forEach(c => grupos.forEach(g => S.cerradosAsig.add(c.id + '|' + g.k)));
    vistaAsignacion(m);
  };

  m.querySelectorAll('[data-plegar]').forEach(h => h.onclick = e => {
    if (e.target.closest('a')) return;
    if (!S.tocadoAsig) {
      // Al primer clic se congela el estado actual, para no reabrir de golpe
      // todo lo que venía plegado.
      const grupos2 = S.agrupar === 'fecha' ? GRUPOS_FECHA : GRUPOS_ESTADO;
      columnasPersonas().forEach(c => grupos2.forEach(g => {
        if (g.abierto === false) S.cerradosAsig.add(c.id + '|' + g.k);
      }));
      S.tocadoAsig = true;
    }
    const k = h.dataset.plegar;
    S.cerradosAsig.has(k) ? S.cerradosAsig.delete(k) : S.cerradosAsig.add(k);
    vistaAsignacion(m);
  });

  conectarArrastre(m);
}

/* El orden de las columnas y cuáles se muestran son decisión de quien
   coordina, no mía: con seis personas, cada quien tiene su forma de
   mirarlas. Queda guardado en este equipo. */
function leerPreferencias() {
  if (S.prefsCol) return S.prefsCol;
  let guardado = {};
  try { guardado = JSON.parse(localStorage.getItem('lp_columnas') || '{}'); } catch (_) {}
  S.prefsCol = {
    orden: Array.isArray(guardado.orden) ? guardado.orden : [],
    ocultas: Array.isArray(guardado.ocultas) ? guardado.ocultas : [],
    densidad: guardado.densidad || 'comodo'
  };
  return S.prefsCol;
}

function guardarPreferencias() {
  try { localStorage.setItem('lp_columnas', JSON.stringify(leerPreferencias())); } catch (_) {}
}

function todasLasColumnas() {
  const gente = S.equipo.filter(u => u.rol === 'admin' || u.rol === 'analista');
  return [{ id: '', nombre: 'Sin asignar' }].concat(gente);
}

function columnasPersonas() {
  const prefs = leerPreferencias();
  let cols = todasLasColumnas();

  if (S.filtroPersona === '__sin__') return [cols[0]];
  if (S.filtroPersona) return cols.filter(c => c.id === S.filtroPersona);

  cols = cols.filter(c => !prefs.ocultas.includes(c.id));
  if (prefs.orden.length) {
    cols.sort((a, b) => {
      const ia = prefs.orden.indexOf(a.id), ib = prefs.orden.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  }
  return cols;
}

/** Un color por columna: con cinco personas, el borde de color ubica más
    rápido que leer el nombre cada vez. */
const COLORES_COL = ['#8494A2', '#5998B3', '#2E9E6B', '#D9862B', '#8E6FB5', '#C7503F', '#4E8AA6'];

function pasaFiltros(p) {
  const q = (S.buscaAsig || '').toLowerCase().trim();
  if (q && ![p.nombre, p.codigo, p.area].join(' ').toLowerCase().includes(q)) return false;
  if (S.filtroCuando && grupoDe(p, 'fecha') !== S.filtroCuando) {
    if (!(S.filtroCuando === 'semana' && grupoDe(p, 'fecha') === 'hoy')) return false;
  }
  return true;
}

function columnaPersona(col, grupos, indice) {
  const suyos = S.procesos.filter(p => (p.responsable || '') === col.id).filter(pasaFiltros);
  const av = suyos.length ? Math.round(suyos.reduce((t, p) => t + avance(p), 0) / suyos.length) : 0;
  const persona = S.equipo.find(u => u.id === col.id);
  const enMora = suyos.filter(p => grupoDe(p, 'fecha') === 'vencidos').length;

  const color = COLORES_COL[(indice || 0) % COLORES_COL.length];
  return `<div class="col" data-col="${col.id}" style="--color-col:${color}">
    <div class="col-cab">
      ${persona ? puntoPresencia(persona) : ''}
      <b>${esc(col.nombre)}</b>
      <span class="tiny">${suyos.length}${suyos.length ? ` · ${av}%` : ''}</span>
    </div>
    ${enMora ? `<div class="col-mora">${enMora} vencido(s)</div>` : ''}

    <div class="col-cuerpo" data-drop="${col.id}">
      ${suyos.length ? grupos.map(g => {
        const delGrupo = suyos.filter(p => grupoDe(p, S.agrupar) === g.k)
          .sort(porCercania);
        if (!delGrupo.length) return '';
        const clave = col.id + '|' + g.k;
        // La primera vez se decide por el grupo; después manda lo que la
        // persona haya plegado o desplegado.
        const cerrado = S.tocadoAsig
          ? S.cerradosAsig.has(clave)
          : g.abierto === false;
        return `<section class="acord ${cerrado ? 'cerrado' : ''} ${g.urgente ? 'urge' : ''}">
          <header data-plegar="${clave}">
            <span class="fl">${cerrado ? '▸' : '▾'}</span>
            <span class="nom">${esc(g.n)}</span>
            <span class="cuenta">${delGrupo.length}</span>
          </header>
          <div class="acord-cuerpo">${delGrupo.map(p => tarjetaTablero(p)).join('')}</div>
        </section>`;
      }).join('') : '<div class="col-vacia">Nada asignado</div>'}
    </div>
  </div>`;
}

/** En qué cajón cae un proceso, según cómo se esté agrupando. */
function grupoDe(p, criterio) {
  if (criterio === 'estado') return p.estado || 'pendiente';

  const f = (p.fechaLimite || '').slice(0, 10);
  if (!f) return 'sinfecha';

  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const lunes = new Date(hoy);
  lunes.setDate(hoy.getDate() - ((hoy.getDay() + 6) % 7));
  const finSemana = new Date(lunes); finSemana.setDate(lunes.getDate() + 6);
  const finSig = new Date(lunes); finSig.setDate(lunes.getDate() + 13);
  const iso = d => d.toISOString().slice(0, 10);

  if (f < iso(hoy)) return p.estado === 'aprobado' ? 'despues' : 'vencidos';
  if (f === iso(hoy)) return 'hoy';
  if (f <= iso(finSemana)) return 'semana';
  if (f <= iso(finSig)) return 'siguiente';
  return 'despues';
}

/** De la fecha más cercana a la más lejana; lo que no tiene fecha, al final. */
function porCercania(a, b) {
  const fa = (a.fechaLimite || '').slice(0, 10) || '9999-99-99';
  const fb = (b.fechaLimite || '').slice(0, 10) || '9999-99-99';
  if (fa !== fb) return fa.localeCompare(fb);
  return (a.nombre || '').localeCompare(b.nombre || '');
}

function tarjetaTablero(p) {
  return `<div class="tarjeta" data-id="${p.id}">
    <a class="nombre-proc" href="#/proceso/${p.id}"><b>${esc(p.nombre)}</b></a>
    <div class="tiny">${esc(p.area || 'Sin área')}</div>
    <div class="flex wrap" style="margin-top:8px;gap:8px">
      ${textoPlazo(p.fechaLimite).html}
      <span class="pill ${p.estado || 'pendiente'}" style="font-size:12.5px;padding:3px 10px">
        ${esc(etiquetaEstado(p.estado))}</span>
    </div>
    <div class="bar" style="margin-top:8px"><i style="width:${avance(p)}%"></i></div>
  </div>`;
}

function conectarArrastre(m) {
  if (!esAdmin()) return;

  m.querySelectorAll('.tarjeta').forEach(t => {
    t.draggable = true;
    t.ondragstart = e => {
      e.dataTransfer.setData('text/plain', t.dataset.id);
      t.classList.add('arrastrando');
    };
    t.ondragend = () => t.classList.remove('arrastrando');
  });

  m.querySelectorAll('[data-drop]').forEach(z => {
    z.ondragover = e => { e.preventDefault(); z.classList.add('encima'); };
    z.ondragleave = () => z.classList.remove('encima');
    z.ondrop = async e => {
      e.preventDefault();
      z.classList.remove('encima');
      await asignar(e.dataTransfer.getData('text/plain'), z.dataset.drop || null);
      vistaAsignacion(m);
    };
  });
}

/* ═══════════════════════════════════════════════════════════════
   Quién está conectado

   El servidor anota cuándo fue la última vez que cada persona pidió
   algo. Como la app consulta sola cada pocos segundos, tener la
   pestaña abierta basta para figurar en línea.
   ═══════════════════════════════════════════════════════════════ */
function presencia(u) {
  if (!u || !u.ultimoVisto) return { estado: 'nunca', texto: 'Nunca ha entrado' };
  const visto = new Date(u.ultimoVisto.replace(' ', 'T') + (u.ultimoVisto.endsWith('Z') ? '' : 'Z'));
  const min = (Date.now() - visto.getTime()) / 60000;
  if (min < 3) return { estado: 'linea', texto: 'En línea' };
  if (min < 60) return { estado: 'reciente', texto: `Hace ${Math.round(min)} min` };
  if (min < 60 * 24) return { estado: 'lejos', texto: `Hace ${Math.round(min / 60)} h` };
  const dias = Math.round(min / 60 / 24);
  return { estado: 'lejos', texto: dias === 1 ? 'Ayer' : `Hace ${dias} días` };
}

function puntoPresencia(u) {
  const p = presencia(u);
  return `<span class="presencia ${p.estado}" title="${esc(p.texto)}"></span>`;
}

async function asignar(procesoId, personaId) {
  try {
    await api('/procesos/' + procesoId, { method: 'PUT', body: { responsable: personaId } });
    const p = S.procesos.find(x => x.id === procesoId);
    if (p) p.responsable = personaId;
    toast(personaId ? 'Asignado a ' + nombrePersona(personaId) : 'Asignación retirada');
  } catch (_) { toast('No se pudo asignar'); }
}


/* ── Editor de listas desplegables ─────────────────────────────── */
function catHTML(c, i) {
  return `<div class="cat" data-cat="${i}">
    <div class="flex">
      <input type="text" class="catNom" value="${esc(c.nombre)}" placeholder="Nombre de la lista" style="flex:1">
      <button class="btn sm ic danger" data-delcat="${i}" title="Eliminar lista">×</button>
    </div>
    <textarea class="catOpc" placeholder="Una opción por línea">${esc((c.opciones || []).join('\n'))}</textarea>
    <div class="tiny" style="margin-top:6px">${(c.opciones || []).length} opción(es)</div>
  </div>`;
}

function leerCatalogos() {
  return [...document.querySelectorAll('.cat[data-cat]')].map((el, i) => {
    const previo = (S.config.catalogos || [])[i] || {};
    return {
      id: previo.id || ('cat_' + Math.random().toString(36).slice(2, 8)),
      nombre: el.querySelector('.catNom').value.trim(),
      opciones: el.querySelector('.catOpc').value.split('\n').map(x => x.trim()).filter(Boolean)
    };
  }).filter(c => c.nombre);
}

/* ═══════════════════════════════════════════════════════════════
   Texto con formato

   Un editable con barra de negrilla, cursiva, subrayado, viñetas y
   color. Se guarda como HTML; el servidor lo limpia antes de
   almacenarlo, así que solo sobrevive el formato de esta barra.
   ═══════════════════════════════════════════════════════════════ */
const COLORES = [
  { n: 'Normal', v: '' },
  { n: 'Rojo', v: '#C7503F' },
  { n: 'Verde', v: '#2E9E6B' },
  { n: 'Azul', v: '#3A7CA5' },
  { n: 'Naranja', v: '#D9862B' }
];

function editorHTML(c, v, grande, ro) {
  const alto = grande ? 'min-height:150px;font-size:16px' : 'min-height:92px';
  if (ro) {
    return `<div class="rico solo-lectura" style="${alto}">${v || '<span class="mut">—</span>'}</div>`;
  }
  return `<div class="rico-caja">
    <div class="rico-barra" data-barra="${c.id}">
      <button type="button" data-cmd="bold" title="Negrilla (Ctrl+B)"><b>N</b></button>
      <button type="button" data-cmd="italic" title="Cursiva (Ctrl+I)"><i>C</i></button>
      <button type="button" data-cmd="underline" title="Subrayado"><u>S</u></button>
      <span class="sep"></span>
      <button type="button" data-cmd="insertUnorderedList" title="Viñetas">☰</button>
      <span class="sep"></span>
      ${COLORES.map(x => `<button type="button" class="color" data-color="${x.v}" title="${x.n}"
        style="${x.v ? `background:${x.v}` : 'background:var(--ink-3)'}"></button>`).join('')}
      <button type="button" data-cmd="resaltar" title="Resaltar en amarillo" class="marca">✦</button>
      <span class="sep"></span>
      <button type="button" data-cmd="removeFormat" title="Quitar formato">⌫</button>
    </div>
    <div class="rico" contenteditable="true" data-rico="${c.id}" style="${alto}"
      data-vacio="Escriba aquí la respuesta">${v || ''}</div>
  </div>`;
}

function conectarEditores(cont) {
  cont.querySelectorAll('[data-rico]').forEach(caja => {
    const cid = caja.dataset.rico;

    const guardar = () => {
      S.draft.respuestas[cid] = caja.innerHTML === '<br>' ? '' : caja.innerHTML;
      refrescarAvance();
      guardarDebounce();
    };
    caja.oninput = guardar;
    caja.onblur = guardar;

    // Pegar siempre como texto: si no, entra el formato de Word entero.
    caja.onpaste = e => {
      e.preventDefault();
      const texto = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, texto);
    };

    const barra = cont.querySelector(`[data-barra="${cid}"]`);
    if (!barra) return;

    barra.querySelectorAll('[data-cmd]').forEach(b => b.onmousedown = e => {
      e.preventDefault();                 // no perder la selección del texto
      caja.focus();
      if (b.dataset.cmd === 'resaltar') {
        document.execCommand('hiliteColor', false, '#FFE79A');
      } else {
        document.execCommand(b.dataset.cmd, false, null);
      }
      guardar();
    });

    barra.querySelectorAll('[data-color]').forEach(b => b.onmousedown = e => {
      e.preventDefault();
      caja.focus();
      document.execCommand('foreColor', false, b.dataset.color || '#333333');
      guardar();
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   Historial: recuperar lo que se borró por accidente
   ═══════════════════════════════════════════════════════════════ */
async function modalHistorial(p) {
  modal(`<h3>Historial de ${esc(p.nombre)}</h3>
    <p class="mut" style="margin-top:-6px">Cada vez que alguien guarda, se conserva cómo estaba antes. Si se borró algo sin querer, aquí se recupera.</p>
    <div id="histBox"><div class="mut">Buscando…</div></div>
    <div class="flex" style="margin-top:14px"><button class="btn right" data-cerrar>Cerrar</button></div>`,
  async box => {
    const caja = box.querySelector('#histBox');
    try {
      const d = await api('/procesos/' + p.id + '/versiones');
      if (!d.versiones.length) {
        caja.innerHTML = '<div class="mut">Todavía no hay versiones anteriores.</div>';
        return;
      }
      caja.innerHTML = `<table class="t"><tbody>${d.versiones.map((v, i) => `<tr>
        <td><b>${esc(fechaLarga(v.creado))}</b>
          <div class="tiny">${esc(v.por || '')} · ${esc(v.motivo || '')}${i === 0 ? ' · la más reciente' : ''}</div></td>
        <td style="width:110px"><button class="btn sm" data-ver="${v.id}">Recuperar</button></td>
      </tr>`).join('')}</tbody></table>`;

      caja.querySelectorAll('[data-ver]').forEach(b => b.onclick = async () => {
        if (!confirm('Se va a reemplazar lo que hay ahora por esta versión. Lo actual queda guardado en el historial, así que también se puede deshacer.')) return;
        await api(`/procesos/${p.id}/versiones/${b.dataset.ver}/restaurar`, { method: 'POST' });
        const r = await api('/procesos');
        S.procesos = r.procesos;
        const fresco = S.procesos.find(x => x.id === p.id);
        if (fresco) { S.draft = JSON.parse(JSON.stringify(fresco)); }
        cerrarModal(); render(); toast('Versión recuperada');
      });
    } catch (_) { caja.innerHTML = '<div class="mut">No se pudo consultar el historial.</div>'; }
  });
}

/** Solo el día, en corto: "jue 17 sep". */
function fechaDia(iso) {
  try {
    return new Date(iso.slice(0, 10) + 'T00:00:00')
      .toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });
  } catch (_) { return iso; }
}

function fechaLarga(iso) {
  try {
    return new Date(iso.replace(' ', 'T')).toLocaleString('es-CO',
      { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return iso; }
}

/* ═══════════════════════════════════════════════════════════════
   Agenda — lo que ve la contraparte de la clínica

   No le interesa el contenido del levantamiento sino la logística:
   qué le van a preguntar, cuándo, y a quién tiene que mandar de su lado.
   ═══════════════════════════════════════════════════════════════ */
function vistaAgenda(m) {
  const ps = S.procesos.filter(p => p.estado !== 'aprobado');
  const grupos = {
    hoy:       { n: 'Hoy',              ps: [] },
    manana:    { n: 'Mañana',           ps: [] },
    semana:    { n: 'Resto de la semana', ps: [] },
    siguiente: { n: 'Semana siguiente', ps: [] },
    despues:   { n: 'Más adelante',     ps: [] },
    vencidos:  { n: 'Quedaron atrás',   ps: [] },
    sinfecha:  { n: 'Sin fecha todavía', ps: [] }
  };
  ps.forEach(p => (grupos[cajonAgenda(p)] || grupos.sinfecha).ps.push(p));

  const sinAtender = ps.filter(p => p.fechaLimite && !p.atiende).length;
  const orden = ['hoy', 'manana', 'semana', 'siguiente', 'despues', 'sinfecha', 'vencidos'];

  m.innerHTML = `
  <div class="topbar"><h1>Agenda de levantamiento</h1><div class="sp"></div>
    <span class="tiny">${ps.length} pendiente(s)</span>
    <button class="btn p" id="proponerAg">+ Proponer un proceso</button></div>

  <div class="banner">
    Esto es lo que el equipo va a venir a preguntar. Por cada proceso, diga
    <b>quién de la clínica</b> los atiende y <b>a qué hora</b> puede.
    ${sinAtender ? `<br><b>Faltan ${sinAtender} por asignar de su lado.</b>` : ''}
  </div>

  ${orden.map(k => {
    const g = grupos[k];
    if (!g.ps.length) return '';
    return `<section class="grupo">
      <div class="grupo-cab">
        <span class="pill ${k === 'hoy' ? 'en_curso' : k === 'manana' ? 'en_revision' : k === 'vencidos' ? 'pendiente' : 'pendiente'}">
          ${esc(g.n)}</span>
        <span class="tiny">${g.ps.length}</span>
        <span class="tiny right">${g.ps.filter(p => p.atiende).length} con responsable asignado</span>
      </div>
      ${porArea(g.ps).map(([area, lista]) => `
        <div class="area-bloque">
          <div class="area-titulo">${esc(area)} <span class="tiny">${lista.length}</span></div>
          <div class="grid g3">${lista.map(p => tarjetaAgenda(p)).join('')}</div>
        </div>`).join('')}
    </section>`;
  }).join('') || '<div class="empty"><span class="e">◷</span>No hay procesos programados por ahora.</div>'}`;

  const bp = document.getElementById('proponerAg');
  if (bp) bp.onclick = modalProponer;
  conectarAgenda(m);
}

/** Igual que el resto de la app, pero con "mañana" aparte: a la clínica le
    importa lo de hoy y lo que viene, no lo que ya se les pasó. */
/** La fecha que manda para la clínica: la cita acordada; si no la han
    puesto, la fecha de entrega que fijó la coordinación. */
function fechaAgenda(p) {
  return (p.fechaCita || p.fechaLimite || '').slice(0, 10);
}

function cajonAgenda(p) {
  const f = fechaAgenda(p);
  if (!f) return 'sinfecha';
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const iso = d => d.toISOString().slice(0, 10);
  const manana = new Date(hoy); manana.setDate(hoy.getDate() + 1);
  const finSemana = new Date(hoy); finSemana.setDate(hoy.getDate() + (7 - ((hoy.getDay() + 6) % 7)) - 1);
  const finSig = new Date(finSemana); finSig.setDate(finSemana.getDate() + 7);

  if (f < iso(hoy)) return 'vencidos';
  if (f === iso(hoy)) return 'hoy';
  if (f === iso(manana)) return 'manana';
  if (f <= iso(finSemana)) return 'semana';
  if (f <= iso(finSig)) return 'siguiente';
  return 'despues';
}

/** Agrupadas por área: quien atiende suele ser la misma persona para
    varios procesos de la misma área. */
function porArea(lista) {
  const mapa = {};
  lista.forEach(p => { (mapa[p.area || 'Sin área'] = mapa[p.area || 'Sin área'] || []).push(p); });
  return Object.entries(mapa).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([a, l]) => [a, l.sort((x, y) => (x.hora || '99').localeCompare(y.hora || '99'))]);
}

const HORAS = (() => {
  const h = [];
  for (let i = 6; i <= 19; i++) {
    h.push(`${String(i).padStart(2, '0')}:00`);
    h.push(`${String(i).padStart(2, '0')}:30`);
  }
  return h;
})();

function tarjetaAgenda(p) {
  const listo = !!p.atiende;
  const conNota = !!(p.notasClinica || '').trim();
  const enviado = p.estado === 'en_revision';

  return `<div class="card agenda-card ${listo ? 'listo' : 'pendiente-asig'}">
    <div class="flex" style="align-items:flex-start;gap:8px;margin-bottom:10px">
      <div style="flex:1;min-width:0">
        <b>${esc(p.nombre)}</b>
        <div class="tiny">${esc(p.codigo || '')} · lo levanta ${esc(nombrePersona(p.responsable))}</div>
      </div>
      ${listo ? '<span class="ok-marca" title="Ya tiene responsable">✓</span>' : ''}
    </div>

    ${listo ? `<div class="cita-resuelta">
      ${p.hora ? `<span class="hora">${esc(p.hora)}</span>` : '<span class="hora falta">sin hora</span>'}
      <span class="quien">${esc(p.atiende)}</span>
      ${p.fechaCita ? `<span class="tiny">${esc(fechaDia(p.fechaCita))}</span>` : ''}
    </div>` : ''}

    <div class="agenda-campos">
      <label class="campo-fecha">
        <span class="lbl">Día de la cita</span>
        <input type="date" data-fechacita="${p.id}" value="${esc((p.fechaCita || '').slice(0, 10))}">
      </label>
      <label class="campo-hora">
        <span class="lbl">Hora</span>
        <select data-hora="${p.id}">
          <option value="">—</option>
          ${HORAS.map(h => `<option value="${h}" ${p.hora === h ? 'selected' : ''}>${h}</option>`).join('')}
        </select>
      </label>
      <label class="campo-quien">
        <span class="lbl">¿Quién atiende?</span>
        <input type="text" data-atiende="${p.id}" value="${esc(p.atiende || '')}"
          placeholder="Nombre y cargo de quien responde" list="sug-atiende">
      </label>
    </div>
    <div class="tiny" style="margin-top:7px">
      Entrega pedida: ${p.fechaLimite ? esc(fechaDia(p.fechaLimite)) : 'sin fecha'}${
      p.contacto ? ' · referencia: ' + esc(p.contacto) : ''}</div>

    <details class="nota-plegable" ${conNota ? 'open' : ''}>
      <summary>${conNota ? '⚑ Tener en cuenta' : '+ Agregar nota para quien entrevista'}</summary>
      <textarea data-nota="${p.id}" placeholder="Ej: solo está los martes; el proceso cambió en junio">${esc(p.notasClinica || '')}</textarea>
    </details>

    <div class="flex" style="margin-top:8px;gap:8px">
      <span class="tiny" data-eco="${p.id}"></span>
      ${enviado ? `<a class="btn sm right" href="#/proceso/${p.id}">Ver lo levantado</a>` : ''}
    </div>
  </div>`;
}

function conectarAgenda(m) {
  // Los nombres ya usados se ofrecen como sugerencia: casi siempre atiende
  // la misma persona varios procesos de su área.
  const usados = [...new Set(S.procesos.map(p => p.atiende).filter(Boolean))];
  if (!document.getElementById('sug-atiende')) {
    const dl = document.createElement('datalist');
    dl.id = 'sug-atiende';
    dl.innerHTML = usados.map(x => `<option value="${esc(x)}"></option>`).join('');
    m.appendChild(dl);
  }

  const guardar = (pid, cuerpo, campo) => {
    const eco = m.querySelector(`[data-eco="${pid}"]`);
    if (eco) eco.textContent = 'Guardando…';
    api('/procesos/' + pid + '/atiende', { method: 'PUT', body: cuerpo })
      .then(() => {
        const p = S.procesos.find(x => x.id === pid);
        if (p) Object.assign(p, campo);
        if (eco) { eco.textContent = 'Guardado ✓'; setTimeout(() => { eco.textContent = ''; }, 1800); }
      })
      .catch(() => { if (eco) eco.textContent = 'No se pudo guardar'; });
  };

  m.querySelectorAll('[data-hora]').forEach(sel => sel.onchange = () =>
    guardar(sel.dataset.hora, { hora: sel.value }, { hora: sel.value }));

  m.querySelectorAll('[data-fechacita]').forEach(inp => inp.onchange = () =>
    guardar(inp.dataset.fechacita, { fechaCita: inp.value }, { fechaCita: inp.value }));

  const conRetraso = (el, fn) => {
    let t = null;
    el.oninput = () => { clearTimeout(t); t = setTimeout(fn, 700); };
  };

  m.querySelectorAll('[data-atiende]').forEach(inp => conRetraso(inp, () => {
    guardar(inp.dataset.atiende, { atiende: inp.value }, { atiende: inp.value });
    const tarjeta = inp.closest('.agenda-card');
    if (tarjeta) tarjeta.classList.toggle('listo', !!inp.value.trim());
  }));

  m.querySelectorAll('[data-nota]').forEach(inp => conRetraso(inp, () => {
    const pid = inp.dataset.nota;
    const eco = m.querySelector(`[data-eco="${pid}"]`);
    api('/procesos/' + pid + '/nota-clinica', { method: 'PUT', body: { notasClinica: inp.value } })
      .then(() => {
        const p = S.procesos.find(x => x.id === pid);
        if (p) p.notasClinica = inp.value;
        if (eco) { eco.textContent = 'Nota guardada ✓'; setTimeout(() => { eco.textContent = ''; }, 1800); }
      })
      .catch(() => { if (eco) eco.textContent = 'No se pudo guardar la nota'; });
  }));
}

/* ═══════════════════════════════════════════════════════════════
   Por mapear — lo que la clínica quiere que se levante

   Los procesos que ellos proponen, con el estado en que van. Es su
   forma de decir "esto también hay que mirarlo" sin tener que
   pedírselo a nadie.
   ═══════════════════════════════════════════════════════════════ */
function vistaPorMapear(m) {
  const propuestos = S.procesos.filter(p => p.propuestoPor);
  const sinAsignar = propuestos.filter(p => !p.responsable);
  const enCurso = propuestos.filter(p => p.responsable && p.estado !== 'aprobado');
  const listos = propuestos.filter(p => p.estado === 'aprobado');

  const tabla = lista => `<div class="tw"><table class="t"><tbody>${lista.map(p => `<tr>
    <td><b>${esc(p.nombre)}</b>
      <div class="tiny">${esc(p.area || 'Sin área')}${p.contacto ? ' · ' + esc(p.contacto) : ''}</div>
      ${p.notasClinica ? `<div class="tiny nota-mini">⚑ ${esc(recortar(aTextoPlano(p.notasClinica), 110))}</div>` : ''}</td>
    <td style="width:170px" class="mut">${p.responsable ? esc(nombrePersona(p.responsable)) : '<i>Sin asignar aún</i>'}</td>
    <td style="width:130px">${textoPlazo(p.fechaLimite).html}</td>
    <td style="width:110px"><span class="pill ${p.estado}">${esc(etiquetaEstado(p.estado))}</span></td>
    <td style="width:120px">${p.informeUrl
      ? `<a class="btn sm" href="${esc(p.informeUrl)}" target="_blank" rel="noopener">Leer</a>` : ''}</td>
  </tr>`).join('')}</tbody></table></div>`;

  m.innerHTML = `
  <div class="topbar"><h1>Procesos por mapear</h1><div class="sp"></div>
    <button class="btn p" id="proponerPM">+ Proponer un proceso</button></div>

  <div class="banner">
    Aquí queda lo que ustedes proponen levantar. Apunte cualquier cosa que aparezca
    en el camino: un trámite que nadie tiene documentado, algo que genera reclamos,
    un paso que se hace distinto en cada turno. La coordinación decide quién lo toma
    y cuándo.
  </div>

  ${propuestos.length ? `
    ${sinAsignar.length ? `<section class="grupo">
      <div class="grupo-cab"><span class="pill pendiente">Esperando asignación</span>
        <span class="tiny">${sinAsignar.length}</span></div>
      <div class="card" style="padding:0">${tabla(sinAsignar)}</div>
    </section>` : ''}

    ${enCurso.length ? `<section class="grupo">
      <div class="grupo-cab"><span class="pill en_curso">Ya programados</span>
        <span class="tiny">${enCurso.length}</span></div>
      <div class="card" style="padding:0">${tabla(enCurso)}</div>
    </section>` : ''}

    ${listos.length ? `<section class="grupo">
      <div class="grupo-cab"><span class="pill aprobado">Terminados</span>
        <span class="tiny">${listos.length}</span></div>
      <div class="card" style="padding:0">${tabla(listos)}</div>
    </section>` : ''}
  ` : `<div class="empty"><span class="e">✎</span>
      Todavía no han propuesto ninguno.<br>
      <span class="tiny">Use el botón de arriba cuando aparezca algo que valga la pena levantar.</span>
    </div>`}`;

  document.getElementById('proponerPM').onclick = modalProponer;
}

/* ═══════════════════════════════════════════════════════════════
   Mapa de conexiones

   Se arma solo con lo que cada quien declaró: de dónde le llega el
   trabajo y a quién se lo pasa. A los quince días dice más que
   cualquier informe: dónde hay huecos y qué quedó suelto.
   ═══════════════════════════════════════════════════════════════ */
async function vistaMapa(m) {
  m.innerHTML = `<div class="topbar"><h1>Mapa de procesos</h1></div>
    <div class="mut">Armando el diagrama…</div>`;
  let d;
  try { d = await api('/mapa'); }
  catch (_) { m.innerHTML = '<div class="empty">No se pudo cargar el mapa.</div>'; return; }

  S.mapa = d;
  const { nodos, enlaces, sueltos } = d;
  if (!nodos.length) {
    m.innerHTML = `<div class="topbar"><h1>Mapa de procesos</h1></div>
      <div class="empty"><span class="e">⤳</span>Todavía no hay procesos registrados.</div>`;
    return;
  }

  m.innerHTML = `
  <div class="topbar"><h1>Mapa de procesos</h1><div class="sp"></div>
    <span class="tiny">${nodos.length} procesos · ${enlaces.length} conexiones</span>
    <button class="btn sm" id="expMapa">⤓ Descargar diagrama</button></div>

  <div class="banner">
    El diagrama se arma solo con lo que cada persona respondió en
    “¿de qué proceso le llega el trabajo?” y “¿a quién se lo pasa?”.
    ${sueltos.length
      ? `<b>${sueltos.length} proceso(s) sin ninguna conexión declarada</b> aparecen aparte, al final: o están aislados de verdad, o falta preguntarlo.`
      : 'Todos los procesos están conectados con al menos otro.'}
  </div>

  <div class="card" style="padding:0;overflow:hidden">
    <div class="mapa-barra">
      <span class="tiny">Toca una caja para abrir el proceso</span>
      <span class="right flex" style="gap:6px">
        <button class="btn sm ic" id="zMenos" title="Alejar">−</button>
        <button class="btn sm ic" id="zMas" title="Acercar">+</button>
        <button class="btn sm" id="zAjustar">Ajustar</button>
      </span>
    </div>
    <div class="mapa-lienzo" id="lienzo"></div>
  </div>

  <div class="card" style="margin-top:16px">
    <h3>Cruces entre áreas</h3>
    <p class="mut" style="margin-top:-6px">Donde un proceso de un área entrega a otra suele estar el reproceso.</p>
    <div class="tw"><table class="t"><tbody>${cruces(nodos, enlaces).map(c => `<tr>
      <td><b>${esc(c.de)}</b></td><td style="width:30px;color:var(--accent)">→</td>
      <td><b>${esc(c.a)}</b></td><td style="width:90px" class="tiny">${c.n} conexión(es)</td>
    </tr>`).join('') || '<tr><td class="mut">Ninguno todavía.</td></tr>'}</tbody></table></div>
  </div>`;

  dibujarMapa(d);
  document.getElementById('expMapa').onclick = () => modalExportarMapa(d);
  document.getElementById('zMas').onclick = () => zoomMapa(1.2);
  document.getElementById('zMenos').onclick = () => zoomMapa(1 / 1.2);
  document.getElementById('zAjustar').onclick = () => { S.mapaZoom = 1; zoomMapa(1); };
}

function cruces(nodos, enlaces) {
  const area = id => (nodos.find(n => n.id === id) || {}).area || 'Sin área';
  const cuenta = {};
  enlaces.forEach(e => {
    const a = area(e.de), b = area(e.a);
    if (a === b) return;
    const k = a + '→' + b;
    cuenta[k] = (cuenta[k] || 0) + 1;
  });
  return Object.entries(cuenta)
    .map(([k, n]) => ({ de: k.split('→')[0], a: k.split('→')[1], n }))
    .sort((x, y) => y.n - x.n);
}

/* ═══════════════════════════════════════════════════════════════
   Dibujo del flujo

   Se ordena por capas: primero los procesos que no reciben de nadie,
   después los que dependen de ellos, y así. Es la forma natural de leer
   una cadena de trabajo, de izquierda a derecha.
   ═══════════════════════════════════════════════════════════════ */
function capas(nodos, enlaces) {
  const entra = {}, sale = {};
  nodos.forEach(n => { entra[n.id] = []; sale[n.id] = []; });
  enlaces.forEach(e => {
    if (sale[e.de]) sale[e.de].push(e.a);
    if (entra[e.a]) entra[e.a].push(e.de);
  });

  const nivel = {};
  nodos.forEach(n => { nivel[n.id] = 0; });

  // Empuja cada nodo a la derecha de quienes lo alimentan. El tope de
  // vueltas evita quedarse dando círculos si alguien declaró un ciclo.
  for (let vuelta = 0; vuelta < nodos.length + 2; vuelta++) {
    let cambio = false;
    enlaces.forEach(e => {
      if (nivel[e.a] <= nivel[e.de]) { nivel[e.a] = nivel[e.de] + 1; cambio = true; }
    });
    if (!cambio) break;
  }
  return { nivel, entra, sale };
}

function dibujarMapa(d) {
  const lienzo = document.getElementById('lienzo');
  if (!lienzo) return;

  const conectados = d.nodos.filter(n => !d.sueltos.includes(n.id));
  const sueltos = d.nodos.filter(n => d.sueltos.includes(n.id));
  const { nivel } = capas(conectados, d.enlaces);

  const ANCHO = 190, ALTO = 66, SEP_X = 90, SEP_Y = 26;
  const columnas = {};
  conectados.forEach(n => {
    const c = nivel[n.id] || 0;
    (columnas[c] = columnas[c] || []).push(n);
  });

  // Dentro de cada columna, juntos los de la misma área.
  Object.values(columnas).forEach(col =>
    col.sort((a, b) => (a.area || '').localeCompare(b.area || '')));

  const pos = {};
  let maxFilas = 0;
  Object.entries(columnas).forEach(([c, col]) => {
    maxFilas = Math.max(maxFilas, col.length);
    col.forEach((n, i) => {
      pos[n.id] = { x: +c * (ANCHO + SEP_X) + 30, y: i * (ALTO + SEP_Y) + 30 };
    });
  });

  const nCols = Object.keys(columnas).length || 1;
  const W = nCols * (ANCHO + SEP_X) + 60;
  const filasSueltos = sueltos.length ? Math.ceil(sueltos.length / Math.max(1, Math.floor(W / (ANCHO + SEP_X)))) : 0;
  const H = Math.max(maxFilas * (ALTO + SEP_Y) + 60, 220) + filasSueltos * (ALTO + SEP_Y) + (sueltos.length ? 70 : 0);

  const colorArea = a => {
    const areas = [...new Set(d.nodos.map(x => x.area || 'Sin área'))];
    const tonos = ['#5998B3', '#2E9E6B', '#D9862B', '#8E6FB5', '#C7503F', '#4E8AA6', '#7A9E3F'];
    return tonos[areas.indexOf(a || 'Sin área') % tonos.length];
  };

  const caja = (n, p) => `
    <a class="nodo-g" href="#/proceso/${n.id}" transform="translate(${p.x},${p.y})">
      <rect width="${ANCHO}" height="${ALTO}" rx="10"
        fill="var(--surface)" stroke="${colorArea(n.area)}" stroke-width="2"></rect>
      <rect width="5" height="${ALTO}" rx="2" fill="${colorArea(n.area)}"></rect>
      <text x="16" y="25" class="n-nom">${esc(recortar(n.nombre, 24))}</text>
      <text x="16" y="43" class="n-area">${esc(n.area || 'Sin área')}</text>
      <text x="16" y="58" class="n-cod">${esc(n.codigo || '')}${n.estado === 'en_revision' ? ' · enviado' : ''}</text>
    </a>`;

  const flecha = e => {
    const a = pos[e.de], b = pos[e.a];
    if (!a || !b) return '';
    const x1 = a.x + ANCHO, y1 = a.y + ALTO / 2;
    const x2 = b.x, y2 = b.y + ALTO / 2;
    const dx = Math.max(40, (x2 - x1) / 2);
    return `<path d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"
      fill="none" stroke="var(--ink-3)" stroke-width="1.8" marker-end="url(#punta)" opacity=".75"></path>`;
  };

  const anchoFila = Math.max(1, Math.floor((W - 60) / (ANCHO + SEP_X)));
  const yBase = Math.max(maxFilas * (ALTO + SEP_Y) + 60, 220);

  lienzo.innerHTML = `
  <svg id="svgMapa" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="punta" viewBox="0 0 10 10" refX="9" refY="5"
        markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="var(--ink-3)"></path>
      </marker>
    </defs>
    <style>
      .n-nom{font:600 13px var(--font);fill:var(--ink)}
      .n-area{font:400 11px var(--font);fill:var(--ink-2)}
      .n-cod{font:400 10px var(--font);fill:var(--ink-3)}
      .nodo-g{cursor:pointer}
      .nodo-g:hover rect:first-child{stroke-width:3}
    </style>
    ${d.enlaces.map(flecha).join('')}
    ${conectados.map(n => caja(n, pos[n.id])).join('')}
    ${sueltos.length ? `<text x="30" y="${yBase + 10}" class="n-area">Sin conexiones declaradas</text>` : ''}
    ${sueltos.map((n, i) => caja(n, {
      x: (i % anchoFila) * (ANCHO + SEP_X) + 30,
      y: yBase + 30 + Math.floor(i / anchoFila) * (ALTO + SEP_Y)
    })).join('')}
  </svg>`;

  S.mapaZoom = 1;
}

function recortar(t, n) {
  t = String(t || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function zoomMapa(factor) {
  const svg = document.getElementById('svgMapa');
  if (!svg) return;
  S.mapaZoom = Math.min(2.5, Math.max(0.35, (S.mapaZoom || 1) * factor));
  const base = svg.getAttribute('viewBox').split(' ');
  svg.setAttribute('width', (+base[2] * S.mapaZoom).toFixed(0));
  svg.setAttribute('height', (+base[3] * S.mapaZoom).toFixed(0));
}

/* ═══════════════════════════════════════════════════════════════
   Bajar el diagrama a otro programa

   Nadie quiere quedarse encerrado en esta app: el mapa sale en los
   formatos que abren las herramientas de diagramación habituales.
   ═══════════════════════════════════════════════════════════════ */
function modalExportarMapa(d) {
  modal(`<h3>Descargar el diagrama</h3>
    <p class="mut" style="margin-top:-6px">Elige según dónde lo vayas a abrir.</p>
    <div class="formatos">
      <button class="btn" data-fmt="drawio"><b>draw.io / diagrams.net</b>
        <span class="tiny">Cajas y flechas editables. Es el más cómodo para retocar.</span></button>
      <button class="btn" data-fmt="mermaid"><b>Mermaid</b>
        <span class="tiny">Texto. Sirve en Notion, Obsidian, GitHub y documentación.</span></button>
      <button class="btn" data-fmt="dot"><b>Graphviz (.dot)</b>
        <span class="tiny">Para generar el diagrama por línea de comandos.</span></button>
      <button class="btn" data-fmt="csv"><b>CSV de conexiones</b>
        <span class="tiny">Origen y destino en dos columnas. Para Excel o Power BI.</span></button>
      <button class="btn" data-fmt="svg"><b>Imagen SVG</b>
        <span class="tiny">El diagrama tal como se ve aquí.</span></button>
      <button class="btn" data-fmt="json"><b>JSON</b>
        <span class="tiny">Los datos crudos, para otro programa.</span></button>
    </div>
    <div class="flex" style="margin-top:16px"><button class="btn right" data-cerrar>Cerrar</button></div>`,
  box => {
    box.querySelectorAll('[data-fmt]').forEach(b => b.onclick = () => {
      const f = b.dataset.fmt;
      const gen = { drawio: aDrawio, mermaid: aMermaid, dot: aDot, csv: aCsvMapa, json: aJsonMapa };
      if (f === 'svg') return bajarTexto('mapa-procesos.svg', svgLimpio(), 'image/svg+xml');
      const { texto, nombre, tipo } = gen[f](d);
      bajarTexto(nombre, texto, tipo);
    });
  });
}

function idLimpio(n, i) { return 'p' + i; }

function aMermaid(d) {
  const idx = {}; d.nodos.forEach((n, i) => { idx[n.id] = idLimpio(n, i); });
  const areas = [...new Set(d.nodos.map(n => n.area || 'Sin área'))];
  const lineas = ['flowchart LR'];
  areas.forEach((a, k) => {
    lineas.push(`  subgraph A${k}["${a}"]`);
    d.nodos.filter(n => (n.area || 'Sin área') === a)
      .forEach(n => lineas.push(`    ${idx[n.id]}["${(n.codigo ? n.codigo + ' ' : '') + n.nombre.replace(/"/g, "'")}"]`));
    lineas.push('  end');
  });
  d.enlaces.forEach(e => lineas.push(`  ${idx[e.de]} --> ${idx[e.a]}`));
  return { texto: lineas.join('\n'), nombre: 'mapa-procesos.mmd', tipo: 'text/plain' };
}

function aDot(d) {
  const idx = {}; d.nodos.forEach((n, i) => { idx[n.id] = idLimpio(n, i); });
  const l = ['digraph procesos {', '  rankdir=LR;',
             '  node [shape=box style=rounded fontname="Helvetica" fontsize=11];'];
  d.nodos.forEach(n => l.push(
    `  ${idx[n.id]} [label="${(n.codigo ? n.codigo + '\\n' : '') + n.nombre.replace(/"/g, "'")}\\n(${n.area || 'Sin área'})"];`));
  d.enlaces.forEach(e => l.push(`  ${idx[e.de]} -> ${idx[e.a]};`));
  l.push('}');
  return { texto: l.join('\n'), nombre: 'mapa-procesos.dot', tipo: 'text/plain' };
}

function aCsvMapa(d) {
  const n = id => (d.nodos.find(x => x.id === id) || {});
  const filas = [['Proceso origen', 'Área origen', 'Proceso destino', 'Área destino']];
  d.enlaces.forEach(e => filas.push([
    n(e.de).nombre || '', n(e.de).area || '', n(e.a).nombre || '', n(e.a).area || '']));
  d.sueltos.forEach(id => filas.push([n(id).nombre || '', n(id).area || '', '(sin conexión)', '']));
  const csv = '\ufeff' + filas.map(f => f.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(';')).join('\n');
  return { texto: csv, nombre: 'conexiones.csv', tipo: 'text/csv' };
}

function aJsonMapa(d) {
  return { texto: JSON.stringify(d, null, 2), nombre: 'mapa-procesos.json', tipo: 'application/json' };
}

/** XML de draw.io: se abre con Archivo → Abrir, y queda editable. */
function aDrawio(d) {
  const ANCHO = 180, ALTO = 60, SEP_X = 120, SEP_Y = 40;
  const conectados = d.nodos.filter(n => !d.sueltos.includes(n.id));
  const { nivel } = capas(conectados, d.enlaces);
  const cols = {};
  conectados.forEach(n => { const c = nivel[n.id] || 0; (cols[c] = cols[c] || []).push(n); });

  const pos = {};
  Object.entries(cols).forEach(([c, col]) => col.forEach((n, i) => {
    pos[n.id] = { x: +c * (ANCHO + SEP_X) + 40, y: i * (ALTO + SEP_Y) + 40 };
  }));
  let yLibre = Math.max(...Object.values(cols).map(c => c.length), 1) * (ALTO + SEP_Y) + 120;
  d.sueltos.forEach((id, i) => { pos[id] = { x: (i % 5) * (ANCHO + SEP_X) + 40, y: yLibre }; });

  const esc2 = t => String(t || '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

  const celdas = d.nodos.map((n, i) => {
    const p = pos[n.id] || { x: 40, y: yLibre + 120 };
    const etiqueta = `${esc2((n.codigo ? n.codigo + ' — ' : '') + n.nombre)}&#10;${esc2(n.area || '')}`;
    return `<mxCell id="n${i}" value="${etiqueta}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#F8FAF7;strokeColor=#112236;fontSize=11;align=left;spacingLeft=8;" vertex="1" parent="1">
      <mxGeometry x="${p.x}" y="${p.y}" width="${ANCHO}" height="${ALTO}" as="geometry"/></mxCell>`;
  });

  const idx = {}; d.nodos.forEach((n, i) => { idx[n.id] = 'n' + i; });
  const aristas = d.enlaces.map((e, i) =>
    `<mxCell id="e${i}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;" edge="1" parent="1" source="${idx[e.de]}" target="${idx[e.a]}"><mxGeometry relative="1" as="geometry"/></mxCell>`);

  const xml = `<mxfile host="levantamiento"><diagram name="Mapa de procesos">
  <mxGraphModel dx="1100" dy="800" grid="1" gridSize="10" guides="1" tooltips="1"
    connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1100" math="0" shadow="0">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      ${celdas.join('\n      ')}
      ${aristas.join('\n      ')}
    </root>
  </mxGraphModel></diagram></mxfile>`;
  return { texto: xml, nombre: 'mapa-procesos.drawio', tipo: 'application/xml' };
}

/** El SVG con los colores resueltos: fuera de la app no existen las variables. */
function svgLimpio() {
  const svg = document.getElementById('svgMapa');
  if (!svg) return '';
  const c = getComputedStyle(document.body);
  let t = svg.outerHTML;
  ['--surface', '--ink', '--ink-2', '--ink-3', '--font'].forEach(v => {
    t = t.split(`var(${v})`).join(c.getPropertyValue(v).trim() || '#333');
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + t;
}

function bajarTexto(nombre, texto, tipo) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([texto], { type: tipo + ';charset=utf-8' }));
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Descargado: ' + nombre);
}

/* ═══════════════════════════════════════════════════════════════
   Cuadro “tener en cuenta”

   Lo escribe la clínica antes de la entrevista y lo lee quien levanta.
   Va arriba del todo a propósito: advertencias tipo “doña Marta solo
   está los martes” o “este proceso cambió en junio” sirven antes de
   la visita, no después.
   ═══════════════════════════════════════════════════════════════ */
function cuadroClinica(p) {
  const puede = esAdmin() || esClinica();
  const texto = p.notasClinica || '';
  if (!puede && !texto) return '';

  return `<div class="cuadro-clinica ${texto ? '' : 'vacio'}">
    <div class="cc-cab">
      <span class="cc-et">Tener en cuenta</span>
      <span class="tiny">${puede ? 'Lo escribe la clínica para quien va a entrevistar'
                                 : 'Nota de la clínica'}</span>
      <span class="tiny right" id="ccEstado"></span>
    </div>
    ${puede
      ? `<textarea id="ccTexto" placeholder="Ej: La persona que conoce esto es doña Marta, y solo está los martes y jueves por la mañana. El proceso cambió en junio cuando entró el kiosco.">${esc(texto)}</textarea>`
      : `<div class="cc-lectura">${texto}</div>`}
  </div>`;
}

function conectarCuadroClinica(p) {
  const el = document.getElementById('ccTexto');
  if (!el) return;
  let t = null;
  el.oninput = () => {
    const eco = document.getElementById('ccEstado');
    if (eco) eco.textContent = 'Sin guardar…';
    clearTimeout(t);
    t = setTimeout(async () => {
      try {
        await api('/procesos/' + p.id + '/nota-clinica',
                  { method: 'PUT', body: { notasClinica: el.value } });
        p.notasClinica = el.value;
        const enLista = S.procesos.find(x => x.id === p.id);
        if (enLista) enLista.notasClinica = el.value;
        if (eco) { eco.textContent = 'Guardado'; setTimeout(() => { eco.textContent = ''; }, 2000); }
      } catch (_) { if (eco) eco.textContent = 'No se pudo guardar'; }
    }, 700);
  };
}

/* ═══════════════════════════════════════════════════════════════
   Avance — la vista de la clínica

   No le interesa quién va atrasado sino cuánto falta para terminar y
   qué ya puede leer.
   ═══════════════════════════════════════════════════════════════ */
/** Para la clínica, lo urgente es prepararse: hoy y mañana arriba, lo que
    quedó atrás al final y sin alarma, porque no es su tarea resolverlo. */
function panelClinica(ps) {
  const activos = ps.filter(p => p.estado !== 'aprobado');

  const fila = p => `<div class="cita-fila ${p.atiende ? 'lista' : 'falta'}" data-fila="${p.id}">
    <div class="cf-hora">
      <select data-hora="${p.id}" title="Hora de la cita">
        <option value="">--:--</option>
        ${HORAS.map(h => `<option value="${h}" ${p.hora === h ? 'selected' : ''}>${h}</option>`).join('')}
      </select>
    </div>
    <div class="cf-datos">
      <a class="cf-nom" href="#/proceso/${p.id}">${esc(p.nombre)}</a>
      <div class="tiny">${esc(p.area || 'Sin área')} · lo levanta ${esc(nombrePersona(p.responsable))}</div>
    </div>
    <div class="cf-quien">
      <input type="text" data-atiende="${p.id}" value="${esc(p.atiende || '')}"
        placeholder="¿Quién atiende?" list="sug-atiende">
    </div>
    <div class="cf-fecha">
      <input type="date" data-fechacita="${p.id}" value="${esc((p.fechaCita || '').slice(0, 10))}"
        title="Día de la cita">
    </div>
    <span class="tiny cf-eco" data-eco="${p.id}"></span>
  </div>`;

  const caja = (k, titulo, vacio, clase) => {
    const lista = activos.filter(p => cajonAgenda(p) === k)
      .sort((a, b) => (a.hora || '99:99').localeCompare(b.hora || '99:99'));
    return `<div class="card panel-urg ${lista.length ? clase : ''}">
      <h3>${titulo} <span class="cuenta-urg">${lista.length}</span></h3>
      ${lista.length
        ? `<div class="citas">${lista.map(fila).join('')}</div>`
        : `<div class="mut">${vacio}</div>`}
    </div>`;
  };

  const atrasados = activos.filter(p => cajonAgenda(p) === 'vencidos');

  return `<p class="mut" style="margin-top:-8px">
      Escriba aquí mismo quién atiende, el día y la hora. Se guarda solo.</p>

    <div class="grid g2" style="margin:14px 0 18px">
      ${caja('hoy', 'Hoy vienen a levantar', 'Hoy no hay ninguno programado.', 'activo')}
      ${caja('manana', 'Mañana', 'Mañana no hay nada agendado todavía.', 'manana')}
    </div>

    ${atrasados.length ? `<div class="tiny" style="margin-bottom:18px;padding:11px 15px;
      background:var(--surface-2);border-radius:10px">
      ${atrasados.length} proceso(s) quedaron pasados de fecha y el equipo los reprogramará:
      ${atrasados.slice(0, 5).map(p => esc(p.nombre)).join(' · ')}
    </div>` : ''}`;
}

function vistaAvanceClinica(m) {
  const ps = S.procesos;
  const enviados = ps.filter(p => p.estado === 'en_revision' || p.estado === 'aprobado');
  const av = avanceGlobal();
  const areas = [...new Set(ps.map(p => p.area || 'Sin área'))];
  const sinAtender = ps.filter(p => !p.atiende && p.estado !== 'aprobado');

  m.innerHTML = `
  <div class="topbar"><h1>Hoy y mañana</h1><div class="sp"></div>
    <button class="btn p" id="proponer">+ Proponer un proceso</button></div>

  <h3 style="margin:26px 0 12px;font-size:17px">Cómo va todo</h3>
  <div class="grid g4" style="margin-bottom:16px">
    <div class="kpi"><div class="n">${ps.length}</div><div class="t">Procesos identificados</div></div>
    <div class="kpi"><div class="n">${av}%</div><div class="t">Avance general</div>
      <div class="bar" style="margin-top:8px"><i style="width:${av}%"></i></div></div>
    <div class="kpi"><div class="n">${enviados.length}</div><div class="t">Listos para leer</div></div>
    <div class="kpi"><div class="n">${sinAtender.length}</div><div class="t">Sin asignar de su lado</div></div>
  </div>

  ${sinAtender.length ? `<div class="banner" style="margin-bottom:16px">
    Hay ${sinAtender.length} proceso(s) donde todavía no han dicho quién de la clínica responde.
    Se asignan desde <b>Agenda</b>.</div>` : ''}

  ${panelClinica(ps)}

  <div class="grid g2" style="margin-bottom:16px">
    <div class="card"><h3>Cómo va cada área</h3>
      ${areas.map(a => {
        const sub = ps.filter(p => (p.area || 'Sin área') === a);
        const x = Math.round(sub.reduce((t, p) => t + avance(p), 0) / sub.length);
        const list = sub.filter(p => p.estado === 'en_revision' || p.estado === 'aprobado').length;
        return `<div style="margin-bottom:12px">
          <div class="flex" style="font-size:13px;margin-bottom:4px">
            <span>${esc(a)}</span>
            <span class="right mut">${list} de ${sub.length} terminados · ${x}%</span></div>
          <div class="bar"><i style="width:${x}%"></i></div></div>`;
      }).join('') || '<div class="mut">Todavía no hay procesos.</div>'}
    </div>

    <div class="card"><h3>En qué punto está cada uno</h3>
      ${ESTADOS.map(e => {
        const n = ps.filter(p => (p.estado || 'pendiente') === e.k).length;
        const pc = ps.length ? Math.round(n / ps.length * 100) : 0;
        return `<div style="margin-bottom:11px"><div class="flex" style="font-size:13px;margin-bottom:4px">
          <span>${esc(e.n)}</span><span class="right mut">${n}</span></div>
          <div class="bar"><i style="width:${pc}%"></i></div></div>`;
      }).join('')}
    </div>
  </div>

  <div class="card"><h3>Ya se pueden leer</h3>
    ${enviados.length ? `<div class="tw"><table class="t"><tbody>
      ${enviados.map(p => `<tr>
        <td><a class="nombre-proc" href="#/proceso/${p.id}"><b>${esc(p.nombre)}</b></a>
          <div class="tiny">${esc(p.area || '')}${p.atiende ? ' · atendió ' + esc(p.atiende) : ''}</div></td>
        <td style="width:110px"><span class="pill ${p.estado}">${esc(etiquetaEstado(p.estado))}</span></td>
        <td style="width:120px"><div class="bar"><i style="width:${avance(p)}%"></i></div></td>
        <td style="width:120px">${p.informeUrl
          ? `<a class="btn sm" href="${esc(p.informeUrl)}" target="_blank" rel="noopener">Leer informe</a>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`
      : '<div class="mut">Todavía ninguno. Aparecen aquí a medida que el equipo los va enviando.</div>'}
  </div>`;

  document.getElementById('proponer').onclick = modalProponer;
  conectarAgenda(m);
}

/* ═══════════════════════════════════════════════════════════════
   Proponer un proceso

   En toda entrevista aparecen procesos que nadie tenía en la lista.
   Que la clínica pueda anotarlos en el momento evita que se pierdan.
   ═══════════════════════════════════════════════════════════════ */
function modalProponer() {
  modal(`<h3>Proponer un proceso</h3>
    <p class="mut" style="margin-top:-6px">
      ¿Apareció algo que no estaba en la lista? Anótelo aquí. Queda pendiente para que
      la coordinación decida quién lo levanta y cuándo.
    </p>
    <label class="f"><span class="lbl">¿Cómo se llama? <span class="req">*</span></span>
      <input type="text" id="ppNombre" placeholder="Ej: Entrega de resultados por WhatsApp"></label>
    <div class="grid g2">
      <label class="f"><span class="lbl">¿De qué área es?</span>
        <select id="ppArea">${(S.config.areas || []).map(a => `<option>${esc(a)}</option>`).join('')}</select></label>
      <label class="f"><span class="lbl">¿Quién sabe de esto?</span>
        <input type="text" id="ppContacto" placeholder="Nombre y cargo"></label>
    </div>
    <label class="f"><span class="lbl">¿Por qué vale la pena levantarlo?</span>
      <textarea id="ppNota" placeholder="Ej: Salió en la entrevista de admisiones. Nadie lo tiene documentado y se hace todos los días; genera reclamos de pacientes."></textarea></label>
    <div class="flex"><button class="btn" data-cerrar>Cancelar</button>
      <button class="btn p right" id="ppOk">Proponer</button></div>`,
  box => {
    box.querySelector('#ppOk').onclick = async () => {
      const nombre = box.querySelector('#ppNombre').value.trim();
      if (!nombre) { toast('Ponle un nombre'); return; }
      try {
        await api('/procesos', { method: 'POST', body: {
          nombre,
          area: box.querySelector('#ppArea').value,
          contacto: box.querySelector('#ppContacto').value.trim(),
          notasClinica: box.querySelector('#ppNota').value.trim()
        }});
        const d = await api('/procesos');
        S.procesos = d.procesos;
        cerrarModal(); render();
        toast('Propuesto. La coordinación lo verá como pendiente de asignar.');
      } catch (_) { toast('No se pudo proponer'); }
    };
    setTimeout(() => box.querySelector('#ppNombre').focus(), 50);
  });
}

/* ═══════════════════════════════════════════════════════════════
   Volver al informe ya enviado

   El enlace no se pierde al cerrar la ventana de envío: sigue siendo
   el mismo y se puede recuperar aquí cuantas veces haga falta.
   ═══════════════════════════════════════════════════════════════ */
async function modalInforme(p) {
  const url = p.informeUrl;
  if (!url) { toast('Este proceso todavía no se ha enviado'); return; }

  const texto = `*${p.nombre}*\n${[p.codigo, p.area].filter(Boolean).join(' · ')}\n\n` +
    `Puedes ver el informe completo, con las fotos y escuchar los audios, aquí:\n${url}`;
  const wa = 'https://wa.me/?text=' + encodeURIComponent(texto);
  const correo = 'mailto:?subject=' + encodeURIComponent('Levantamiento: ' + p.nombre) +
                 '&body=' + encodeURIComponent(texto);

  modal(`<h3>Informe de ${esc(p.nombre)}</h3>
    <p class="mut" style="margin-top:-6px">
      Este enlace siempre muestra la última versión enviada. Si el proceso se
      reenvía, quien ya lo tenga verá la versión nueva sin que le mandes nada.
    </p>

    <div class="flex wrap" style="gap:8px;margin:14px 0">
      <a class="btn p" href="${esc(url)}" target="_blank" rel="noopener">📄 Abrir informe</a>
      <a class="btn" href="${wa}" target="_blank" rel="noopener">📲 WhatsApp</a>
      <a class="btn" href="${correo}">✉ Correo</a>
    </div>

    <span class="lbl">Enlace</span>
    <input type="text" id="infUrl" value="${esc(url)}" readonly style="font-size:12px">

    <div id="infEnvios" class="mut" style="margin-top:16px">Consultando los envíos…</div>

    <div class="flex" style="margin-top:14px">
      <button class="btn" id="copiarInf">Copiar enlace</button>
      ${esAdmin() || puedeEditar() ? '<button class="btn danger" id="anular">Anular enlace</button>' : ''}
      <button class="btn right" data-cerrar>Cerrar</button>
    </div>`,
  async box => {
    box.querySelector('#copiarInf').onclick = async () => {
      try { await navigator.clipboard.writeText(url); toast('Enlace copiado'); }
      catch (_) { box.querySelector('#infUrl').select(); toast('Selecciona y copia'); }
    };

    const anular = box.querySelector('#anular');
    if (anular) anular.onclick = async () => {
      if (!confirm('Quien tenga el enlace dejará de ver el informe. Al reenviar el proceso se genera uno nuevo. ¿Anular?')) return;
      await api('/procesos/' + p.id + '/compartir', { method: 'DELETE' });
      const d = await api('/procesos');
      S.procesos = d.procesos;
      if (S.draft && S.draft.id === p.id) S.draft.informeUrl = '';
      cerrarModal(); render(); toast('Enlace anulado');
    };

    try {
      const d = await api('/procesos/' + p.id + '/envios');
      const caja = box.querySelector('#infEnvios');
      caja.innerHTML = d.envios.length
        ? `<span class="lbl">Envíos</span><table class="t"><tbody>${d.envios.map(e => `<tr>
            <td><b>Envío #${e.numero}</b><div class="tiny">${esc(fechaLarga(e.creado))} · ${esc(e.por || '')}</div></td>
            <td class="tiny" style="width:150px">${e.avance}% · 📷 ${e.fotos} · 🎙 ${e.audios}</td>
          </tr>`).join('')}</tbody></table>`
        : '<div class="mut">Sin envíos registrados.</div>';
    } catch (_) {
      box.querySelector('#infEnvios').innerHTML = '';
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   Análisis con Claude

   Genera un documento paralelo al levantamiento. No lo reemplaza ni lo
   modifica: queda al lado, y solo entra al proceso lo que el
   administrador apruebe. Las conexiones aprobadas sí se aplican, porque
   de ellas vive el mapa.
   ═══════════════════════════════════════════════════════════════ */
async function modalAnalisis(p) {
  modal(`<h3>Análisis de ${esc(p.nombre)}</h3>
    <div id="iaCuerpo"><div class="mut">Buscando análisis anteriores…</div></div>
    <div class="flex" style="margin-top:16px">
      <button class="btn p" id="iaGenerar">✨ Analizar ahora</button>
      <button class="btn right" data-cerrar>Cerrar</button>
    </div>`, async box => {
    const cuerpo = box.querySelector('#iaCuerpo');
    const btn = box.querySelector('#iaGenerar');

    const cargar = async () => {
      try {
        const d = await api('/procesos/' + p.id + '/analisis');
        pintarAnalisis(cuerpo, p, d.analisis);
        btn.textContent = d.analisis.length ? '✨ Analizar de nuevo' : '✨ Analizar ahora';
      } catch (_) { cuerpo.innerHTML = '<div class="mut">No se pudo consultar.</div>'; }
    };

    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Analizando… puede tardar un minuto';
      const ev = p.evidencias || [];
      const nf = ev.filter(e => e.tipo === 'foto').length;
      const na = ev.filter(e => e.tipo === 'audio').length;
      cuerpo.innerHTML = `<div class="mut">Claude está leyendo el levantamiento completo:
        respuestas, actividades, sub-actividades y notas${nf ? `, y mirando ${Math.min(nf, 8)} de las ${nf} foto(s)` : ''}.
        ${na ? `<br><br>Las ${na} nota(s) de voz no las puede escuchar: le digo dónde están y en qué
        pregunta, para que te señale cuáles conviene que oigas tú.` : ''}
        <br><br>No cierres esta ventana.</div>`;
      try {
        await api('/procesos/' + p.id + '/analizar', { method: 'POST' });
        await cargar();
        toast('Análisis listo');
      } catch (e) {
        cuerpo.innerHTML = errorAnalisis(e);
        const ver = cuerpo.querySelector('#verCrudo');
        if (ver) ver.onclick = () => {
          const caja = cuerpo.querySelector('#crudo');
          caja.classList.toggle('oculto');
          ver.textContent = caja.classList.contains('oculto')
            ? 'Ver lo que devolvió' : 'Ocultar';
        };
      }
      btn.disabled = false;
      btn.textContent = '✨ Analizar de nuevo';
    };

    await cargar();
  });
}

/** El mensaje de error dice qué pasó, por qué, y deja ver la respuesta cruda. */
function errorAnalisis(e) {
  const d = (e && e.data) || {};
  const c = d.error || '';
  const ctx = d.contexto || {};

  const titulos = {
    sin_llave: 'Falta la llave de Claude',
    llave_invalida: 'La llave de Claude no es válida',
    sin_saldo: 'La cuenta de Anthropic no tiene saldo',
    limite_alcanzado: 'Se alcanzó el límite de peticiones',
    sin_conexion: 'El servidor no pudo comunicarse con Claude',
    error_api: 'Anthropic devolvió un error',
    muy_vacio: 'El levantamiento está muy vacío para analizarlo',
    respuesta_vacia: 'Claude no devolvió nada',
    respuesta_ilegible: 'La respuesta no se pudo interpretar'
  };

  const acciones = {
    sin_llave: 'Configúrala en Ajustes → Análisis con Claude.',
    llave_invalida: 'Revísala en Ajustes y usa el botón Probar conexión.',
    sin_saldo: 'Carga saldo en console.anthropic.com → Billing.',
    limite_alcanzado: 'Espera un minuto y vuelve a intentarlo.',
    sin_conexion: 'Revisa que Railway tenga salida a internet.',
    muy_vacio: `Va en ${d.avance || 0}%. Complétalo un poco más y vuelve.`
  };

  const detalleTecnico = [
    ctx.stop_reason ? `motivo de corte: ${ctx.stop_reason}` : '',
    ctx.modelo ? `modelo: ${ctx.modelo}` : '',
    ctx.tokens_salida ? `respondió ${ctx.tokens_salida} tokens` : '',
    d.tamanoEnviado ? `se le enviaron ${Math.round(d.tamanoEnviado / 1000)} mil caracteres` : ''
  ].filter(Boolean).join(' · ');

  return `<div class="aviso-ia error">
    <b>${esc(titulos[c] || 'No se pudo generar el análisis')}</b>
    ${d.detalle ? `<div style="margin-top:7px">${esc(d.detalle)}</div>` : ''}
    ${acciones[c] ? `<div style="margin-top:7px">${esc(acciones[c])}</div>` : ''}
    ${detalleTecnico ? `<div class="tiny" style="margin-top:9px">${esc(detalleTecnico)}</div>` : ''}
    ${d.crudo ? `<div style="margin-top:10px">
      <button class="btn sm" id="verCrudo">Ver lo que devolvió</button>
      <pre id="crudo" class="crudo oculto">${esc(d.crudo)}</pre>
    </div>` : ''}
  </div>`;
}

function pintarAnalisis(cuerpo, p, lista) {
  if (!lista.length) {
    const ev = p.evidencias || [];
    const nf = ev.filter(e => e.tipo === 'foto').length;
    const na = ev.filter(e => e.tipo === 'audio').length;
    cuerpo.innerHTML = `<div class="aviso-ia">
      Claude leerá todo lo levantado —respuestas, actividades, sub-actividades y notas—
      ${nf ? `y <b>mirará las fotos</b> para leer los formatos y pantallas que haya ahí` : ''}.
      Devolverá un documento aparte: resumen, paso a paso ordenado, dolores con su impacto,
      propuestas de mejora y automatización, riesgos, y con qué otros procesos conecta.
      ${na ? `<br><br><b>Sobre las ${na} nota(s) de voz:</b> no las puede escuchar. Le digo
        dónde está cada una para que te señale cuáles vale la pena que oigas tú.` : ''}
      <br><br>Nada de esto toca el levantamiento original. Tú decides qué se aprueba.
    </div>`;
    return;
  }

  const a = lista[0];
  const c = a.contenido || {};
  const l = x => Array.isArray(x) ? x : [];
  const incompleto = c._recuperado || c._reparado;

  const bloque = (titulo, contenido) => contenido
    ? `<section class="ia-bloque"><h4>${titulo}</h4>${contenido}</section>` : '';

  cuerpo.innerHTML = `
    <div class="ia-cab">
      <span class="pill ${a.estado === 'aprobado' ? 'aprobado' : a.estado === 'descartado' ? 'pendiente' : 'en_revision'}">
        ${a.estado === 'aprobado' ? 'Aprobado' : a.estado === 'descartado' ? 'Descartado' : 'Por revisar'}</span>
      <span class="tiny">${esc(fechaLarga(a.creado))} · pedido por ${esc(a.pedidoPor)}
        ${a.aprobadoPor ? ' · revisado por ' + esc(a.aprobadoPor) : ''}</span>
    </div>

    ${incompleto ? `<div class="aviso-ia" style="margin-bottom:16px">
      ${c._recuperado
        ? 'La respuesta llegó cortada por su longitud y se rescató la parte válida. Puede faltarle el final; si quieres el análisis completo, vuelve a pedirlo.'
        : 'Hubo que pedirle a Claude que corrigiera el formato. El contenido es el mismo.'}
    </div>` : ''}

    ${bloque('Resumen', c.resumen ? `<p>${esc(c.resumen)}</p>` : '')}

    ${c.calidad ? `<div class="ia-calidad ${esc(c.calidad.completitud || '')}">
      <b>Completitud del levantamiento: ${esc(c.calidad.completitud || 'n/d')}</b>
      ${l(c.calidad.vacios).length ? `<ul>${l(c.calidad.vacios).map(v => `<li>${esc(v)}</li>`).join('')}</ul>` : ''}
    </div>` : ''}

    ${bloque('Paso a paso, ordenado', l(c.pasos_mejorados).length
      ? `<ol class="ia-pasos">${l(c.pasos_mejorados).map(x => `<li>
          <b>${esc(x.actividad || '')}</b>
          <div class="tiny">${esc(x.responsable || '?')} · ${esc(x.sistema || '?')}</div>
          ${x.observacion ? `<div class="ia-obs">${esc(x.observacion)}</div>` : ''}
        </li>`).join('')}</ol>` : '')}

    ${bloque('Dolores y su impacto', l(c.dolores).length
      ? `<ul class="ia-lista">${l(c.dolores).map(x =>
          `<li><b>${esc(x.dolor || '')}</b><div class="tiny">${esc(x.impacto || '')}</div></li>`).join('')}</ul>` : '')}

    ${bloque('Qué se podría optimizar', l(c.optimizaciones).length
      ? `<ul class="ia-lista">${l(c.optimizaciones).map(x => `<li>
          <b>${esc(x.propuesta || '')}</b>
          <div class="tiny">${esc(x.por_que || '')}</div>
          <div class="ia-etiquetas">
            <span class="et esfuerzo-${esc(x.esfuerzo || '')}">esfuerzo ${esc(x.esfuerzo || '?')}</span>
            <span class="et impacto-${esc(x.impacto || '')}">impacto ${esc(x.impacto || '?')}</span>
          </div></li>`).join('')}</ul>` : '')}

    ${bloque('Qué se podría automatizar', l(c.automatizaciones).length
      ? `<ul class="ia-lista">${l(c.automatizaciones).map(x => `<li>
          <b>${esc(x.propuesta || '')}</b>
          <div class="tiny">${esc(x.que_haria_el_sistema || '')}</div>
          ${x.requisito ? `<div class="ia-obs">Hace falta: ${esc(x.requisito)}</div>` : ''}
        </li>`).join('')}</ul>` : '')}

    ${l(c.hallazgos_en_fotos).length ? `<section class="ia-bloque">
      <h4>Lo que vio en las fotos</h4>
      <ul class="ia-lista">${l(c.hallazgos_en_fotos).map(x =>
        `<li><b>Foto ${esc(x.foto || '?')}</b> — ${esc(x.observacion || '')}</li>`).join('')}</ul>
    </section>` : ''}

    ${l(c.audios_por_escuchar).length ? `<section class="ia-bloque">
      <h4>Audios que deberías escuchar</h4>
      <p class="tiny">Claude no puede oírlos. Estos son los puntos donde la respuesta
        probablemente está en la grabación y no en lo escrito.</p>
      <ul class="ia-lista">${l(c.audios_por_escuchar).map(x =>
        `<li><b>${esc(x.donde || '')}</b><div class="tiny">${esc(x.por_que || '')}</div></li>`).join('')}</ul>
    </section>` : ''}

    ${bloque('Riesgos', l(c.riesgos).length
      ? `<ul class="ia-lista">${l(c.riesgos).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '')}

    ${bloque('Preguntas para la siguiente visita', l(c.preguntas_para_la_siguiente_visita).length
      ? `<ul class="ia-lista">${l(c.preguntas_para_la_siguiente_visita).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '')}

    ${l(c.conexiones).length ? `<section class="ia-bloque">
      <h4>Conexiones que propone</h4>
      <p class="tiny">Marca las que sean ciertas. Al aprobar el análisis, esas se aplican
        al proceso y aparecen en el mapa. Las demás se ignoran.</p>
      <div class="ia-conexiones">${l(c.conexiones).map((x, i) => `
        <label class="ia-conex">
          <input type="checkbox" data-conex="${i}"
            ${(c.conexiones_aprobadas || []).some(y => y.proceso === x.proceso) ? 'checked' : ''}>
          <span>
            <b>${x.direccion === 'antes' ? 'Viene de' : 'Pasa a'}: ${esc(x.proceso || '')}</b>
            <span class="et conf-${esc(x.confianza || '')}">${esc(x.confianza || '')}</span>
            <div class="tiny">${esc(x.razon || '')}</div>
          </span>
        </label>`).join('')}</div>
    </section>` : ''}

    ${a.estado === 'propuesto' ? `<div class="ia-decidir">
      <button class="btn" id="iaDescartar">Descartar</button>
      <button class="btn p right" id="iaAprobar">Aprobar y adjuntar</button>
    </div>` : ''}

    ${a.estado === 'aprobado' ? '<div class="aviso-ia ok">Aprobado: sale adjunto en el informe que se comparte.</div>' : ''}

    ${lista.length > 1 ? `<div class="tiny" style="margin-top:12px">Hay ${lista.length - 1} análisis anterior(es) de este proceso.</div>` : ''}`;

  const decidir = async estado => {
    const conexiones = [...cuerpo.querySelectorAll('[data-conex]:checked')]
      .map(cb => l(c.conexiones)[+cb.dataset.conex]);
    try {
      const r = await api('/analisis/' + a.id + '/decidir',
                          { method: 'POST', body: { estado, conexiones } });
      if (r.conexionesAplicadas) {
        const d = await api('/procesos');
        S.procesos = d.procesos;
        const fresco = S.procesos.find(x => x.id === p.id);
        if (fresco && S.draft && S.draft.id === p.id) S.draft.respuestas = fresco.respuestas;
        toast(`Aprobado · ${r.conexionesAplicadas} conexión(es) aplicadas al mapa`);
      } else {
        toast(estado === 'aprobado' ? 'Análisis aprobado' : 'Análisis descartado');
      }
      const d2 = await api('/procesos/' + p.id + '/analisis');
      pintarAnalisis(cuerpo, p, d2.analisis);
    } catch (_) { toast('No se pudo guardar la decisión'); }
  };

  const ap = cuerpo.querySelector('#iaAprobar');
  if (ap) ap.onclick = () => decidir('aprobado');
  const de = cuerpo.querySelector('#iaDescartar');
  if (de) de.onclick = () => decidir('descartado');
}

/* Configuración de la llave. Nunca vuelve completa al navegador: el
   servidor solo devuelve una versión enmascarada. */
async function pintarConfigIA() {
  const caja = document.getElementById('iaConf');
  if (!caja) return;
  let e;
  try { e = await api('/ia/estado'); }
  catch (_) { caja.innerHTML = '<div class="mut">No se pudo consultar.</div>'; return; }

  caja.innerHTML = `
    ${e.configurada
      ? `<div class="aviso-ia ok">Llave configurada: <b>${esc(e.llave)}</b> · modelo ${esc(e.modelo)}</div>`
      : '<div class="aviso-ia">Todavía no hay llave. El botón de análisis no funcionará.</div>'}
    <label class="f" style="margin-top:12px">
      <span class="lbl">${e.configurada ? 'Reemplazar la llave' : 'Llave de Anthropic'}</span>
      <span class="hint">Se obtiene en console.anthropic.com → API keys. Empieza por sk-ant-.
        Se guarda en el servidor y no vuelve a mostrarse completa.</span>
      <input type="password" id="iaLlave" placeholder="sk-ant-..." autocomplete="off">
    </label>
    <div class="flex wrap" style="gap:8px">
      <button class="btn p" id="iaGuardar">Guardar llave</button>
      <button class="btn" id="iaProbar">Probar conexión</button>
      ${e.configurada ? '<button class="btn danger" id="iaBorrar">Quitar llave</button>' : ''}
      <span class="tiny" id="iaEco"></span>
    </div>`;

  const eco = caja.querySelector('#iaEco');

  caja.querySelector('#iaGuardar').onclick = async () => {
    const v = caja.querySelector('#iaLlave').value.trim();
    if (!v) { toast('Pega la llave primero'); return; }
    try {
      await api('/ia/llave', { method: 'PUT', body: { llave: v } });
      toast('Llave guardada'); pintarConfigIA();
    } catch (_) { toast('No se pudo guardar'); }
  };

  caja.querySelector('#iaProbar').onclick = async () => {
    eco.textContent = 'Probando…';
    try {
      const r = await api('/ia/probar', { method: 'POST' });
      eco.textContent = '✓ Responde correctamente (' + r.modelo + ')';
    } catch (err) {
      const c = (err.data && err.data.error) || '';
      eco.textContent = {
        sin_llave: 'Falta la llave',
        llave_invalida: '✗ La llave no es válida',
        sin_conexion: '✗ El servidor no alcanza a Anthropic'
      }[c] || '✗ No respondió';
    }
  };

  const borrar = caja.querySelector('#iaBorrar');
  if (borrar) borrar.onclick = async () => {
    if (!confirm('Se quitará la llave y dejará de funcionar el análisis. ¿Seguir?')) return;
    await api('/ia/llave', { method: 'PUT', body: { llave: '' } });
    toast('Llave eliminada'); pintarConfigIA();
  };
}

/* ═══════════════════════════════════════════════════════════════
   Revisión — donde aterriza lo que las analistas envían

   Un solo lugar para lo que espera decisión: leer el informe, pedir el
   análisis de Claude, aprobarlo, y cerrar el proceso o devolverlo con
   el motivo. Es la mesa de trabajo de la coordinación.
   ═══════════════════════════════════════════════════════════════ */
function vistaRevision(m) {
  S.filtroRev = S.filtroRev || 'esperando';
  const enviados = S.procesos.filter(p => p.estado === 'en_revision');
  const aprobados = S.procesos.filter(p => p.estado === 'aprobado');
  const devueltos = S.procesos.filter(p => p.notaRevision && p.estado === 'en_curso');

  const listas = { esperando: enviados, aprobados, devueltos };
  const lista = listas[S.filtroRev] || enviados;

  m.innerHTML = `
  <div class="topbar"><h1>Revisión</h1><div class="sp"></div>
    <div class="tabs">
      <button class="tab ${S.filtroRev === 'esperando' ? 'on' : ''}" data-rev="esperando">
        Esperando <span class="tiny">${enviados.length}</span></button>
      <button class="tab ${S.filtroRev === 'aprobados' ? 'on' : ''}" data-rev="aprobados">
        Aprobados <span class="tiny">${aprobados.length}</span></button>
      <button class="tab ${S.filtroRev === 'devueltos' ? 'on' : ''}" data-rev="devueltos">
        Devueltos <span class="tiny">${devueltos.length}</span></button>
    </div>
    <a class="btn sm" href="#/mapa">⤳ Ver el mapa</a>
  </div>

  ${S.filtroRev === 'esperando' && !enviados.length
    ? `<div class="empty"><span class="e">✓</span>
        Nada esperando. Cuando una analista pulse Enviar, el proceso aparece aquí.</div>`
    : ''}

  <div class="revision-lista">
    ${lista.sort((a, b) => (b.enviadoEn || '').localeCompare(a.enviadoEn || ''))
           .map(p => tarjetaRevision(p)).join('')}
  </div>`;

  m.querySelectorAll('[data-rev]').forEach(b => b.onclick = () => {
    S.filtroRev = b.dataset.rev; vistaRevision(m);
  });

  m.querySelectorAll('[data-abrirproc]').forEach(b => b.onclick = () => abrirProceso(b.dataset.abrirproc));
  m.querySelectorAll('[data-ia]').forEach(b => b.onclick = () => {
    const p = S.procesos.find(x => x.id === b.dataset.ia);
    if (p) modalAnalisis(p);
  });
  m.querySelectorAll('[data-aprobar]').forEach(b => b.onclick = () => decidirRevision(b.dataset.aprobar, 'aprobado', m));
  m.querySelectorAll('[data-devolver]').forEach(b => b.onclick = () => decidirRevision(b.dataset.devolver, 'devuelto', m));
}

function tarjetaRevision(p) {
  const ev = p.evidencias || [];
  const av = avance(p);
  const esperando = p.estado === 'en_revision';

  return `<div class="rev-card ${esperando ? 'esperando' : ''}">
    <div class="rev-cab">
      <div style="flex:1;min-width:0">
        <b class="rev-nom">${esc(p.nombre)}</b>
        <div class="tiny">${esc(p.codigo || '')} · ${esc(p.area || 'Sin área')} ·
          levantado por ${esc(nombrePersona(p.responsable))}
          ${p.atiende ? ' · atendió ' + esc(p.atiende) : ''}</div>
      </div>
      <span class="pill ${p.estado}">${esc(etiquetaEstado(p.estado))}</span>
    </div>

    <div class="rev-datos">
      <div><b>${av}%</b><span class="tiny">completo</span></div>
      <div><b>${ev.filter(e => e.tipo === 'foto').length}</b><span class="tiny">fotos</span></div>
      <div><b>${ev.filter(e => e.tipo === 'audio').length}</b><span class="tiny">audios</span></div>
      <div><b>${p.enviosTotal || 0}</b><span class="tiny">envío(s)</span></div>
      <div><b>${p.enviadoEn ? esc(fechaLarga(p.enviadoEn)) : '—'}</b><span class="tiny">enviado</span></div>
    </div>

    ${p.notaRevision ? `<div class="rev-nota">
      <b>${p.estado === 'aprobado' ? 'Al aprobar escribiste:' : 'Se devolvió con este motivo:'}</b>
      ${esc(p.notaRevision)}</div>` : ''}

    <div class="rev-acciones">
      ${p.informeUrl ? `<a class="btn" href="${esc(p.informeUrl)}" target="_blank" rel="noopener">📄 Leer informe</a>` : ''}
      <button class="btn" data-abrirproc="${p.id}">Abrir el levantamiento</button>
      <button class="btn" data-ia="${p.id}">✨ Análisis</button>
      ${esperando ? `
        <button class="btn" data-devolver="${p.id}">↩ Devolver</button>
        <button class="btn p" data-aprobar="${p.id}">✓ Aprobar</button>` : ''}
    </div>
  </div>`;
}

function decidirRevision(pid, decision, m) {
  const p = S.procesos.find(x => x.id === pid);
  if (!p) return;

  const esAprobar = decision === 'aprobado';
  modal(`<h3>${esAprobar ? 'Aprobar' : 'Devolver'} ${esc(p.nombre)}</h3>
    <p class="mut" style="margin-top:-6px">
      ${esAprobar
        ? 'El proceso queda cerrado y sale de la bandeja. El informe sigue disponible.'
        : `Vuelve a ${esc(nombrePersona(p.responsable))} en estado “En curso”. Verá el motivo dentro del proceso.`}
    </p>
    <label class="f"><span class="lbl">${esAprobar ? 'Observación (opcional)' : 'Motivo — qué falta o qué corregir'}</span>
      <textarea id="revNota" placeholder="${esAprobar
        ? 'Ej: quedó completo, sirve como referencia para las demás áreas.'
        : 'Ej: falta el paso a paso de qué pasa cuando el sistema se cae, y las fotos del formato en papel.'}"></textarea></label>
    <div class="flex">
      <button class="btn" data-cerrar>Cancelar</button>
      <button class="btn p right" id="revOk">${esAprobar ? 'Aprobar' : 'Devolver'}</button>
    </div>`, box => {
    box.querySelector('#revOk').onclick = async () => {
      const nota = box.querySelector('#revNota').value.trim();
      if (!esAprobar && !nota) { toast('Escribe el motivo: sin eso no sabe qué corregir'); return; }
      try {
        await api('/procesos/' + pid + '/revisar', { method: 'POST', body: { decision, nota } });
        const d = await api('/procesos');
        S.procesos = d.procesos;
        cerrarModal();
        render();
        toast(esAprobar ? 'Proceso aprobado' : 'Devuelto a ' + nombrePersona(p.responsable));
      } catch (e) { toast('No se pudo guardar la decisión'); }
    };
    setTimeout(() => box.querySelector('#revNota').focus(), 50);
  });
}

/** Elegir qué columnas se ven y en qué orden. */
function modalColumnas(m) {
  const prefs = leerPreferencias();
  const cols = todasLasColumnas();
  const ordenadas = [...cols].sort((a, b) => {
    const ia = prefs.orden.indexOf(a.id), ib = prefs.orden.indexOf(b.id);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });

  modal(`<h3>Organizar las columnas</h3>
    <p class="mut" style="margin-top:-6px">Súbelas o bájalas para ponerlas en el orden que
      te sirva, y desmarca las que no quieras ver. Queda guardado en este computador.</p>
    <div id="colLista">${ordenadas.map((c, i) => `
      <div class="col-orden" data-id="${c.id}">
        <label class="flex" style="flex:1;gap:10px;cursor:pointer">
          <input type="checkbox" data-ver="${c.id}" ${prefs.ocultas.includes(c.id) ? '' : 'checked'}
            style="width:22px;height:22px">
          <b>${esc(c.nombre)}</b>
          <span class="tiny">${S.procesos.filter(p => (p.responsable || '') === c.id).length} proceso(s)</span>
        </label>
        <button class="btn sm ic" data-sube="${c.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn sm ic" data-baja="${c.id}" ${i === ordenadas.length - 1 ? 'disabled' : ''}>↓</button>
      </div>`).join('')}</div>
    <div class="flex" style="margin-top:16px">
      <button class="btn" id="colReset">Volver al orden original</button>
      <button class="btn p right" data-cerrar>Listo</button>
    </div>`, box => {

    const aplicar = () => { guardarPreferencias(); vistaAsignacion(m); cerrarModal(); modalColumnas(m); };

    box.querySelectorAll('[data-ver]').forEach(cb => cb.onchange = () => {
      const id = cb.dataset.ver;
      prefs.ocultas = cb.checked
        ? prefs.ocultas.filter(x => x !== id)
        : prefs.ocultas.concat([id]);
      aplicar();
    });

    const mover = (id, delta) => {
      const ids = ordenadas.map(c => c.id);
      const i = ids.indexOf(id);
      const j = i + delta;
      if (j < 0 || j >= ids.length) return;
      ids.splice(j, 0, ids.splice(i, 1)[0]);
      prefs.orden = ids;
      aplicar();
    };
    box.querySelectorAll('[data-sube]').forEach(b => b.onclick = () => mover(b.dataset.sube, -1));
    box.querySelectorAll('[data-baja]').forEach(b => b.onclick = () => mover(b.dataset.baja, 1));

    box.querySelector('#colReset').onclick = () => {
      prefs.orden = []; prefs.ocultas = [];
      aplicar();
    };
  });
}
