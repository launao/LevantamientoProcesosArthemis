"""
api.py — API REST.

Todas las rutas cuelgan de /api salvo /media/<id>, que sirve fotos y audios.
"""
import csv
import hashlib
import io
import os
import secrets
import uuid
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request, send_file, Response

import db as D
from sanitizar import limpiar_respuestas, a_texto_plano
from auth import (usuario_actual, iniciar_sesion, cerrar_sesion, login_required,
                  puede_editar, rol_required, hash_password, verify_password,
                  validar_password, login_permitido, registrar_fallo,
                  limpiar_intentos, auditar, ROLES)

api = Blueprint("api", __name__)

# Las claves del flujo son fijas; las etiquetas se configuran.
ESTADOS_BASE = [
    {"k": "pendiente", "n": "Borrador"},
    {"k": "en_curso", "n": "En curso"},
    {"k": "en_revision", "n": "Enviado"},
    {"k": "aprobado", "n": "Aprobado"},
]

MEDIA_DIR = os.environ.get("MEDIA_DIR", "").strip()   # si está, se guarda en disco
TIPOS_OK = {
    "image/jpeg", "image/png", "image/webp", "image/gif",
    "image/heic", "image/heif",
    "audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav",
    "video/webm", "video/mp4", "application/pdf",
}
MAX_MEDIA = int(os.environ.get("MAX_MEDIA_MB", "25")) * 1024 * 1024


def _now():
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _nuevo_id(pref=""):
    return pref + uuid.uuid4().hex[:16]


def _bool(v):
    return True if D.USE_PG else 1


# ═══════════════════════════════════════════════════════════════════════════
# Sesión
# ═══════════════════════════════════════════════════════════════════════════

@api.post("/login")
def login():
    ip = request.headers.get("X-Forwarded-For", request.remote_addr) or "?"
    if not login_permitido(ip):
        return jsonify({"error": "demasiados_intentos"}), 429

    d = request.get_json(silent=True) or {}
    usuario = (d.get("usuario") or "").strip().lower()
    clave = d.get("password") or ""

    u = D.row("SELECT * FROM usuarios WHERE LOWER(usuario)=? AND activo", (usuario,))
    if not u or not verify_password(clave, u["password_hash"]):
        registrar_fallo(ip)
        return jsonify({"error": "credenciales"}), 401

    limpiar_intentos(ip)
    iniciar_sesion(u)
    auditar("login", "usuario", u["id"])
    return jsonify({"ok": True, "usuario": {
        "id": u["id"], "usuario": u["usuario"], "nombre": u["nombre"], "rol": u["rol"]}})


@api.post("/logout")
def logout():
    auditar("logout")
    cerrar_sesion()
    return jsonify({"ok": True})


@api.get("/me")
def me():
    u = usuario_actual()
    if not u:
        return jsonify({"autenticado": False}), 200
    return jsonify({"autenticado": True, "usuario": u})


@api.post("/me/password")
@login_required
def cambiar_password():
    u = usuario_actual()
    d = request.get_json(silent=True) or {}
    actual = d.get("actual") or ""
    nueva = d.get("nueva") or ""

    fila = D.row("SELECT password_hash FROM usuarios WHERE id=?", (u["id"],))
    if not verify_password(actual, fila["password_hash"]):
        return jsonify({"error": "password_actual_incorrecta"}), 400
    err = validar_password(nueva)
    if err:
        return jsonify({"error": err}), 400

    D.execute("UPDATE usuarios SET password_hash=? WHERE id=?", (hash_password(nueva), u["id"]))
    auditar("cambio_password", "usuario", u["id"])
    return jsonify({"ok": True})


# ═══════════════════════════════════════════════════════════════════════════
# Carga inicial
# ═══════════════════════════════════════════════════════════════════════════

@api.get("/bootstrap")
@login_required
def bootstrap():
    return jsonify({
        "usuario": usuario_actual(),
        "config": D.jload(D.row("SELECT data FROM config WHERE id=1")["data"], {}),
        "plantilla": D.jload(D.row("SELECT data FROM plantilla WHERE id=1")["data"], {}),
        "equipo": _equipo(),
        "procesos": _procesos(),
    })


def _equipo():
    return D.rows(
        "SELECT id, usuario, nombre, rol, contacto FROM usuarios "
        "WHERE activo ORDER BY nombre")


