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
const TIPOS_CAMPO = [
  { k: 'texto', n: 'Texto corto' },
  { k: 'parrafo', n: 'Párrafo' },
  { k: 'lista', n: 'Lista (una opción)' },
  { k: 'multi', n: 'Lista (varias)' },
  { k: 'numero', n: 'Número' },
  { k: 'fecha', n: 'Fecha' },
  { k: 'si_no', n: 'Sí / No' },
  { k: 'pasos', n: 'Tabla de actividades' },
  { k: 'persona', n: 'Persona del equipo' }
];

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const esAdmin = () => S.yo && S.yo.rol === 'admin';
const puedeEditar = () => S.yo && (S.yo.rol === 'admin' || S.yo.rol === 'analista');

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

/* ── Arranque ─────────────────────────────────────────────────── */
render();
arrancar();

async function arrancar() {
  try {
    const d = await api('/bootstrap');
    S.yo = d.usuario; S.config = d.config; S.plantilla = d.plantilla;
    if (Array.isArray(S.config.estados) && S.config.estados.length === 4) ESTADOS = S.config.estados;
    S.equipo = d.equipo; S.procesos = d.procesos;
    S.listo = true; render();
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
        ${nav('tablero', '◱', 'Tablero', v)}
        ${nav('procesos', '▤', 'Procesos', v)}
        ${nav('asignacion', '⇄', 'Asignación', v)}
        ${nav('equipo', '👥', 'Equipo', v)}
        ${esAdmin() ? nav('plantilla', '⚙', 'Plantilla', v) : ''}
        ${nav('ajustes', '⋯', 'Ajustes', v)}
      </nav>
      <div class="side-foot">
        <div style="font-weight:600;color:var(--ink-2)">${esc(S.yo.nombre)}</div>
        <div>${esc(S.yo.rol)} · <a href="#" id="salir">salir</a></div>
      </div>
    </aside>
    <main class="main" id="main"></main>
  </div>`;

  r.querySelectorAll('.nav button').forEach(b => b.onclick = () => {
    S.vista = b.dataset.v; S.procId = null; S.draft = null; S.editandoPlantilla = false; render();
  });
  document.getElementById('salir').onclick = async e => {
    e.preventDefault();
    await api('/logout', { method: 'POST' }).catch(() => {});
    location.href = '/login';
  };

  const m = document.getElementById('main');
  ({ tablero: vistaTablero, procesos: vistaProcesos, proceso: vistaProceso,
     asignacion: vistaAsignacion, equipo: vistaEquipo,
     plantilla: vistaPlantilla, ajustes: vistaAjustes }[v] || vistaTablero)(m);
}
function nav(k, ic, lb, v) {
  const on = v === k || (k === 'procesos' && v === 'proceso');
  return `<button data-v="${k}" class="${on ? 'on' : ''}"><span class="ic">${ic}</span><span class="lb">${lb}</span></button>`;
}

/* ── Tablero ──────────────────────────────────────────────────── */
function vistaTablero(m) {
  const ps = S.procesos;
  const porEstado = k => ps.filter(p => p.estado === k).length;
  const fotos = ps.reduce((a, p) => a + (p.evidencias || []).filter(e => e.tipo === 'foto').length, 0);
  const audios = ps.reduce((a, p) => a + (p.evidencias || []).filter(e => e.tipo === 'audio').length, 0);
  const av = avanceGlobal();

  m.innerHTML = `
  <div class="topbar"><h1>Tablero</h1><div class="sp"></div>
    ${puedeEditar() ? '<button class="btn p" id="nuevoTab">+ Nuevo proceso</button>' : ''}</div>

  <div class="grid g4" style="margin-bottom:16px">
    <div class="kpi"><div class="n">${ps.length}</div><div class="t">Procesos registrados</div></div>
    <div class="kpi"><div class="n">${av}%</div><div class="t">Avance promedio</div>
      <div class="bar" style="margin-top:8px"><i style="width:${av}%"></i></div></div>
    <div class="kpi"><div class="n">${porEstado('aprobado')}</div><div class="t">Aprobados</div></div>
    <div class="kpi"><div class="n">${fotos} / ${audios}</div><div class="t">Fotos / notas de voz</div></div>
  </div>

  <div class="grid g2" style="margin-bottom:16px">
    <div class="card"><h3>Estado del levantamiento</h3>
      ${ESTADOS.map(e => {
        const n = porEstado(e.k), pc = ps.length ? Math.round(n / ps.length * 100) : 0;
        return `<div style="margin-bottom:11px"><div class="flex" style="font-size:13px;margin-bottom:4px">
          <span>${e.n}</span><span class="right mut">${n}</span></div>
          <div class="bar"><i style="width:${pc}%"></i></div></div>`;
      }).join('')}
    </div>
    <div class="card"><h3>Avance por área</h3>
      ${(S.config.areas || []).map(a => {
        const sub = ps.filter(p => p.area === a); if (!sub.length) return '';
        const x = Math.round(sub.reduce((t, p) => t + avance(p), 0) / sub.length);
        return `<div style="margin-bottom:10px"><div class="flex" style="font-size:13px;margin-bottom:4px">
          <span>${esc(a)}</span><span class="right mut">${sub.length} · ${x}%</span></div>
          <div class="bar"><i style="width:${x}%"></i></div></div>`;
      }).join('') || '<div class="mut">Aún no hay procesos asignados a un área.</div>'}
    </div>
  </div>

  <div class="card"><h3>Carga por responsable</h3>
    <div class="tw"><table class="t">
      <thead><tr><th>Persona</th><th>Rol</th><th>Asignados</th><th>Aprobados</th><th style="width:170px">Avance</th></tr></thead>
      <tbody>${S.equipo.map(pe => {
        const sub = ps.filter(p => p.responsable === pe.id);
        const x = sub.length ? Math.round(sub.reduce((t, p) => t + avance(p), 0) / sub.length) : 0;
        return `<tr><td><b>${esc(pe.nombre)}</b></td><td class="mut">${esc(pe.rol)}</td>
          <td>${sub.length}</td><td>${sub.filter(p => p.estado === 'aprobado').length}</td>
          <td><div class="bar"><i style="width:${x}%"></i></div><span class="tiny">${x}%</span></td></tr>`;
      }).join('') || '<tr><td colspan="5" class="mut">Agrega personas en Equipo.</td></tr>'}</tbody>
    </table></div>
  </div>`;
  const b = document.getElementById('nuevoTab'); if (b) b.onclick = modalNuevoProceso;
}

/* ── Lista de procesos ────────────────────────────────────────── */
function vistaProcesos(m) {
  const ps = procesosFiltrados();
  m.innerHTML = `
  <div class="topbar"><h1>Procesos</h1><div class="sp"></div>
    ${puedeEditar() ? '<button class="btn p" id="nuevoP">+ Nuevo proceso</button>' : ''}</div>

  <div class="card" style="margin-bottom:14px">
    <div class="grid g4" style="gap:10px">
      <input type="text" id="fq" placeholder="Buscar por nombre o código…" value="${esc(S.filtros.q)}">
      <select id="fa"><option value="">Todas las áreas</option>${(S.config.areas || []).map(a => `<option ${S.filtros.area === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
      <select id="fe"><option value="">Todos los estados</option>${ESTADOS.map(e => `<option value="${e.k}" ${S.filtros.estado === e.k ? 'selected' : ''}>${e.n}</option>`).join('')}</select>
      <select id="fr"><option value="">Todos los responsables</option>${S.equipo.map(p => `<option value="${p.id}" ${S.filtros.resp === p.id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select>
    </div>
  </div>

  <div class="card"><div class="tw"><table class="t">
    <thead><tr><th style="width:78px">Código</th><th>Proceso</th><th>Área</th><th>Responsable</th><th>Estado</th><th style="width:130px">Avance</th><th style="width:82px">Evidencia</th></tr></thead>
    <tbody>${ps.map(p => {
      const av = avance(p), ev = p.evidencias || [];
      return `<tr data-id="${p.id}" style="cursor:pointer">
        <td class="mut">${esc(p.codigo || '—')}</td>
        <td><b>${esc(p.nombre)}</b></td>
        <td class="mut">${esc(p.area || '—')}</td>
        <td class="mut">${esc(nombrePersona(p.responsable))}</td>
        <td><span class="pill ${p.estado || 'pendiente'}">${(ESTADOS.find(e => e.k === p.estado) || ESTADOS[0]).n}</span></td>
        <td><div class="bar"><i style="width:${av}%"></i></div><span class="tiny">${av}%</span></td>
        <td class="tiny">📷 ${ev.filter(e => e.tipo === 'foto').length} · 🎙 ${ev.filter(e => e.tipo === 'audio').length}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7"><div class="empty"><span class="e">▤</span>No hay procesos todavía.</div></td></tr>'}
    </tbody></table></div></div>`;

  const nb = document.getElementById('nuevoP'); if (nb) nb.onclick = modalNuevoProceso;
  [['fq', 'q'], ['fa', 'area'], ['fe', 'estado'], ['fr', 'resp']].forEach(([id, k]) => {
    const el = document.getElementById(id);
    el.oninput = el.onchange = () => { S.filtros[k] = el.value; vistaProcesos(m); };
  });
  m.querySelectorAll('tbody tr[data-id]').forEach(tr => tr.onclick = () => abrirProceso(tr.dataset.id));
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
          responsable: esAdmin() ? (box.querySelector('#mResp').value || null) : null
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
function abrirProceso(id) {
  const p = S.procesos.find(x => x.id === id); if (!p) return;
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
    ${ro ? '' : '<button class="btn sm" id="btnQR">📱 Celular</button>'}
    ${ro ? '' : `<button class="btn sm p" id="btnEnviar">${p.enviosTotal ? '↻ Reenviar' : '✈ Enviar'}</button>`}
    ${ro ? '' : '<button class="btn sm danger" id="btnBorrar">Eliminar</button>'}
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
    ${p.enviosTotal ? `<div class="aviso-env tiny" style="margin-top:12px;padding:8px 12px;border-radius:8px;background:color-mix(in srgb,var(--ok) 12%,transparent)">
      ✓ Enviado ${p.enviosTotal} ${p.enviosTotal === 1 ? 'vez' : 'veces'}. Puedes seguir editando y subiendo; al reenviar se actualiza el informe con el mismo enlace.
    </div>` : ''}
    <div style="margin-top:14px" class="flex"><span class="tiny">Avance</span>
      <div class="bar" style="flex:1"><i id="avBar" style="width:${av}%"></i></div>
      <span class="tiny" id="avTxt">${av}%</span></div>
  </div>
  <div id="secciones"></div>`;

  const bGuardar = document.getElementById('btnGuardar');
  if (bGuardar) bGuardar.onclick = () => guardarAhora(false);

  document.getElementById('volver').onclick = async () => {
    if (S.dirty && puedeEditar()) {
      const ok = await guardarAhora(true);
      if (!ok && !confirm('No se pudo guardar en el servidor. Los cambios quedaron respaldados en este equipo. ¿Salir de todos modos?')) return;
    }
    S.vista = 'procesos'; S.procId = null; S.draft = null; render();
  };

  pintarEstadoGuardado(S.dirty ? 'escribiendo' : 'guardado');
  const be = document.getElementById('btnEnviar');
  if (be) be.onclick = () => enviarProceso(p);

  const bq = document.getElementById('btnQR');
  if (bq) bq.onclick = () => modalQR(p, '');

  const bb = document.getElementById('btnBorrar');
  if (bb) bb.onclick = () => modal(
    `<h3>Eliminar proceso</h3><p>Se borrará <b>${esc(p.nombre)}</b> con sus respuestas, fotos y audios. No se puede deshacer.</p>
     <div class="flex"><button class="btn" data-cerrar>Cancelar</button>
     <button class="btn p right" id="okDel" style="background:var(--bad);border-color:var(--bad)">Eliminar</button></div>`,
    b => b.querySelector('#okDel').onclick = async () => {
      await api('/procesos/' + p.id, { method: 'DELETE' });
      S.procesos = S.procesos.filter(x => x.id !== p.id);
      cerrarModal(); S.vista = 'procesos'; S.draft = null; render(); toast('Proceso eliminado');
    });

  if (!ro) [['pNombre', 'nombre'], ['pCod', 'codigo'], ['pArea', 'area'],
            ['pResp', 'responsable'], ['pEstado', 'estado']].forEach(([id, campo]) => {
    const el = document.getElementById(id);
    el.oninput = el.onchange = () => { p[campo] = el.value; guardarDebounce(); };
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
        <button class="btn" id="antes" ${S.idx === 0 ? 'disabled' : ''}>← Anterior</button>
        <span class="tiny" style="flex:1;text-align:center">
          ${c.obligatorio ? 'Esta pregunta es obligatoria' : 'Puede dejarla en blanco y seguir'}
        </span>
        ${ultima
          ? (ro ? '' : '<button class="btn p" id="finalizar">✈ Enviar el proceso</button>')
          : '<button class="btn p" id="despues">Siguiente →</button>'}
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
      <div class="rowlist" data-pasos="${c.id}">
        ${rows.map((r, i) => pasoHTML(r, i, ro, c.id)).join('')}
      </div>
      ${ro ? '' : `<button class="btn sm" data-addpaso="${c.id}" style="margin-top:10px">+ Agregar otra actividad</button>`}`;
  }

  return `<div class="f" data-wrap="${c.id}">
    ${grande ? '' : `<span class="lbl">${esc(c.etiqueta)}${c.obligatorio ? '<span class="req">*</span>' : ''}</span>`}
    ${ctrl}
    ${ro ? '' : `<div class="ftools">
      <button class="btn sm" data-mic="${c.id}" title="Grabar lo que le respondan">🎙 Grabar</button>
      <button class="btn sm" data-cam="${c.id}" title="Tomar foto">📷 Foto</button>
      <button class="btn sm ic" data-file="${c.id}" title="Subir una imagen">🖼</button>
      <button class="btn sm ic" data-qr="${c.id}" title="Capturar desde el celular en esta pregunta">📱</button>
      <span class="rec-slot" data-recslot="${c.id}"></span></div>`}
    <div class="ev" data-ev="${c.id}"></div>
  </div>`;
}

/** Nombres que se ofrecen como sugerencia en la columna Responsable. */
function sugerenciasResponsable() {
  const nombres = S.equipo.map(x => x.nombre);
  const roles = ['Admisionista', 'Enfermera', 'Médico', 'Auxiliar', 'Facturación',
                 'Coordinadora', 'Paciente', 'Acompañante', 'Portería', 'Laboratorio'];
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

/** Una actividad. Se puede abrir para explicar cómo se hace y desglosarla. */
function pasoHTML(r, i, ro, cid) {
  const subs = Array.isArray(r.subtareas) ? r.subtareas : [];
  const hayDetalle = (r.detalle || '').trim() || subs.length;
  const abierto = S.pasoAbierto === cid + '-' + i;

  return `<div class="actividad ${abierto ? 'abierta' : ''}" data-i="${i}">
    <div class="act-fila">
      <span class="num">${i + 1}</span>
      <input type="text" data-k="actividad" value="${esc(r.actividad || '')}" placeholder="¿Qué hace en este paso?" ${ro}>
      <input type="text" data-k="responsable" value="${esc(r.responsable || '')}"
        placeholder="¿Quién?" list="sug-resp" ${ro}>
      <input type="text" data-k="sistema" value="${esc(r.sistema || '')}"
        placeholder="¿Dónde lo registra?" list="sug-sist" ${ro}>
      <input type="text" data-k="tiempo" value="${esc(r.tiempo || '')}" placeholder="¿Cuánto tarda?" ${ro}>
      <button class="btn sm ic ${hayDetalle ? 'con-detalle' : ''}" data-abrir="${cid}-${i}"
        title="Explicar este paso en detalle">${abierto ? '▾' : (hayDetalle ? '⋯' : '+')}</button>
      ${ro ? '<span></span>' : `<button class="btn sm ic" data-delpaso="${i}" title="Quitar">×</button>`}
    </div>

    ${abierto ? `<div class="act-detalle">
      <label class="f" style="margin-bottom:12px">
        <span class="lbl">¿Cómo se hace exactamente?</span>
        <span class="hint">Qué datos escribe, qué revisa, qué botón oprime. Lo que le explicaría a alguien nuevo.</span>
        <textarea data-detalle="${i}" placeholder="Ej: En Agilmed entro por Admisiones, busco por cédula. Si no aparece, lo creo con nombre, documento, fecha de nacimiento, EPS y teléfono." ${ro}>${esc(r.detalle || '')}</textarea>
      </label>

      <span class="lbl">Sub-actividades o tareas de este paso</span>
      <span class="hint">Una por línea. Útil cuando el paso tiene varios pedazos.</span>
      <div class="subtareas" data-subs="${i}">
        ${subs.map((t, j) => `<div class="sub">
          <span class="vi">${i + 1}.${j + 1}</span>
          <input type="text" data-sub="${j}" value="${esc(t)}" placeholder="Ej: Verificar que la EPS esté activa" ${ro}>
          ${ro ? '' : `<button class="btn sm ic" data-delsub="${i}-${j}">×</button>`}
        </div>`).join('')}
      </div>
      ${ro ? '' : `<button class="btn sm" data-addsub="${i}" style="margin-top:8px">+ Sub-actividad</button>`}
    </div>` : ''}
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
      if (subs) o.subtareas = [...subs.querySelectorAll('input[data-sub]')].map(x => x.value).filter(x => x.trim());
      return o;
    });

    const aplicar = () => { p.respuestas[cid] = leer(); refrescarAvance(); guardarDebounce(); };

    box.querySelectorAll('input[data-k], [data-detalle], input[data-sub]')
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
      rows[i].subtareas = (rows[i].subtareas || []).concat(['']);
      p.respuestas[cid] = rows; guardarDebounce(); pintarSecciones();
    });

    box.querySelectorAll('[data-delsub]').forEach(b => b.onclick = () => {
      const [i, j] = b.dataset.delsub.split('-').map(Number);
      const rows = leer();
      rows[i].subtareas = (rows[i].subtareas || []).filter((_, k) => k !== j);
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
async function toggleGrabacion(campo) {
  if (S.rec) { detenerGrabacion(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Este navegador no permite grabar'); return; }

  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (_) { toast('Sin permiso de micrófono'); return; }

  let mime = 'audio/webm', ext = 'webm';
  if (window.MediaRecorder.isTypeSupported && !MediaRecorder.isTypeSupported('audio/webm')) {
    if (MediaRecorder.isTypeSupported('audio/mp4')) { mime = 'audio/mp4'; ext = 'm4a'; }
    else { mime = ''; ext = 'm4a'; }
  }
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const trozos = [];
  mr.ondataavailable = e => { if (e.data.size) trozos.push(e.data); };
  mr.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    const tipoReal = mr.mimeType ? mr.mimeType.split(';')[0] : (mime || 'audio/mp4');
    await subirEvidencia(campo, 'audio', new Blob(trozos, { type: tipoReal }), 'nota.' + ext, S.recT);
  };
  mr.start();
  S.rec = mr; S.recCampo = campo; S.recT = 0;

  const slot = document.querySelector(`[data-recslot="${campo}"]`);
  if (slot) slot.innerHTML = '<span class="rec"><span class="blink"></span><span id="recTime">0:00</span> · toca 🎙 para detener</span>';
  S.recTimer = setInterval(() => {
    S.recT++;
    const t = document.getElementById('recTime');
    if (t) t.textContent = Math.floor(S.recT / 60) + ':' + String(S.recT % 60).padStart(2, '0');
    if (S.recT >= 600) detenerGrabacion();
  }, 1000);
}

function detenerGrabacion() {
  if (!S.rec) return;
  try { S.rec.stop(); } catch (_) {}
  clearInterval(S.recTimer);
  const slot = document.querySelector(`[data-recslot="${S.recCampo}"]`);
  if (slot) slot.innerHTML = '';
  S.rec = null; S.recCampo = null;
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
  <div class="banner">Cada persona entra con su usuario desde computador o celular. Roles: <b>admin</b> configura todo · <b>analista</b> levanta procesos · <b>lector</b> solo consulta y exporta.</div>
  <div class="card"><div class="tw"><table class="t">
    <thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Contacto</th><th>Procesos</th>${esAdmin() ? '<th style="width:90px"></th>' : ''}</tr></thead>
    <tbody>${S.equipo.map(p => {
      const n = S.procesos.filter(x => x.responsable === p.id).length;
      return `<tr><td><b>${esc(p.nombre)}</b></td><td class="mut">${esc(p.usuario)}</td>
        <td><span class="chip">${esc(p.rol)}</span></td><td class="mut">${esc(p.contacto || '—')}</td><td>${n}</td>
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
        ${['admin', 'analista', 'lector'].map(r => `<option value="${r}" ${ed && p.rol === r ? 'selected' : (!ed && r === 'analista' ? 'selected' : '')}>${r}</option>`).join('')}</select></label>
      <label class="f"><span class="lbl">Contacto</span><input type="text" id="eCon" value="${esc(ed ? p.contacto || '' : '')}"></label>
    </div>
    <label class="f"><span class="lbl">${ed ? 'Nueva contraseña (opcional)' : 'Contraseña'} ${ed ? '' : '<span class="req">*</span>'}</span>
      <input type="password" id="ePwd" autocomplete="new-password" placeholder="Mínimo 8 caracteres"></label>
    <div class="flex"><button class="btn" data-cerrar>Cancelar</button><button class="btn p right" id="eOk">Guardar</button></div>`,
  box => {
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
    const i = S.procesos.findIndex(x => x.id === p.id);
    if (i >= 0) { S.procesos[i].estado = 'en_revision'; S.procesos[i].enviosTotal = d.numero; }
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
function vistaAsignacion(m) {
  const sinAsignar = S.procesos.filter(p => !p.responsable);
  const activos = S.equipo.filter(u => u.rol !== 'lector');

  const tarjeta = (pe) => {
    const mios = S.procesos.filter(p => p.responsable === pe.id);
    const av = mios.length ? Math.round(mios.reduce((t, p) => t + avance(p), 0) / mios.length) : 0;
    const enviados = mios.filter(p => p.estado === 'en_revision' || p.estado === 'aprobado').length;
    return `<div class="card" style="margin-bottom:14px">
      <div class="flex" style="margin-bottom:12px">
        <div style="width:34px;height:34px;border-radius:99px;background:var(--surface-2);
          display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--accent)">
          ${esc((pe.nombre || '?').trim()[0].toUpperCase())}</div>
        <div>
          <div style="font-weight:600">${esc(pe.nombre)}</div>
          <div class="tiny">${esc(pe.rol)} · ${mios.length} asignado(s) · ${enviados} enviado(s)</div>
        </div>
        <div class="right" style="text-align:right;min-width:110px">
          <div class="bar"><i style="width:${av}%"></i></div>
          <span class="tiny">${av}% promedio</span>
        </div>
      </div>
      ${mios.length ? `<div class="tw"><table class="t">
        <tbody>${mios.map(p => `<tr>
          <td style="width:70px" class="mut">${esc(p.codigo || '—')}</td>
          <td><a href="#" data-abrir="${p.id}">${esc(p.nombre)}</a>
            <div class="tiny">${esc(p.area || '')}</div></td>
          <td style="width:96px"><span class="pill ${p.estado}">${(ESTADOS.find(e => e.k === p.estado) || ESTADOS[0]).n}</span></td>
          <td style="width:110px"><div class="bar"><i style="width:${avance(p)}%"></i></div></td>
          ${esAdmin() ? `<td style="width:34px"><button class="btn sm ic" data-quitar="${p.id}" title="Quitar asignación">×</button></td>` : ''}
        </tr>`).join('')}</tbody></table></div>`
        : '<div class="mut" style="padding:6px 0">Sin procesos asignados.</div>'}
      ${esAdmin() && sinAsignar.length ? `<div class="flex" style="margin-top:12px;gap:8px">
        <select data-sel="${pe.id}" style="flex:1">
          <option value="">Asignar un proceso pendiente…</option>
          ${sinAsignar.map(p => `<option value="${p.id}">${esc(p.codigo || '')} ${esc(p.nombre)}</option>`).join('')}
        </select>
        <button class="btn sm" data-asig="${pe.id}">Asignar</button>
      </div>` : ''}
    </div>`;
  };

  m.innerHTML = `
  <div class="topbar"><h1>Asignación</h1><div class="sp"></div>
    <span class="tiny">${sinAsignar.length} sin responsable</span></div>
  ${esAdmin() ? '' : '<div class="banner">Solo el administrador reparte los procesos. Aquí puedes ver cómo va el equipo.</div>'}

  ${sinAsignar.length ? `<div class="card" style="margin-bottom:18px;border-color:color-mix(in srgb,var(--warn) 40%,transparent)">
    <h3>Sin responsable (${sinAsignar.length})</h3>
    <div class="flex wrap" style="gap:7px">
      ${sinAsignar.map(p => `<span class="chip">${esc(p.codigo || '')} ${esc(p.nombre)}</span>`).join('')}
    </div>
    <div class="tiny" style="margin-top:10px">Asígnalos desde la tarjeta de cada persona.</div>
  </div>` : ''}

  <div class="grid g2" style="align-items:start">
    <div>${activos.filter((_, i) => i % 2 === 0).map(tarjeta).join('')}</div>
    <div>${activos.filter((_, i) => i % 2 === 1).map(tarjeta).join('')}</div>
  </div>
  ${activos.length ? '' : '<div class="empty"><span class="e">👥</span>Agrega personas en Equipo para poder asignar.</div>'}`;

  m.querySelectorAll('[data-abrir]').forEach(a => a.onclick = e => {
    e.preventDefault(); abrirProceso(a.dataset.abrir);
  });
  m.querySelectorAll('[data-asig]').forEach(b => b.onclick = async () => {
    const sel = m.querySelector(`[data-sel="${b.dataset.asig}"]`);
    if (!sel.value) { toast('Elige un proceso'); return; }
    await asignar(sel.value, b.dataset.asig);
    vistaAsignacion(m);
  });
  m.querySelectorAll('[data-quitar]').forEach(b => b.onclick = async () => {
    await asignar(b.dataset.quitar, null);
    vistaAsignacion(m);
  });
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