def _procesos():
    ps = D.rows("SELECT * FROM procesos ORDER BY codigo, nombre")
    evs = D.rows("SELECT * FROM evidencias ORDER BY creado")
    por_proc = {}
    for e in evs:
        por_proc.setdefault(e["proceso_id"], []).append({
            "id": e["id"], "campo": e["campo_id"], "tipo": e["tipo"],
            "mediaId": e["media_id"], "nota": e["nota"],
            "duracion": e.get("duracion") or 0, "origen": e.get("origen") or "app",
            "autor": e["autor_id"], "fecha": str(e["creado"]),
        })
    salida = []
    for p in ps:
        salida.append({
            "id": p["id"], "codigo": p["codigo"], "nombre": p["nombre"],
            "area": p["area"], "responsable": p["responsable_id"],
            "estado": p["estado"], "prioridad": p["prioridad"], "notas": p["notas"],
            "respuestas": D.jload(p["respuestas"], {}),
            "enviadoEn": str(p.get("enviado_en") or ""),
            "enviadoPor": p.get("enviado_por") or "",
            "enviosTotal": p.get("envios_total") or 0,
            "creado": str(p["creado"]), "actualizado": str(p["actualizado"]),
            "evidencias": por_proc.get(p["id"], []),
        })
    return salida


@api.get("/procesos")
@login_required
def listar_procesos():
    return jsonify({"procesos": _procesos()})


# ═══════════════════════════════════════════════════════════════════════════
# Configuración y plantilla
# ═══════════════════════════════════════════════════════════════════════════

@api.put("/config")
@rol_required("admin")
def guardar_config():
    d = request.get_json(silent=True) or {}
    actual = D.jload(D.row("SELECT data FROM config WHERE id=1")["data"], {})
    actual.update({
        "proyecto": (d.get("proyecto") or actual.get("proyecto") or "Levantamiento de Procesos").strip(),
        "organizacion": (d.get("organizacion") or "").strip(),
        "areas": [a.strip() for a in (d.get("areas") or actual.get("areas") or []) if a.strip()],
    })

    # Etiquetas de los estados. Las claves son fijas (el flujo depende de
    # ellas); lo que se puede cambiar es cómo se llaman en pantalla.
    if isinstance(d.get("estados"), list):
        validos = {e["k"] for e in ESTADOS_BASE}
        estados = []
        for e in d["estados"]:
            if isinstance(e, dict) and e.get("k") in validos and (e.get("n") or "").strip():
                estados.append({"k": e["k"], "n": e["n"].strip()[:40]})
        if len(estados) == len(validos):
            actual["estados"] = estados

    # Catálogos reutilizables: una lista con nombre que varios campos pueden usar.
    if isinstance(d.get("catalogos"), list):
        cats = []
        for c in d["catalogos"][:40]:
            if not isinstance(c, dict):
                continue
            nombre = (c.get("nombre") or "").strip()[:60]
            if not nombre:
                continue
            cats.append({
                "id": (c.get("id") or "").strip() or ("cat_" + uuid.uuid4().hex[:6]),
                "nombre": nombre,
                "opciones": [o.strip() for o in (c.get("opciones") or []) if str(o).strip()][:100],
            })
        actual["catalogos"] = cats
    D.execute("UPDATE config SET data=? WHERE id=1", (D.jdump(actual),))
    auditar("config_actualizada", "config", "1")
    return jsonify({"ok": True, "config": actual})


@api.put("/plantilla")
@rol_required("admin")
def guardar_plantilla():
    d = request.get_json(silent=True) or {}
    secciones = d.get("secciones")
    if not isinstance(secciones, list):
        return jsonify({"error": "formato_invalido"}), 400

    fila = D.row("SELECT version FROM plantilla WHERE id=1")
    version = (fila["version"] or 1) + 1
    D.execute("UPDATE plantilla SET data=?, version=? WHERE id=1",
              (D.jdump({"secciones": secciones}), version))
    auditar("plantilla_actualizada", "plantilla", "1", f"v{version}")
    return jsonify({"ok": True, "version": version})


# ═══════════════════════════════════════════════════════════════════════════
# Equipo
# ═══════════════════════════════════════════════════════════════════════════

@api.get("/usuarios")
@login_required
def listar_usuarios():
    return jsonify({"equipo": _equipo()})


@api.post("/usuarios")
@rol_required("admin")
def crear_usuario():
    d = request.get_json(silent=True) or {}
    nombre = (d.get("nombre") or "").strip()
    usuario = (d.get("usuario") or "").strip().lower()
    clave = d.get("password") or ""
    rol = d.get("rol") if d.get("rol") in ROLES else "analista"

    if not nombre or not usuario:
        return jsonify({"error": "nombre_y_usuario_requeridos"}), 400
    err = validar_password(clave)
    if err:
        return jsonify({"error": err}), 400
    if D.row("SELECT id FROM usuarios WHERE LOWER(usuario)=?", (usuario,)):
        return jsonify({"error": "usuario_ya_existe"}), 409

    uid = str(uuid.uuid4())
    D.execute(
        "INSERT INTO usuarios (id, usuario, nombre, rol, contacto, password_hash, activo) "
        "VALUES (?,?,?,?,?,?,?)",
        (uid, usuario, nombre, rol, (d.get("contacto") or "").strip(),
         hash_password(clave), _bool(True)))
    auditar("usuario_creado", "usuario", uid, nombre)
    return jsonify({"ok": True, "id": uid})


@api.put("/usuarios/<uid>")
@rol_required("admin")
def editar_usuario(uid):
    d = request.get_json(silent=True) or {}
    u = D.row("SELECT id FROM usuarios WHERE id=?", (uid,))
    if not u:
        return jsonify({"error": "no_existe"}), 404

    campos, params = [], []
    for k, col in (("nombre", "nombre"), ("contacto", "contacto")):
        if k in d:
            campos.append(f"{col}=?")
            params.append((d[k] or "").strip())
    if d.get("rol") in ROLES:
        campos.append("rol=?")
        params.append(d["rol"])
    if d.get("password"):
        err = validar_password(d["password"])
        if err:
            return jsonify({"error": err}), 400
        campos.append("password_hash=?")
        params.append(hash_password(d["password"]))
    if not campos:
        return jsonify({"ok": True})

    params.append(uid)
    D.execute(f"UPDATE usuarios SET {', '.join(campos)} WHERE id=?", tuple(params))
    auditar("usuario_editado", "usuario", uid)
    return jsonify({"ok": True})


@api.delete("/usuarios/<uid>")
@rol_required("admin")
def desactivar_usuario(uid):
    yo = usuario_actual()
    if yo["id"] == uid:
        return jsonify({"error": "no_puedes_desactivarte"}), 400
    D.execute("UPDATE usuarios SET activo=? WHERE id=?", (False if D.USE_PG else 0, uid))
    auditar("usuario_desactivado", "usuario", uid)
    return jsonify({"ok": True})


# ═══════════════════════════════════════════════════════════════════════════
# Procesos
# ═══════════════════════════════════════════════════════════════════════════

def _mio(p, u):
    """Un analista solo trabaja sobre lo suyo. El admin, sobre todo."""
    if u["rol"] == "admin":
        return True
    return (p.get("responsable_id") or "") == u["id"]


@api.post("/procesos")
@puede_editar
def crear_proceso():
    d = request.get_json(silent=True) or {}
    nombre = (d.get("nombre") or "").strip()
    if not nombre:
        return jsonify({"error": "nombre_requerido"}), 400

    u = usuario_actual()
    # Solo el administrador decide de quién es un proceso. Cualquier otro
    # crea a nombre propio, aunque mande otra cosa.
    responsable = d.get("responsable") or None if u["rol"] == "admin" else u["id"]

    pid = _nuevo_id("p_")
    D.execute(
        "INSERT INTO procesos (id, codigo, nombre, area, responsable_id, estado, "
        "notas, respuestas, creado_por, actualizado_por) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (pid, (d.get("codigo") or "").strip(), nombre, (d.get("area") or "").strip(),
         responsable, d.get("estado") or "pendiente",
         (d.get("notas") or "").strip(),
         D.jdump(limpiar_respuestas(d.get("respuestas") or {})),
         u["id"], u["id"]))
    auditar("proceso_creado", "proceso", pid, nombre)
    return jsonify({"ok": True, "id": pid})


@api.put("/procesos/<pid>")
@puede_editar
def actualizar_proceso(pid):
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404

    d = request.get_json(silent=True) or {}
    u = usuario_actual()
    if not _mio(p, u):
        return jsonify({"error": "no_es_tuyo"}), 403
    mapa = {"codigo": "codigo", "nombre": "nombre", "area": "area",
            "estado": "estado", "prioridad": "prioridad", "notas": "notas"}
    campos, params = [], []
    for k, col in mapa.items():
        if k in d:
            campos.append(f"{col}=?")
            params.append(d[k])
    # Reasignar es potestad del administrador; a los demás se les ignora.
    if "responsable" in d and u["rol"] == "admin":
        campos.append("responsable_id=?")
        params.append(d["responsable"] or None)
    if "respuestas" in d:
        campos.append("respuestas=?")
        params.append(D.jdump(limpiar_respuestas(d["respuestas"] or {})))

    campos.append("actualizado_por=?")
    params.append(u["id"])

    sql = (f"UPDATE procesos SET {', '.join(campos)}, "
           f"actualizado={D.NOW} WHERE id=?")
    D.execute(sql, tuple(params) + (pid,))
    return jsonify({"ok": True})


@api.delete("/procesos/<pid>")
@puede_editar
def borrar_proceso(pid):
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404
    if not _mio(p, usuario_actual()):
        return jsonify({"error": "no_es_tuyo"}), 403
    medias = D.rows("SELECT media_id FROM evidencias WHERE proceso_id=?", (pid,))
    for m in medias:
        _borrar_media(m["media_id"])
    D.execute("DELETE FROM evidencias WHERE proceso_id=?", (pid,))
    D.execute("DELETE FROM procesos WHERE id=?", (pid,))
    auditar("proceso_eliminado", "proceso", pid)
    return jsonify({"ok": True})


# ═══════════════════════════════════════════════════════════════════════════
# Evidencias (fotos y audios)
# ═══════════════════════════════════════════════════════════════════════════

def _guardar_evidencia(pid, archivo, form, autor_id, origen="app"):
    """Núcleo compartido por la app y por la página de captura del celular.

    Devuelve (payload, codigo_http).
    """
    datos = archivo.read()
    if not datos:
        return {"error": "archivo_vacio"}, 400
    if len(datos) > MAX_MEDIA:
        return {"error": "archivo_muy_grande", "max_mb": MAX_MEDIA // (1024 * 1024)}, 413

    ctype = (archivo.mimetype or "application/octet-stream").split(";")[0].strip()
    if ctype not in TIPOS_OK:
        return {"error": "tipo_no_permitido", "tipo": ctype}, 415

    tipo = form.get("tipo") or ("foto" if ctype.startswith("image/") else "audio")
    campo = form.get("campo") or ""
    nota = (form.get("nota") or "")[:2000]
    try:
        duracion = int(float(form.get("duracion") or 0))
    except (TypeError, ValueError):
        duracion = 0

    # Deduplicación: si el mismo archivo ya entró en este proceso y campo, no se
    # duplica. Esto hace que reintentar una subida sea seguro.
    firma = hashlib.sha1(datos).hexdigest()
    previo = D.row(
        "SELECT e.id, e.media_id FROM evidencias e JOIN media m ON m.id = e.media_id "
        "WHERE m.sha1=? AND e.proceso_id=? AND e.campo_id=?", (firma, pid, campo))
    if previo:
        return {"ok": True, "duplicado": True, "evidencia": {
            "id": previo["id"], "campo": campo, "tipo": tipo,
            "mediaId": previo["media_id"], "nota": nota, "duracion": duracion,
            "autor": autor_id, "fecha": _now()}}, 200

    mid = _nuevo_id("m_")
    if MEDIA_DIR:
        os.makedirs(MEDIA_DIR, exist_ok=True)
        ruta = os.path.join(MEDIA_DIR, mid)
        with open(ruta, "wb") as fh:
            fh.write(datos)
        D.execute(
            "INSERT INTO media (id, proceso_id, content_type, tamano, nombre, ruta, sha1) "
            "VALUES (?,?,?,?,?,?,?)",
            (mid, pid, ctype, len(datos), archivo.filename or "", ruta, firma))
    else:
        D.execute(
            "INSERT INTO media (id, proceso_id, content_type, tamano, nombre, data, sha1) "
            "VALUES (?,?,?,?,?,?,?)",
            (mid, pid, ctype, len(datos), archivo.filename or "", D.binary(datos), firma))

    eid = _nuevo_id("e_")
    D.execute(
        "INSERT INTO evidencias (id, proceso_id, campo_id, tipo, media_id, nota, "
        "autor_id, duracion, origen) VALUES (?,?,?,?,?,?,?,?,?)",
        (eid, pid, campo, tipo, mid, nota, autor_id, duracion, origen))

    return {"ok": True, "evidencia": {
        "id": eid, "campo": campo, "tipo": tipo, "mediaId": mid, "nota": nota,
        "duracion": duracion, "autor": autor_id, "origen": origen,
        "fecha": _now()}}, 200


@api.post("/procesos/<pid>/evidencias")
@puede_editar
def subir_evidencia(pid):
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404
    if not _mio(p, usuario_actual()):
        return jsonify({"error": "no_es_tuyo"}), 403
    f = request.files.get("archivo")
    if not f:
        return jsonify({"error": "sin_archivo"}), 400

    u = usuario_actual()
    payload, code = _guardar_evidencia(pid, f, request.form, u["id"], "app")
    if code == 200 and not payload.get("duplicado"):
        auditar("evidencia_subida", "proceso", pid, payload["evidencia"]["tipo"])
    return jsonify(payload), code


@api.put("/evidencias/<eid>")
@puede_editar
def mover_evidencia(eid):
    """Reubica una foto o un audio en la pregunta a la que pertenece."""
    ev = D.row("SELECT * FROM evidencias WHERE id=?", (eid,))
    if not ev:
        return jsonify({"error": "no_existe"}), 404
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (ev["proceso_id"],))
    if not p or not _mio(p, usuario_actual()):
        return jsonify({"error": "no_es_tuyo"}), 403

    d = request.get_json(silent=True) or {}
    campos, params = [], []
    if "campo" in d:
        campos.append("campo_id=?")
        params.append(d["campo"] or "")
    if "nota" in d:
        campos.append("nota=?")
        params.append((d["nota"] or "")[:2000])
    if not campos:
        return jsonify({"ok": True})

    params.append(eid)
    D.execute(f"UPDATE evidencias SET {', '.join(campos)} WHERE id=?", tuple(params))
    auditar("evidencia_movida", "proceso", ev["proceso_id"], d.get("campo"))
    return jsonify({"ok": True})


@api.delete("/evidencias/<eid>")
@puede_editar
def borrar_evidencia(eid):
    ev = D.row("SELECT * FROM evidencias WHERE id=?", (eid,))
    if not ev:
        return jsonify({"error": "no_existe"}), 404
    _borrar_media(ev["media_id"])
    D.execute("DELETE FROM evidencias WHERE id=?", (eid,))
    auditar("evidencia_eliminada", "proceso", ev["proceso_id"])
    return jsonify({"ok": True})


# ═══════════════════════════════════════════════════════════════════════════
# Captura desde el celular (enlace + QR, sin necesidad de iniciar sesión)
# ═══════════════════════════════════════════════════════════════════════════

HORAS_TOKEN = int(os.environ.get("CAPTURE_HORAS", "12"))


def _token_valido(token):
    t = D.row("SELECT * FROM capture_tokens WHERE token=? AND activo", (token,))
    if not t:
        return None
    try:
        expira = datetime.fromisoformat(str(t["expira"]).replace("Z", ""))
    except ValueError:
        return None
    if expira < datetime.utcnow():
        return None
    return t


@api.post("/procesos/<pid>/capture-link")
@puede_editar
def crear_capture_link(pid):
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404
    if not _mio(p, usuario_actual()):
        return jsonify({"error": "no_es_tuyo"}), 403

    d = request.get_json(silent=True) or {}
    campo = d.get("campo") or ""
    u = usuario_actual()

    # Un enlace vigente por proceso+campo: si se pide otra vez, se reemplaza.
    D.execute("UPDATE capture_tokens SET activo=? WHERE proceso_id=? AND campo_id=?",
              (False if D.USE_PG else 0, pid, campo))

    token = secrets.token_urlsafe(24)
    expira = (datetime.utcnow() + timedelta(hours=HORAS_TOKEN)).isoformat(timespec="seconds")
    D.execute(
        "INSERT INTO capture_tokens (token, proceso_id, campo_id, creado_por, expira, activo) "
        "VALUES (?,?,?,?,?,?)",
        (token, pid, campo, u["id"], expira, True if D.USE_PG else 1))
    auditar("capture_link_creado", "proceso", pid, campo)

    url = request.host_url.rstrip("/") + "/c/" + token
    return jsonify({"ok": True, "token": token, "url": url,
                    "expira": expira + "Z", "horas": HORAS_TOKEN,
                    "qr": _qr_svg(url)})


def _qr_svg(texto):
    """QR en SVG generado en el servidor: sin librerías externas en el navegador."""
    try:
        import segno
        buf = io.BytesIO()
        segno.make(texto, error="m").save(buf, kind="svg", scale=5, border=2,
                                          dark="#112236", light="#ffffff")
        return buf.getvalue().decode("utf-8")
    except Exception as e:
        print("[qr] no disponible:", e)
        return None


@api.delete("/capture-link/<token>")
@puede_editar
def revocar_capture_link(token):
    D.execute("UPDATE capture_tokens SET activo=? WHERE token=?",
              (False if D.USE_PG else 0, token))
    return jsonify({"ok": True})


@api.get("/capture/<token>")
def capture_info(token):
    t = _token_valido(token)
    if not t:
        return jsonify({"error": "enlace_vencido"}), 410

    p = D.row("SELECT id, codigo, nombre, area FROM procesos WHERE id=?", (t["proceso_id"],))
    if not p:
        return jsonify({"error": "no_existe"}), 404

    plantilla = D.jload(D.row("SELECT data FROM plantilla WHERE id=1")["data"], {})
    campos = [{"id": c["id"], "etiqueta": c["etiqueta"], "seccion": s.get("nombre", "")}
              for s in plantilla.get("secciones", []) for c in s.get("campos", [])]

    evidencias = D.rows(
        "SELECT id, campo_id, tipo, media_id, duracion, nota, creado FROM evidencias "
        "WHERE proceso_id=? ORDER BY creado DESC", (t["proceso_id"],))

    return jsonify({
        "proceso": p,
        "campoFijo": t["campo_id"] or "",
        "campos": campos,
        "expira": str(t["expira"]),
        "evidencias": [{"id": e["id"], "campo": e["campo_id"], "tipo": e["tipo"],
                        "mediaId": e["media_id"], "duracion": e["duracion"],
                        "nota": e["nota"]}
                       for e in evidencias],
    })


@api.post("/capture/<token>/evidencias")
def capture_subir(token):
    t = _token_valido(token)
    if not t:
        return jsonify({"error": "enlace_vencido"}), 410

    f = request.files.get("archivo")
    if not f:
        return jsonify({"error": "sin_archivo"}), 400

    form = request.form.copy()
    if t["campo_id"]:
        form = dict(form)
        form["campo"] = t["campo_id"]

    payload, code = _guardar_evidencia(
        t["proceso_id"], f, form, t["creado_por"], "celular")
    if code == 200 and not payload.get("duplicado"):
        D.execute("UPDATE capture_tokens SET usos = usos + 1 WHERE token=?", (token,))
    return jsonify(payload), code


@api.post("/capture/<token>/nota")
def capture_nota(token):
    """Guarda una nota escrita desde el celular, sin foto ni audio."""
    t = _token_valido(token)
    if not t:
        return jsonify({"error": "enlace_vencido"}), 410

    d = request.get_json(silent=True) or {}
    texto = (d.get("nota") or "").strip()[:4000]
    if not texto:
        return jsonify({"error": "nota_vacia"}), 400

    campo = t["campo_id"] or (d.get("campo") or "")
    eid = _nuevo_id("e_")
    D.execute(
        "INSERT INTO evidencias (id, proceso_id, campo_id, tipo, media_id, nota, "
        "autor_id, duracion, origen) VALUES (?,?,?,?,?,?,?,?,?)",
        (eid, t["proceso_id"], campo, "nota", None, texto, t["creado_por"], 0, "celular"))
    D.execute("UPDATE capture_tokens SET usos = usos + 1 WHERE token=?", (token,))

    return jsonify({"ok": True, "evidencia": {
        "id": eid, "campo": campo, "tipo": "nota", "mediaId": None,
        "nota": texto, "fecha": _now()}})


def capture_media(token, mid):
    """Sirve una foto o audio a la página del celular, sin sesión."""
    t = _token_valido(token)
    if not t:
        return jsonify({"error": "enlace_vencido"}), 410
    m = D.row("SELECT * FROM media WHERE id=? AND proceso_id=?", (mid, t["proceso_id"]))
    if not m:
        return jsonify({"error": "no_existe"}), 404
    return _enviar_media(m)


# ═══════════════════════════════════════════════════════════════════════════
# Envío del proceso e informe compartible
# ═══════════════════════════════════════════════════════════════════════════

def _avance(plantilla, respuestas):
    campos = _campos_planos(plantilla)
    if not campos:
        return 0, []
    obl = [c for c in campos if c.get("obligatorio")]
    base = obl or campos
    faltan = []
    llenos = 0
    for c in base:
        v = respuestas.get(c["id"])
        if c.get("tipo") == "pasos" and isinstance(v, list):
            ok = any(str(r.get("actividad", "")).strip() for r in v)
        elif isinstance(v, list):
            ok = bool(v)
        else:
            ok = v is not None and a_texto_plano(str(v)).strip() != ""
        if ok:
            llenos += 1
        else:
            faltan.append(c["etiqueta"])
    return round(llenos / len(base) * 100), faltan


def _asegurar_share(pid, autor_id):
    t = D.row("SELECT token FROM share_tokens WHERE proceso_id=? AND activo", (pid,))
    if t:
        return t["token"]
    token = secrets.token_urlsafe(20)
    D.execute("INSERT INTO share_tokens (token, proceso_id, creado_por, activo) VALUES (?,?,?,?)",
              (token, pid, autor_id, True if D.USE_PG else 1))
    return token


@api.post("/procesos/<pid>/enviar")
@puede_editar
def enviar_proceso(pid):
    p = D.row("SELECT * FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404

    plantilla = D.jload(D.row("SELECT data FROM plantilla WHERE id=1")["data"], {})
    respuestas = D.jload(p["respuestas"], {})
    avance, faltan = _avance(plantilla, respuestas)

    d = request.get_json(silent=True) or {}
    if faltan and not d.get("forzar"):
        return jsonify({"error": "faltan_obligatorios", "faltan": faltan, "avance": avance}), 422

    u = usuario_actual()
    evs = D.rows("SELECT tipo FROM evidencias WHERE proceso_id=?", (pid,))
    fotos = sum(1 for e in evs if e["tipo"] == "foto")
    audios = sum(1 for e in evs if e["tipo"] == "audio")

    numero = (p.get("envios_total") or 0) + 1
    D.execute(
        "INSERT INTO envios (id, proceso_id, usuario_id, numero, resumen, avance, fotos, audios) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (_nuevo_id("en_"), pid, u["id"], numero, (d.get("resumen") or "")[:1000],
         avance, fotos, audios))

    D.execute(
        f"UPDATE procesos SET estado='en_revision', enviado_en=?, enviado_por=?, "
        f"envios_total=?, actualizado={D.NOW} WHERE id=?",
        (_now(), u["id"], numero, pid))

    token = _asegurar_share(pid, u["id"])
    url = request.host_url.rstrip("/") + "/r/" + token
    auditar("proceso_enviado", "proceso", pid, f"envío #{numero}")

    return jsonify({
        "ok": True, "numero": numero, "avance": avance,
        "fotos": fotos, "audios": audios,
        "url": url,
        "texto": _texto_whatsapp(p, avance, fotos, audios, numero, url),
    })


def _texto_whatsapp(p, avance, fotos, audios, numero, url):
    """Mensaje corto para pegar en WhatsApp o en el cuerpo de un correo."""
    lineas = [
        f"*{p['nombre']}*",
        f"{p['codigo'] or ''}{' · ' + p['area'] if p['area'] else ''}".strip(" ·"),
        "",
        f"Levantamiento completo al {avance}%.",
        f"Incluye {fotos} foto(s) y {audios} nota(s) de voz.",
        "",
        "Puedes ver el informe completo, con las fotos y escuchar los audios, aquí:",
        url,
    ]
    if numero > 1:
        lineas.insert(3, f"(Envío #{numero} — actualiza el anterior)")
    return "\n".join(l for l in lineas if l is not None)


@api.get("/procesos/<pid>/envios")
@login_required
def listar_envios(pid):
    envs = D.rows("SELECT * FROM envios WHERE proceso_id=? ORDER BY numero DESC", (pid,))
    t = D.row("SELECT token FROM share_tokens WHERE proceso_id=? AND activo", (pid,))
    return jsonify({
        "envios": [{"numero": e["numero"], "usuario": e["usuario_id"], "avance": e["avance"],
                    "fotos": e["fotos"], "audios": e["audios"], "resumen": e["resumen"],
                    "creado": str(e["creado"])} for e in envs],
        "url": (request.host_url.rstrip("/") + "/r/" + t["token"]) if t else None,
    })


@api.delete("/procesos/<pid>/compartir")
@puede_editar
def revocar_share(pid):
    D.execute("UPDATE share_tokens SET activo=? WHERE proceso_id=?",
              (False if D.USE_PG else 0, pid))
    auditar("informe_revocado", "proceso", pid)
    return jsonify({"ok": True})


# ── Informe público (el enlace que se manda por WhatsApp o correo) ──────────

def datos_informe(token):
    t = D.row("SELECT * FROM share_tokens WHERE token=? AND activo", (token,))
    if not t:
        return None
    p = D.row("SELECT * FROM procesos WHERE id=?", (t["proceso_id"],))
    if not p:
        return None

    D.execute("UPDATE share_tokens SET vistas = vistas + 1 WHERE token=?", (token,))

    plantilla = D.jload(D.row("SELECT data FROM plantilla WHERE id=1")["data"], {})
    respuestas = D.jload(p["respuestas"], {})
    nombres = {u["id"]: u["nombre"] for u in D.rows("SELECT id, nombre FROM usuarios")}

    evs = D.rows("SELECT * FROM evidencias WHERE proceso_id=? ORDER BY creado", (t["proceso_id"],))
    por_campo = {}
    for e in evs:
        por_campo.setdefault(e["campo_id"] or "", []).append({
            "tipo": e["tipo"], "mediaId": e["media_id"], "nota": e["nota"],
            "duracion": e["duracion"] or 0, "origen": e["origen"] or "app",
            "autor": nombres.get(e["autor_id"], ""), "fecha": str(e["creado"])[:16],
        })

    secciones = []
    for s in plantilla.get("secciones", []):
        campos = []
        for c in s.get("campos", []):
            v = respuestas.get(c["id"])
            ev = por_campo.get(c["id"], [])
            if not ev and (v is None or v == "" or v == [] or v == {}):
                continue
            campos.append({
                "etiqueta": c["etiqueta"], "tipo": c["tipo"],
                "valor": v, "nombres": nombres, "evidencias": ev,
            })
        if campos:
            secciones.append({"nombre": s.get("nombre", ""), "campos": campos})

    sueltas = por_campo.get("", [])
    avance, _ = _avance(plantilla, respuestas)
    envios = D.rows("SELECT * FROM envios WHERE proceso_id=? ORDER BY numero DESC LIMIT 1",
                    (t["proceso_id"],))

    return {
        "token": token,
        "proceso": {
            "nombre": p["nombre"], "codigo": p["codigo"], "area": p["area"],
            "estado": p["estado"], "responsable": nombres.get(p["responsable_id"], "—"),
            "enviado": str(p.get("enviado_en") or "")[:16],
        },
        "avance": avance,
        "secciones": secciones,
        "sueltas": sueltas,
        "totales": {
            "fotos": sum(1 for e in evs if e["tipo"] == "foto"),
            "audios": sum(1 for e in evs if e["tipo"] == "audio"),
        },
        "ultimo_envio": ({"numero": envios[0]["numero"], "resumen": envios[0]["resumen"],
                          "por": nombres.get(envios[0]["usuario_id"], "")} if envios else None),
        "organizacion": D.jload(D.row("SELECT data FROM config WHERE id=1")["data"], {}).get("organizacion", ""),
    }


def informe_media(token, mid):
    t = D.row("SELECT proceso_id FROM share_tokens WHERE token=? AND activo", (token,))
    if not t:
        return jsonify({"error": "enlace_revocado"}), 410
    m = D.row("SELECT * FROM media WHERE id=? AND proceso_id=?", (mid, t["proceso_id"]))
    if not m:
        return jsonify({"error": "no_existe"}), 404
    return _enviar_media(m)


def _borrar_media(mid):
    if not mid:
        return
    m = D.row("SELECT ruta FROM media WHERE id=?", (mid,))
    if m and m.get("ruta"):
        try:
            os.remove(m["ruta"])
        except OSError:
            pass
    D.execute("DELETE FROM media WHERE id=?", (mid,))


# ═══════════════════════════════════════════════════════════════════════════
# Exportación
# ═══════════════════════════════════════════════════════════════════════════

def _campos_planos(plantilla):
    out = []
    for s in plantilla.get("secciones", []):
        for c in s.get("campos", []):
            c = dict(c)
            c["seccion"] = s.get("nombre", "")
            out.append(c)
    return out


def _valor_texto(campo, v, nombres):
    if v is None:
        return ""
    t = campo.get("tipo")
    if t == "pasos" and isinstance(v, list):
        partes = []
        for i, r in enumerate(v):
            if not r.get("actividad"):
                continue
            linea = (f"{i+1}. {r.get('actividad','')} | {r.get('responsable','')} | "
                     f"{r.get('sistema','')} | {r.get('tiempo','')}")
            if r.get("detalle"):
                linea += " || Detalle: " + a_texto_plano(r["detalle"])
            subs = [x for x in (r.get("subtareas") or []) if x]
            if subs:
                linea += " || Sub: " + "; ".join(subs)
            partes.append(linea)
        return " / ".join(partes)
    if t == "multi" and isinstance(v, list):
        return ", ".join(v)
    if t == "persona":
        return nombres.get(v, "")
    return a_texto_plano(str(v))


@api.get("/export/csv")
@login_required
def export_csv():
    plantilla = D.jload(D.row("SELECT data FROM plantilla WHERE id=1")["data"], {})
    campos = _campos_planos(plantilla)
    nombres = {u["id"]: u["nombre"] for u in _equipo()}
    procs = _procesos()

    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", quoting=csv.QUOTE_ALL)
    w.writerow(["Código", "Proceso", "Área", "Responsable", "Estado"] +
               [f"{c['seccion']} · {c['etiqueta']}" for c in campos])
    for p in procs:
        r = p["respuestas"]
        w.writerow([p["codigo"] or "", p["nombre"], p["area"] or "",
                    nombres.get(p["responsable"], ""), p["estado"]] +
                   [_valor_texto(c, r.get(c["id"]), nombres) for c in campos])

    datos = "\ufeff" + buf.getvalue()
    return Response(datos, mimetype="text/csv; charset=utf-8", headers={
        "Content-Disposition": 'attachment; filename="procesos.csv"'})


@api.get("/export/json")
@login_required
def export_json():
    payload = {
        "config": D.jload(D.row("SELECT data FROM config WHERE id=1")["data"], {}),
        "plantilla": D.jload(D.row("SELECT data FROM plantilla WHERE id=1")["data"], {}),
        "equipo": _equipo(),
        "procesos": _procesos(),
        "exportado": _now(),
    }
    return Response(D.jdump(payload), mimetype="application/json", headers={
        "Content-Disposition": 'attachment; filename="levantamiento.json"'})


# ═══════════════════════════════════════════════════════════════════════════
# Media
# ═══════════════════════════════════════════════════════════════════════════

def _enviar_media(m):
    if m.get("ruta"):
        if not os.path.exists(m["ruta"]):
            return jsonify({"error": "archivo_perdido"}), 404
        resp = send_file(m["ruta"], mimetype=m["content_type"], conditional=True)
    else:
        resp = send_file(io.BytesIO(D.to_bytes(m["data"])), mimetype=m["content_type"],
                         download_name=m["nombre"] or m["id"])
    resp.headers["Cache-Control"] = "private, max-age=86400"
    return resp


def servir_media(mid):
    if not usuario_actual():
        return jsonify({"error": "no_autenticado"}), 401
    m = D.row("SELECT * FROM media WHERE id=?", (mid,))
    if not m:
        return jsonify({"error": "no_existe"}), 404
    return _enviar_media(m)
