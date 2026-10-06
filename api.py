"""
api.py — API REST.

Todas las rutas cuelgan de /api salvo /media/<id>, que sirve fotos y audios.
"""
import base64
import csv
import hashlib
import re
import io
import os
import secrets
import tempfile
import uuid
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request, send_file, Response, current_app

import db as D
import documentos as Doc
import entrevistas as E
import flujo as F
import videos as V
import ia
import subidas as SUB
import transcribir as TR
from sanitizar import limpiar_respuestas, a_texto_plano, limpiar_html
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
    "video/webm", "video/mp4",
    # Documentos: los consentimientos, protocolos y formatos que la clínica
    # ya tiene escritos. Son parte del levantamiento tanto como una foto.
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "text/plain", "text/csv", "text/rtf", "application/rtf",
}

# Por la extensión, cuando el navegador o el zip no declaran el tipo.
PORTIPO = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".txt": "text/plain", ".csv": "text/csv", ".rtf": "application/rtf",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif",
    ".heic": "image/heic", ".heif": "image/heif",
}


def _clase_de(ctype):
    """Qué es, para la pantalla: una foto, un audio o un documento."""
    if ctype.startswith("image/"):
        return "foto"
    if ctype.startswith("audio/") or ctype.startswith("video/"):
        return "audio"
    return "documento"
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

def _alcance():
    """None significa 'todos los procesos'; un id, solo los de esa persona.

    El admin y la contraparte de la clínica ven todo: el primero porque
    coordina, la segunda porque necesita saber qué le van a preguntar y
    cuándo. Los analistas ven solo lo suyo.
    """
    u = usuario_actual()
    return None if u["rol"] in ("admin", "clinica", "lector") else u["id"]


@api.get("/bootstrap")
@login_required
def bootstrap():
    return jsonify({
        "usuario": usuario_actual(),
        "config": D.jload(D.row("SELECT data FROM config WHERE id=1")["data"], {}),
        "plantilla": D.jload(D.row("SELECT data FROM plantilla WHERE id=1")["data"], {}),
        "equipo": _equipo(),
        "procesos": _procesos(_alcance()),
    })


def _equipo():
    filas = D.rows(
        "SELECT id, usuario, nombre, rol, contacto, ultimo_visto FROM usuarios "
        "WHERE activo ORDER BY nombre")
    for f in filas:
        f["ultimoVisto"] = str(f.pop("ultimo_visto") or "")
    return filas


def _url_informe(token):
    return request.host_url.rstrip("/") + "/r/" + token if token else ""


def _procesos(solo_de=None):
    """El admin ve todo. Los demás, únicamente lo que tienen a cargo."""
    if solo_de:
        ps = D.rows("SELECT * FROM procesos WHERE responsable_id=? AND COALESCE(eliminado,0)=0 "
                    "ORDER BY codigo, nombre", (solo_de,))
    else:
        ps = D.rows("SELECT * FROM procesos WHERE COALESCE(eliminado,0)=0 "
                    "ORDER BY codigo, nombre")
    evs = D.rows("SELECT * FROM evidencias ORDER BY COALESCE(orden,0), creado")
    tokens = {t["proceso_id"]: t["token"] for t in
              D.rows("SELECT proceso_id, token FROM share_tokens WHERE activo")}
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
            "fechaLimite": str(p.get("fecha_limite") or ""),
            "atiende": p.get("atiende") or "",
            "hora": p.get("hora") or "",
            "sesiones": D.jload(p.get("sesiones"), []),
            "notasClinica": p.get("notas_clinica") or "",
            "notaVista": p.get("nota_vista") or "",
            "notaRevision": p.get("nota_revision") or "",
            "revisadoEn": str(p.get("revisado_en") or ""),
            "propuestoPor": p.get("propuesto_por") or "",
            "informeUrl": _url_informe(tokens.get(p["id"])),
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
    return jsonify({"procesos": _procesos(_alcance())})


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

    fila = D.row("SELECT data, version FROM plantilla WHERE id=1")
    version = (fila["version"] or 1) + 1
    # Se conservan las marcas internas (como _base, que recuerda qué campos
    # base ya se sembraron); si no, al guardar se repondrían campos que el
    # usuario acaba de borrar a propósito.
    previa = D.jload(fila["data"], {})
    nueva = {k: v for k, v in previa.items() if k.startswith("_")}
    nueva["secciones"] = secciones
    D.execute("UPDATE plantilla SET data=?, version=? WHERE id=1",
              (D.jdump(nueva), version))
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
@rol_required("admin", "analista", "clinica")
def crear_proceso():
    d = request.get_json(silent=True) or {}
    nombre = (d.get("nombre") or "").strip()
    if not nombre:
        return jsonify({"error": "nombre_requerido"}), 400

    u = usuario_actual()
    # Solo el administrador decide de quién es un proceso. Un analista crea a
    # nombre propio. La clínica propone: el proceso nace sin responsable, para
    # que la coordinación decida quién lo levanta.
    if u["rol"] == "admin":
        responsable = d.get("responsable") or None
    elif u["rol"] == "clinica":
        responsable = None
    else:
        responsable = u["id"]

    pid = _nuevo_id("p_")
    D.execute(
        "INSERT INTO procesos (id, codigo, nombre, area, responsable_id, estado, "
        "notas, respuestas, creado_por, actualizado_por, fecha_limite, contacto) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (pid, (d.get("codigo") or "").strip(), nombre, (d.get("area") or "").strip(),
         responsable, d.get("estado") or "pendiente",
         (d.get("notas") or "").strip(),
         D.jdump(limpiar_respuestas(d.get("respuestas") or {})),
         u["id"], u["id"],
         (d.get("fechaLimite") or None) if u["rol"] == "admin" else None,
         (d.get("contacto") or d.get("atiende") or "").strip()))

    if u["rol"] == "clinica":
        D.execute("UPDATE procesos SET propuesto_por=?, notas_clinica=? WHERE id=?",
                  (u["id"], (d.get("notasClinica") or "").strip()[:4000], pid))
    auditar("proceso_creado", "proceso", pid, nombre)
    return jsonify({"ok": True, "id": pid})


@api.put("/procesos/<pid>/atiende")
@login_required
def designar_atiende(pid):
    """La contraparte de la clínica anota quién va a atender de su lado."""
    u = usuario_actual()
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404
    # La coordinación y la clínica siempre; quien levanta, sobre lo suyo:
    # muchas veces el nombre de la contraparte lo averigua él mismo.
    if u["rol"] not in ("admin", "clinica") and not _mio(p, u):
        return jsonify({"error": "sin_permiso"}), 403

    d = request.get_json(silent=True) or {}
    campos, params = [], []
    if "atiende" in d:
        campos.append("atiende=?")
        params.append((d.get("atiende") or "").strip()[:200])
    # La hora la pone la clínica: es la única parte de la programación que
    # depende de ellos, porque saben a qué hora puede atender cada persona.
    if "hora" in d:
        hora = (d.get("hora") or "").strip()[:5]
        campos.append("hora=?")
        params.append(hora if re.match(r"^\d{2}:\d{2}$", hora) else None)
    if not campos:
        return jsonify({"ok": True})

    params.append(pid)
    D.execute(f"UPDATE procesos SET {', '.join(campos)} WHERE id=?", tuple(params))
    auditar("agenda_actualizada", "proceso", pid, f"{d.get('atiende','')} {d.get('hora','')}")
    return jsonify({"ok": True})


@api.put("/procesos/<pid>/nota-clinica")
@login_required
def nota_clinica(pid):
    """El cuadro de “tener en cuenta”: lo escribe la clínica, lo lee quien
    levanta. Es el canal para advertir cosas antes de la entrevista."""
    u = usuario_actual()
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404
    # La coordinación y la clínica siempre; quien levanta, sobre lo suyo:
    # muchas veces el nombre de la contraparte lo averigua él mismo.
    if u["rol"] not in ("admin", "clinica") and not _mio(p, u):
        return jsonify({"error": "sin_permiso"}), 403

    d = request.get_json(silent=True) or {}
    texto = limpiar_html((d.get("notasClinica") or "").strip()[:8000])
    D.execute("UPDATE procesos SET notas_clinica=? WHERE id=?", (texto, pid))
    auditar("nota_clinica", "proceso", pid)
    return jsonify({"ok": True})


# ═══════════════════════════════════════════════════════════════════════════
# Análisis con Claude
# ═══════════════════════════════════════════════════════════════════════════

@api.get("/ia/estado")
@rol_required("admin")
def ia_estado():
    return jsonify({"configurada": ia.hay_llave(), "llave": ia.llave_enmascarada(),
                    "modelo": ia.MODELO_DEFECTO})


@api.put("/ia/llave")
@rol_required("admin")
def ia_llave():
    d = request.get_json(silent=True) or {}
    ia.guardar_llave(d.get("llave") or "")
    auditar("ia_llave_actualizada")
    return jsonify({"ok": True, "configurada": ia.hay_llave(),
                    "llave": ia.llave_enmascarada()})


@api.post("/ia/probar")
@rol_required("admin")
def ia_probar():
    try:
        modelo = ia.probar_llave()
        return jsonify({"ok": True, "modelo": modelo})
    except ia.IAError as e:
        return jsonify({"error": e.codigo, "detalle": e.detalle}), 400


@api.post("/procesos/<pid>/analizar")
@rol_required("admin")
def analizar_proceso(pid):
    """Pedir un análisis gasta saldo de la cuenta de Anthropic, así que lo
    hace únicamente quien responde por ese gasto."""
    p = D.row("SELECT * FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()

    plantilla = D.jload(D.row("SELECT data FROM plantilla WHERE id=1")["data"], {})
    respuestas = D.jload(p["respuestas"], {})
    avance, faltan = _avance(plantilla, respuestas)
    if avance < 25:
        return jsonify({"error": "muy_vacio", "avance": avance}), 422

    nombres = {x["id"]: x["nombre"] for x in D.rows("SELECT id, nombre FROM usuarios")}
    otros = D.rows("SELECT id, nombre, area FROM procesos "
                   "WHERE COALESCE(eliminado,0)=0 AND id<>?", (pid,))
    procesos = {x["id"]: x["nombre"] for x in otros}
    evidencias = D.rows("SELECT tipo, nota, campo_id, duracion, media_id "
                        "FROM evidencias WHERE proceso_id=? ORDER BY COALESCE(orden,0), creado", (pid,))

    texto = ia.armar_texto(p, plantilla, respuestas, nombres, procesos, evidencias)
    catalogo = _catalogo_para_ia(pid)
    imagenes = _imagenes_para_ia(pid, plantilla, evidencias)

    try:
        analisis, modelo, uso = ia.analizar(texto, catalogo, imagenes)
    except ia.IAError as e:
        # Se devuelve todo lo que se sabe del fallo, incluido lo que Claude
        # alcanzó a escribir: sin eso no hay forma de saber qué corregir.
        auditar("analisis_fallido", "proceso", pid, f"{e.codigo}: {e.detalle[:100]}")
        return jsonify({"error": e.codigo, "detalle": e.detalle,
                        "crudo": (e.crudo or "")[:4000], "contexto": e.extra,
                        "tamanoEnviado": len(texto)}), 502

    aid = _nuevo_id("an_")
    D.execute("INSERT INTO analisis (id, proceso_id, contenido, modelo, estado, pedido_por) "
              "VALUES (?,?,?,?,?,?)",
              (aid, pid, D.jdump(analisis), modelo, "propuesto", u["id"]))
    auditar("analisis_generado", "proceso", pid,
            f"{uso['entrada']}+{uso['salida']} tokens")

    return jsonify({"ok": True, "id": aid, "analisis": analisis,
                    "modelo": modelo, "uso": uso, "avance": avance,
                    "recuperado": bool(analisis.get("_recuperado")),
                    "reparado": bool(analisis.get("_reparado")),
                    "fotosEnviadas": len(imagenes),
                    "audios": sum(1 for e in evidencias if e["tipo"] == "audio")})


def _catalogo_para_ia(excluir=None):
    """Los otros procesos con lo justo para poder enlazarlos.

    Solo el nombre no alcanza: para saber si dos procesos se tocan hay que
    comparar dónde termina uno con dónde empieza el otro. Se manda eso.
    """
    salida = []
    for x in D.rows("SELECT id, nombre, area, respuestas FROM procesos "
                    "WHERE COALESCE(eliminado,0)=0 ORDER BY codigo, nombre"):
        if x["id"] == excluir:
            continue
        r = D.jload(x["respuestas"], {})
        def corto(campo, n=110):
            return a_texto_plano(str(r.get(campo) or ""))[:n]
        partes = [f"- {x['nombre']} ({x['area'] or 'sin área'})"]
        if corto("f_objetivo"):
            partes.append(f"    para qué es: {corto('f_objetivo')}")
        if corto("f_inicio"):
            partes.append(f"    arranca cuando: {corto('f_inicio')}")
        if corto("f_fin"):
            partes.append(f"    termina cuando: {corto('f_fin')}")
        salida.append("\n".join(partes))
    return salida


def _imagenes_para_ia(pid, plantilla, evidencias):
    """Prepara las fotos del proceso para mandárselas a Claude.

    Se reducen de tamaño y se etiquetan con la pregunta a la que pertenecen.
    Si hay más de las que caben, se toman las primeras: fueron las que la
    persona consideró importante mostrar primero.
    """
    etiquetas = {c["id"]: c["etiqueta"]
                 for s in plantilla.get("secciones", []) for c in s.get("campos", [])}

    def donde(campo):
        if not campo:
            return "general"
        partes = campo.split(":")
        base = etiquetas.get(partes[0], partes[0])
        if len(partes) == 3:
            return f"{base}, sub-actividad {int(partes[1])+1}.{int(partes[2])+1}"
        if len(partes) == 2:
            return f"{base}, actividad {int(partes[1])+1}"
        return base

    fotos = [e for e in evidencias if e["tipo"] == "foto" and e["media_id"]][:ia.MAX_IMAGENES]
    salida = []
    for e in fotos:
        m = D.row("SELECT content_type, data, ruta FROM media WHERE id=?", (e["media_id"],))
        if not m:
            continue
        if m.get("ruta"):
            try:
                with open(m["ruta"], "rb") as fh:
                    datos = fh.read()
            except OSError:
                continue
        else:
            datos = D.to_bytes(m["data"])
        if not datos:
            continue
        datos, ctype = ia.reducir_imagen(datos, m["content_type"] or "image/jpeg")
        if ctype not in ("image/jpeg", "image/png", "image/gif", "image/webp"):
            continue
        salida.append({"etiqueta": donde(e["campo_id"]), "datos": datos, "tipo": ctype})
    return salida


@api.post("/analisis-lote")
@rol_required("admin")
def analizar_lote():
    """Mira varios procesos juntos: cómo se encadenan, qué se repite y qué
    módulos saldrían de ahí."""
    d = request.get_json(silent=True) or {}
    ids = [x for x in (d.get("procesos") or []) if isinstance(x, str)][:12]
    if len(ids) < 2:
        return jsonify({"error": "pocos_procesos"}), 422

    plantilla = D.jload(D.row("SELECT data FROM plantilla WHERE id=1")["data"], {})
    nombres = {x["id"]: x["nombre"] for x in D.rows("SELECT id, nombre FROM usuarios")}
    todos = {x["id"]: x["nombre"] for x in D.rows("SELECT id, nombre FROM procesos")}

    bloques, imagenes, incluidos = [], [], []
    # El cupo de fotos se reparte entre los procesos elegidos, para que
    # ninguno acapare y todos aporten evidencia.
    cupo = max(1, ia.MAX_IMAGENES * 2 // max(1, len(ids)))

    for pid in ids:
        p = D.row("SELECT * FROM procesos WHERE id=? AND COALESCE(eliminado,0)=0", (pid,))
        if not p:
            continue
        respuestas = D.jload(p["respuestas"], {})
        evidencias = D.rows("SELECT tipo, nota, campo_id, duracion, media_id "
                            "FROM evidencias WHERE proceso_id=? ORDER BY COALESCE(orden,0), creado", (pid,))
        bloques.append(ia.armar_texto(p, plantilla, respuestas, nombres, todos, evidencias))
        incluidos.append(p["nombre"])
        for img in _imagenes_para_ia(pid, plantilla, evidencias)[:cupo]:
            img["proceso"] = p["nombre"]
            imagenes.append(img)

    if len(bloques) < 2:
        return jsonify({"error": "pocos_procesos"}), 422

    try:
        analisis, modelo, uso = ia.analizar_lote(bloques, imagenes)
    except ia.IAError as e:
        auditar("lote_fallido", "analisis", None, f"{e.codigo}: {e.detalle[:100]}")
        return jsonify({"error": e.codigo, "detalle": e.detalle,
                        "crudo": (e.crudo or "")[:4000], "contexto": e.extra}), 502

    u = usuario_actual()
    lid = _nuevo_id("lo_")
    titulo = (d.get("titulo") or f"{len(incluidos)} procesos").strip()[:120]
    D.execute("INSERT INTO analisis_lote (id, procesos, contenido, titulo, modelo, pedido_por) "
              "VALUES (?,?,?,?,?,?)",
              (lid, D.jdump(ids), D.jdump(analisis), titulo, modelo, u["id"]))
    auditar("lote_generado", "analisis", lid,
            f"{len(incluidos)} procesos, {len(imagenes)} fotos")

    return jsonify({"ok": True, "id": lid, "analisis": analisis, "modelo": modelo,
                    "uso": uso, "procesos": incluidos, "fotos": len(imagenes)})


@api.get("/analisis-lote")
@rol_required("admin")
def listar_lotes():
    nombres = {x["id"]: x["nombre"] for x in D.rows("SELECT id, nombre FROM usuarios")}
    procesos = {x["id"]: x["nombre"] for x in D.rows("SELECT id, nombre FROM procesos")}
    filas = D.rows("SELECT * FROM analisis_lote ORDER BY creado DESC LIMIT 30")
    return jsonify({"lotes": [{
        "id": f["id"], "titulo": f["titulo"], "modelo": f["modelo"],
        "creado": str(f["creado"]), "por": nombres.get(f["pedido_por"], ""),
        "procesos": [procesos.get(x, x) for x in D.jload(f["procesos"], [])],
        "contenido": D.jload(f["contenido"], {}),
    } for f in filas]})


@api.delete("/analisis-lote/<lid>")
@rol_required("admin")
def borrar_lote(lid):
    D.execute("DELETE FROM analisis_lote WHERE id=?", (lid,))
    return jsonify({"ok": True})


@api.get("/procesos/<pid>/analisis")
@rol_required("admin")
def listar_analisis(pid):
    nombres = {x["id"]: x["nombre"] for x in D.rows("SELECT id, nombre FROM usuarios")}
    filas = D.rows("SELECT * FROM analisis WHERE proceso_id=? ORDER BY creado DESC", (pid,))
    return jsonify({"analisis": [{
        "id": f["id"], "estado": f["estado"], "modelo": f["modelo"],
        "pedidoPor": nombres.get(f["pedido_por"], ""),
        "aprobadoPor": nombres.get(f["aprobado_por"], ""),
        "creado": str(f["creado"]),
        "contenido": D.jload(f["contenido"], {}),
    } for f in filas]})


@api.post("/analisis/<aid>/decidir")
@rol_required("admin")
def decidir_analisis(aid):
    """El administrador aprueba o descarta. Solo lo aprobado sale en el informe."""
    a = D.row("SELECT * FROM analisis WHERE id=?", (aid,))
    if not a:
        return jsonify({"error": "no_existe"}), 404

    d = request.get_json(silent=True) or {}
    estado = d.get("estado")
    if estado not in ("aprobado", "descartado"):
        return jsonify({"error": "estado_invalido"}), 400

    u = usuario_actual()
    contenido = D.jload(a["contenido"], {})

    # Las conexiones aprobadas sí tocan el levantamiento: entran a los campos
    # de enlace y con eso aparecen en el mapa.
    aplicadas = 0
    if estado == "aprobado" and isinstance(d.get("conexiones"), list):
        p = D.row("SELECT respuestas FROM procesos WHERE id=?", (a["proceso_id"],))
        respuestas = D.jload(p["respuestas"], {})
        antes = set(respuestas.get("f_viene_de") or [])
        despues = set(respuestas.get("f_va_hacia") or [])
        for c in d["conexiones"]:
            otro = D.row("SELECT id FROM procesos WHERE nombre=? AND COALESCE(eliminado,0)=0",
                         (c.get("proceso") or "",))
            if not otro:
                continue
            (antes if c.get("direccion") == "antes" else despues).add(otro["id"])
            aplicadas += 1
        if aplicadas:
            _guardar_version(a["proceso_id"], u["id"], "antes de aplicar conexiones del análisis")
            respuestas["f_viene_de"] = sorted(antes)
            respuestas["f_va_hacia"] = sorted(despues)
            D.execute("UPDATE procesos SET respuestas=? WHERE id=?",
                      (D.jdump(respuestas), a["proceso_id"]))
        contenido["conexiones_aprobadas"] = d["conexiones"]

    D.execute("UPDATE analisis SET estado=?, aprobado_por=?, aprobado_en=?, contenido=? "
              "WHERE id=?", (estado, u["id"], _now(), D.jdump(contenido), aid))
    auditar("analisis_" + estado, "proceso", a["proceso_id"], f"{aplicadas} conexión(es)")
    return jsonify({"ok": True, "conexionesAplicadas": aplicadas})


@api.post("/procesos/<pid>/revisar")
@rol_required("admin")
def revisar_proceso(pid):
    """Aprobar cierra el proceso. Devolver lo regresa a quien lo levantó,
    con el motivo, para que lo complete y lo vuelva a enviar."""
    p = D.row("SELECT id, nombre, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404

    d = request.get_json(silent=True) or {}
    decision = d.get("decision")
    if decision not in ("aprobado", "devuelto"):
        return jsonify({"error": "decision_invalida"}), 400

    nota = (d.get("nota") or "").strip()[:2000]
    if decision == "devuelto" and not nota:
        return jsonify({"error": "falta_motivo"}), 400

    estado = "aprobado" if decision == "aprobado" else "en_curso"
    D.execute(f"UPDATE procesos SET estado=?, nota_revision=?, revisado_en=?, "
              f"actualizado={D.NOW} WHERE id=?",
              (estado, nota, _now(), pid))
    auditar("proceso_" + decision, "proceso", pid, nota[:120])
    return jsonify({"ok": True, "estado": estado})


@api.post("/procesos/<pid>/nota-vista")
@rol_required("admin")
def marcar_nota_vista(pid):
    """Da por leída la nota de la clínica.

    Se guarda el texto exacto que se leyó, no una marca de tiempo: si la
    clínica escribe algo nuevo, el aviso vuelve a aparecer solo.
    """
    p = D.row("SELECT notas_clinica FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404
    D.execute("UPDATE procesos SET nota_vista=? WHERE id=?",
              (p["notas_clinica"] or "", pid))
    return jsonify({"ok": True})


# ═══════════════════════════════════════════════════════════════════════════
# Documentos de análisis: revisión, aprobación y comentarios
# ═══════════════════════════════════════════════════════════════════════════

@api.post("/documentos")
@rol_required("admin")
def crear_documento():
    """Convierte un análisis en documento revisable.

    Se guardan también las fotos, porque el valor del documento está en
    poder mirar el formato mientras se lee la lista de campos.
    """
    d = request.get_json(silent=True) or {}
    lote = D.row("SELECT * FROM analisis_lote WHERE id=?", (d.get("lote") or "",))
    if lote:
        contenido = D.jload(lote["contenido"], {})
        ids = D.jload(lote["procesos"], [])
        titulo = d.get("titulo") or lote["titulo"] or "Análisis"
        origen = "lote:" + lote["id"]
    else:
        ana = D.row("SELECT * FROM analisis WHERE id=?", (d.get("analisis") or "",))
        if not ana:
            return jsonify({"error": "no_existe"}), 404
        contenido = D.jload(ana["contenido"], {})
        ids = [ana["proceso_id"]]
        p = D.row("SELECT nombre FROM procesos WHERE id=?", (ana["proceso_id"],))
        titulo = d.get("titulo") or (p["nombre"] if p else "Análisis")
        origen = "analisis:" + ana["id"]

    nombres = {x["id"]: x["nombre"] for x in D.rows("SELECT id, nombre FROM procesos")}
    fotos = _fotos_del_documento(ids)

    u = usuario_actual()
    did = Doc.crear(titulo, contenido, [nombres.get(x, x) for x in ids],
                    fotos, u["id"], origen)
    auditar("documento_creado", "documento", did, titulo)
    return jsonify({"ok": True, "id": did, "documento": Doc.leer(did)})


def _fotos_del_documento(ids):
    """Las fotos de estos procesos, con su pregunta y su proceso."""
    plantilla = D.jload(D.row("SELECT data FROM plantilla WHERE id=1")["data"], {})
    etiquetas = {c["id"]: c["etiqueta"]
                 for s in plantilla.get("secciones", []) for c in s.get("campos", [])}

    def donde(campo):
        if not campo:
            return "general"
        partes = campo.split(":")
        base = etiquetas.get(partes[0], partes[0])
        if len(partes) == 3:
            return f"{base}, sub-actividad {int(partes[1])+1}.{int(partes[2])+1}"
        if len(partes) == 2:
            return f"{base}, actividad {int(partes[1])+1}"
        return base

    salida = []
    for pid in ids:
        p = D.row("SELECT nombre FROM procesos WHERE id=?", (pid,))
        if not p:
            continue
        for e in D.rows("SELECT media_id, campo_id, nota FROM evidencias "
                        "WHERE proceso_id=? AND tipo='foto' ORDER BY COALESCE(orden,0), creado", (pid,)):
            salida.append({"mediaId": e["media_id"], "proceso": p["nombre"],
                           "donde": donde(e["campo_id"]), "nota": e["nota"] or ""})
    return salida


@api.get("/documentos")
@rol_required("admin")
def listar_documentos():
    nombres = {x["id"]: x["nombre"] for x in D.rows("SELECT id, nombre FROM usuarios")}
    docs = Doc.listar()
    for x in docs:
        x["creadoPorNombre"] = nombres.get(x["creadoPor"], "")
        x["comentarios"] = len([c for c in Doc.comentarios(x["id"]) if not c["resuelto"]])
    return jsonify({"documentos": docs})


@api.get("/documentos-mios")
@login_required
def documentos_mios():
    """Los que ya salieron hacia la clínica."""
    u = usuario_actual()
    if u["rol"] not in ("admin", "clinica"):
        return jsonify({"documentos": []})
    filas = D.rows("SELECT * FROM documentos WHERE estado IN ('con_cliente','aprobado') "
                   "ORDER BY creado DESC LIMIT 50")
    return jsonify({"documentos": [
        {k: v for k, v in Doc._armar(f).items() if k != "token"} for f in filas]})


@api.get("/documentos/<did>")
@login_required
def leer_documento(did):
    doc = Doc.leer(did)
    if not doc:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    # La clínica solo ve el documento cuando ya salió a su nombre, y sin la
    # parte técnica.
    if u["rol"] == "clinica":
        if doc["estado"] not in ("con_cliente", "aprobado"):
            return jsonify({"error": "todavia_no"}), 403
        doc = Doc.para_cliente(doc)
    elif u["rol"] != "admin":
        return jsonify({"error": "sin_permiso"}), 403

    return jsonify({"documento": doc, "comentarios": Doc.comentarios(did),
                    "secciones": Doc.SECCIONES,
                    "paraCliente": sorted(Doc.PARA_CLIENTE)})


@api.put("/documentos/<did>")
@rol_required("admin")
def editar_documento(did):
    """El administrador ajusta el texto antes de que salga."""
    if not Doc.leer(did):
        return jsonify({"error": "no_existe"}), 404
    d = request.get_json(silent=True) or {}
    campos, params = [], []
    if "titulo" in d:
        campos.append("titulo=?")
        params.append((d["titulo"] or "").strip()[:200])
    if isinstance(d.get("contenido"), dict):
        campos.append("contenido=?")
        params.append(D.jdump(limpiar_respuestas(d["contenido"])))
    if not campos:
        return jsonify({"ok": True})
    params.append(did)
    D.execute(f"UPDATE documentos SET {', '.join(campos)}, actualizado={D.NOW} WHERE id=?",
              tuple(params))
    return jsonify({"ok": True, "documento": Doc.leer(did)})


@api.post("/documentos/<did>/estado")
@login_required
def estado_documento(did):
    doc = Doc.leer(did)
    if not doc:
        return jsonify({"error": "no_existe"}), 404

    u = usuario_actual()
    d = request.get_json(silent=True) or {}
    nuevo = d.get("estado")

    if u["rol"] == "clinica":
        # El cliente solo puede dar su visto bueno a lo que ya le llegó.
        if nuevo != "aprobado" or doc["estado"] != "con_cliente":
            return jsonify({"error": "sin_permiso"}), 403
        D.execute(f"UPDATE documentos SET estado='aprobado', ok_cliente=?, "
                  f"actualizado={D.NOW} WHERE id=?", (_now(), did))
        auditar("documento_ok_cliente", "documento", did)
        return jsonify({"ok": True, "estado": "aprobado"})

    if u["rol"] != "admin":
        return jsonify({"error": "sin_permiso"}), 403
    if nuevo not in Doc.ESTADOS:
        return jsonify({"error": "estado_invalido"}), 400

    extra, params = "", []
    if nuevo == "revisado":
        extra = ", aprobado_por=?, aprobado_en=?"
        params = [u["id"], _now()]
    elif nuevo == "con_cliente":
        extra = ", enviado_en=?"
        params = [_now()]

    D.execute(f"UPDATE documentos SET estado=?{extra}, actualizado={D.NOW} WHERE id=?",
              tuple([nuevo] + params + [did]))
    auditar("documento_" + nuevo, "documento", did)
    return jsonify({"ok": True, "estado": nuevo, "documento": Doc.leer(did)})


@api.post("/documentos/<did>/comentarios")
@login_required
def comentar_documento(did):
    doc = Doc.leer(did)
    if not doc:
        return jsonify({"error": "no_existe"}), 404

    u = usuario_actual()
    if u["rol"] not in ("admin", "clinica"):
        return jsonify({"error": "sin_permiso"}), 403
    if u["rol"] == "clinica" and doc["estado"] not in ("con_cliente", "aprobado"):
        return jsonify({"error": "todavia_no"}), 403

    d = request.get_json(silent=True) or {}
    texto = (d.get("texto") or "").strip()
    if not texto:
        return jsonify({"error": "vacio"}), 400

    cid = Doc.sumar_comentario(did, d.get("ancla"), d.get("cita"), texto,
                               u["id"], u["nombre"], u["rol"] == "clinica")
    auditar("comentario", "documento", did, texto[:80])
    return jsonify({"ok": True, "id": cid, "comentarios": Doc.comentarios(did)})


@api.post("/comentarios/<cid>/resolver")
@rol_required("admin")
def resolver_comentario(cid):
    d = request.get_json(silent=True) or {}
    D.execute("UPDATE comentarios SET resuelto=1, respuesta=? WHERE id=?",
              ((d.get("respuesta") or "").strip()[:2000], cid))
    return jsonify({"ok": True})


def documento_html(did, para_cliente=False, publico=False):
    """El documento como una sola página, con las fotos embebidas.

    Se incrustan en base64 a propósito: un archivo que se guarda o se
    imprime no puede depender de que el servidor siga en pie.
    """
    doc = Doc.leer(did)
    if not doc:
        return None
    if para_cliente:
        doc = Doc.para_cliente(doc)

    c = doc["contenido"]
    partes = []

    def lista(items, fn):
        return "".join(fn(x) for x in (items or []))

    def esc2(t):
        from markupsafe import escape
        return str(escape(str(t if t is not None else "")))

    if c.get("panorama"):
        partes.append(f"<section><h2>Panorama general</h2><p>{esc2(c['panorama'])}</p></section>")

    if c.get("cadenas"):
        partes.append("<section><h2>Cómo se encadena el trabajo</h2>" + lista(
            c["cadenas"], lambda x: (
                f"<div class='caja'><h3>{esc2(x.get('nombre'))}</h3>"
                f"<p class='flujo'>{' → '.join(esc2(p) for p in x.get('procesos') or [])}</p>"
                f"<p>{esc2(x.get('descripcion'))}</p>"
                + ("<ul>" + lista(x.get("rupturas"), lambda r: f"<li>{esc2(r)}</li>") + "</ul>"
                   if x.get("rupturas") else "") + "</div>")) + "</section>")

    dibujo = F.svg(c.get("flujo"))
    if dibujo:
        partes.append("<section class='flujo'><h2>El flujo, paso a paso</h2>"
                      "<div class='lienzo-flujo'>" + dibujo + "</div></section>")

    if c.get("campos_formulario"):
        partes.append("<section><h2>Los formatos y sus campos</h2>" + lista(
            c["campos_formulario"], lambda f: (
                f"<div class='caja'><h3>{esc2(f.get('formulario'))}</h3>"
                f"<p class='meta'>{esc2(f.get('proceso'))} · {esc2(f.get('soporte'))}</p>"
                "<table><thead><tr><th>Campo</th><th>Tipo</th><th>Oblig.</th>"
                "<th>Quién lo llena</th><th>De dónde sale</th><th>¿Se guarda hoy?</th>"
                "</tr></thead><tbody>"
                + lista(f.get("campos"), lambda k: (
                    f"<tr><td><b>{esc2(k.get('nombre'))}</b></td><td>{esc2(k.get('tipo'))}</td>"
                    f"<td>{'Sí' if k.get('obligatorio') else 'No'}</td>"
                    f"<td>{esc2(k.get('quien_lo_llena'))}</td>"
                    f"<td>{esc2(k.get('de_donde_sale'))}</td>"
                    f"<td>{esc2(k.get('hoy_se_guarda') or '—')}</td></tr>"))
                + "</tbody></table></div>")) + "</section>")

    if c.get("duplicidades"):
        partes.append("<section><h2>Lo que se repite</h2><ul>" + lista(
            c["duplicidades"], lambda x: (
                f"<li><b>{esc2(x.get('que_se_repite'))}</b>"
                f"<div class='meta'>en: {', '.join(esc2(p) for p in x.get('procesos') or [])}</div>"
                f"<div>{esc2(x.get('propuesta'))}</div></li>")) + "</ul></section>")

    if not para_cliente and c.get("modulos_sugeridos"):
        partes.append("<section><h2>Módulos propuestos</h2>" + lista(
            c["modulos_sugeridos"], lambda x: (
                f"<div class='caja'><h3>{esc2(x.get('modulo'))} "
                f"<span class='et'>prioridad {esc2(x.get('prioridad'))}</span></h3>"
                f"<p>{esc2(x.get('por_que'))}</p>"
                + ("<p class='meta'>Cubre: " + ", ".join(esc2(p) for p in x.get("cubre") or []) + "</p>"
                   if x.get("cubre") else "")
                + ("<ul>" + lista(x.get("funciones"), lambda f: f"<li>{esc2(f)}</li>") + "</ul>"
                   if x.get("funciones") else "")
                + ("<p class='meta'>Datos: " + ", ".join(esc2(d2) for d2 in x.get("datos_clave") or []) + "</p>"
                   if x.get("datos_clave") else "") + "</div>")) + "</section>")

    if not para_cliente and c.get("automatizacion"):
        partes.append("<section><h2>Oportunidades de automatización</h2>" + lista(
            c["automatizacion"], lambda x: (
                f"<div class='caja'><h3>{esc2(x.get('que'))} "
                f"<span class='et'>{esc2(x.get('tecnologia'))}</span></h3>"
                f"<p>{esc2(x.get('como'))}</p>"
                f"<p class='meta'>Se dispara con: {esc2(x.get('dispara'))} · "
                f"Ahorra: {esc2(x.get('ahorro'))} · Esfuerzo: {esc2(x.get('esfuerzo'))}</p>"
                + (f"<p class='meta'>Riesgo: {esc2(x.get('riesgo'))}</p>" if x.get("riesgo") else "")
                + "</div>")) + "</section>")

    if c.get("vacios"):
        partes.append("<section><h2>Qué falta levantar</h2><ul>" + lista(
            c["vacios"], lambda x: f"<li>{esc2(x)}</li>") + "</ul></section>")

    if not para_cliente and c.get("siguiente_paso"):
        partes.append(f"<section><div class='destacado'><b>Por dónde empezar:</b> "
                      f"{esc2(c['siguiente_paso'])}</div></section>")

    # Las fotos, embebidas
    fotos_html = []
    for i, f in enumerate(doc.get("fotos") or []):
        m = D.row("SELECT content_type, data, ruta FROM media WHERE id=?", (f["mediaId"],))
        if not m:
            continue
        if m.get("ruta"):
            try:
                with open(m["ruta"], "rb") as fh:
                    datos = fh.read()
            except OSError:
                continue
        else:
            datos = D.to_bytes(m["data"])
        if not datos:
            continue
        datos, ctype = ia.reducir_imagen(datos, m["content_type"] or "image/jpeg")
        b64 = base64.b64encode(datos).decode("ascii")
        fotos_html.append(
            f"<figure><img src='data:{ctype};base64,{b64}'>"
            f"<figcaption>Foto {i+1} · {esc2(f.get('proceso'))} — {esc2(f.get('donde'))}"
            + (f"<br>{esc2(f.get('nota'))}" if f.get("nota") else "") + "</figcaption></figure>")
    if fotos_html:
        partes.append("<section class='fotos'><h2>Evidencia fotográfica</h2>"
                      + "".join(fotos_html) + "</section>")

    coms = [x for x in Doc.comentarios(did) if not x["resuelto"]]
    if coms and not publico:
        partes.append("<section><h2>Comentarios</h2><ul>" + "".join(
            f"<li><b>{esc2(x['autor'])}</b>"
            + (f" <span class='meta'>sobre: {esc2(x['cita'])}</span>" if x["cita"] else "")
            + f"<div>{esc2(x['texto'])}</div></li>" for x in coms) + "</ul></section>")

    return doc, "".join(partes)


@api.put("/procesos/<pid>/sesiones")
@login_required
def guardar_sesiones(pid):
    """Las visitas acordadas.

    Un levantamiento no siempre cabe en una sentada: muchas veces la
    clínica dice "venga toda la semana de 6 a 9" o cambia la hora entre
    un día y otro. Cada sesión es una visita con su día y su horario.
    """
    u = usuario_actual()
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404
    if u["rol"] not in ("admin", "clinica") and not _mio(p, u):
        return jsonify({"error": "sin_permiso"}), 403

    d = request.get_json(silent=True) or {}
    crudas = d.get("sesiones")
    if not isinstance(crudas, list):
        return jsonify({"error": "formato_invalido"}), 400

    limpias = []
    for s in crudas[:30]:
        if not isinstance(s, dict):
            continue
        fecha = (s.get("fecha") or "").strip()[:10]
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", fecha):
            continue
        def hora(v):
            v = (v or "").strip()[:5]
            return v if re.match(r"^\d{2}:\d{2}$", v) else ""
        limpias.append({
            "fecha": fecha,
            "inicio": hora(s.get("inicio")),
            "fin": hora(s.get("fin")),
            "atiende": (s.get("atiende") or "").strip()[:200],
            "nota": (s.get("nota") or "").strip()[:300],
        })

    limpias.sort(key=lambda x: (x["fecha"], x["inicio"] or "99:99"))

    # La primera visita manda: es la que sale en los tableros y la que
    # usa el cálculo de choques, para no tener dos verdades.
    primera = limpias[0] if limpias else None
    D.execute(
        f"UPDATE procesos SET sesiones=?, fecha_limite=?, hora=?, actualizado={D.NOW} "
        f"WHERE id=?",
        (D.jdump(limpias),
         primera["fecha"] if primera else None,
         (primera["inicio"] if primera else None) or None,
         pid))
    if primera and primera.get("atiende"):
        D.execute("UPDATE procesos SET atiende=? WHERE id=? AND (atiende IS NULL OR atiende='')",
                  (primera["atiende"], pid))

    auditar("sesiones", "proceso", pid, f"{len(limpias)} visita(s)")
    return jsonify({"ok": True, "sesiones": limpias})


@api.post("/procesos/<pid>/compartir-enlace")
@login_required
def asegurar_enlace(pid):
    """Devuelve el enlace del informe, creándolo si todavía no existe.

    Sirve para poder descargar el informe de un proceso que aún no se ha
    enviado formalmente: a veces hace falta llevárselo a una reunión antes.
    """
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if u["rol"] not in ("admin", "clinica") and not _mio(p, u):
        return jsonify({"error": "sin_permiso"}), 403

    token = _asegurar_share(pid, u["id"])
    return jsonify({"ok": True, "url": _url_informe(token), "token": token})


def _flujo_de(clase, ident):
    if clase == "lote":
        f = D.row("SELECT contenido FROM analisis_lote WHERE id=?", (ident,))
    elif clase == "doc":
        f = D.row("SELECT contenido FROM documentos WHERE id=?", (ident,))
    else:
        f = D.row("SELECT contenido FROM analisis WHERE id=?", (ident,))
    if not f:
        return None
    return D.jload(f["contenido"], {}).get("flujo")


@api.get("/flujo/<clase>/<ident>.svg")
@login_required
def flujo_svg(clase, ident):
    """El diagrama del flujo. Se sirve como imagen para poder usarlo en la
    pantalla, en el documento impreso y en el archivo descargado."""
    if clase not in ("analisis", "lote", "doc"):
        return jsonify({"error": "no_existe"}), 404
    dibujo = F.svg(_flujo_de(clase, ident))
    if not dibujo:
        return jsonify({"error": "sin_flujo"}), 404
    return Response(dibujo, mimetype="image/svg+xml",
                    headers={"Cache-Control": "no-store"})


@api.get("/flujo/<clase>/<ident>.mmd")
@login_required
def flujo_mermaid(clase, ident):
    texto = F.a_mermaid(_flujo_de(clase, ident))
    if not texto:
        return jsonify({"error": "sin_flujo"}), 404
    return Response(texto, mimetype="text/plain; charset=utf-8", headers={
        "Content-Disposition": 'attachment; filename="flujo.mmd"'})


@api.get("/diagnostico")
@login_required
def diagnostico():
    """Qué hay realmente guardado en el servidor.

    Sirve para contrastar con lo que el celular cree haber subido: si el
    teléfono dice diez fotos y aquí hay siete, la diferencia está en la
    cola o se perdió, y conviene saberlo antes de dar el proceso por
    terminado.
    """
    u = usuario_actual()
    pid = request.args.get("proceso")

    if pid:
        p = D.row("SELECT id, nombre, responsable_id FROM procesos WHERE id=?", (pid,))
        if not p:
            return jsonify({"error": "no_existe"}), 404
        if u["rol"] not in ("admin", "clinica", "lector") and not _mio(p, u):
            return jsonify({"error": "sin_permiso"}), 403
        donde = ("WHERE e.proceso_id=?", (pid,))
    elif u["rol"] == "admin":
        donde = ("", ())
    else:
        donde = ("WHERE p.responsable_id=?", (u["id"],))

    filas = D.rows(
        f"SELECT e.id, e.tipo, e.campo_id, e.media_id, e.creado, e.origen, "
        f"       m.id AS mid, m.tamano, m.content_type "
        f"FROM evidencias e "
        f"JOIN procesos p ON p.id = e.proceso_id "
        f"LEFT JOIN media m ON m.id = e.media_id "
        f"{donde[0]} ORDER BY e.creado DESC", donde[1])

    por_tipo, rotas, bytes_total = {}, [], 0
    for f in filas:
        t = f["tipo"] or "?"
        por_tipo[t] = por_tipo.get(t, 0) + 1
        if f["media_id"] and not f["mid"]:
            # La evidencia quedó apuntando a un archivo que no está: es el
            # síntoma de una subida interrumpida.
            rotas.append({"id": f["id"], "tipo": t, "campo": f["campo_id"] or "",
                          "creado": str(f["creado"])})
        bytes_total += f["tamano"] or 0

    recientes = [{
        "tipo": f["tipo"], "campo": f["campo_id"] or "", "creado": str(f["creado"]),
        "origen": f["origen"] or "escritorio",
        "kb": round((f["tamano"] or 0) / 1024),
        "ok": bool(f["mid"]) or f["tipo"] == "nota",
    } for f in filas[:25]]

    return jsonify({
        "total": len(filas), "porTipo": por_tipo, "rotas": rotas,
        "megas": round(bytes_total / 1048576, 1), "recientes": recientes,
        "proceso": pid or "",
    })


# ═══════════════════════════════════════════════════════════════════════════
# Entrevistas grabadas
# ═══════════════════════════════════════════════════════════════════════════

MAX_AUDIO = int(os.environ.get("MAX_AUDIO_MB", "150")) * 1024 * 1024
MAX_VIDEO_AUX = int(os.environ.get("MAX_VIDEO_MB", "900")) * 1024 * 1024


@api.get("/voz/estado")
@rol_required("admin")
def voz_estado():
    return jsonify(TR.estado())


@api.put("/voz/llave")
@rol_required("admin")
def voz_llave():
    d = request.get_json(silent=True) or {}
    prov = d.get("proveedor")
    if prov not in TR.PROVEEDORES:
        return jsonify({"error": "proveedor_invalido"}), 400
    TR.guardar_llave(prov, d.get("llave") or "")
    auditar("voz_llave", "config", prov)
    return jsonify({"ok": True, **TR.estado()})


@api.post("/grabaciones")
@puede_editar
def subir_grabacion():
    """Recibe el audio de una entrevista, y el video si cabe.

    El audio es obligatorio: es donde está lo que la persona explicó. El
    video es opcional porque pesa cien veces más y muchas veces se queda
    en el computador de quien grabó; sin él se pierde solo la evidencia
    en imágenes, no el paso a paso.
    """
    audio = request.files.get("audio")
    if not audio:
        return jsonify({"error": "sin_audio"}), 400
    if not TR.proveedor_activo():
        return jsonify({"error": "sin_llave_voz"}), 422

    datos_audio = audio.read()
    if not datos_audio:
        return jsonify({"error": "audio_vacio"}), 400
    if len(datos_audio) > MAX_AUDIO:
        return jsonify({"error": "audio_muy_grande",
                        "max_mb": MAX_AUDIO // (1024 * 1024)}), 413

    u = usuario_actual()
    pid = (request.form.get("proceso") or "").strip() or None
    if pid:
        p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
        if not p:
            return jsonify({"error": "proceso_no_existe"}), 404
        if not _mio(p, u):
            return jsonify({"error": "no_es_tuyo"}), 403

    try:
        duracion = int(float(request.form.get("duracion") or 0))
    except (TypeError, ValueError):
        duracion = 0

    carpeta = tempfile.mkdtemp(prefix="entrev_")
    ruta_audio = os.path.join(carpeta, audio.filename or "audio.m4a")
    with open(ruta_audio, "wb") as fh:
        fh.write(datos_audio)

    ruta_video = None
    video = request.files.get("video")
    if video:
        datos_video = video.read()
        if 0 < len(datos_video) <= MAX_VIDEO_AUX:
            ruta_video = os.path.join(carpeta, video.filename or "video.mp4")
            with open(ruta_video, "wb") as fh:
                fh.write(datos_video)

    gid = E.crear(request.form.get("nombre") or (audio.filename or "entrevista"),
                  pid, u["id"], duracion,
                  int(request.form.get("origenBytes") or 0), len(datos_audio))

    contexto = ""
    if pid:
        pr = D.row("SELECT nombre, area FROM procesos WHERE id=?", (pid,))
        if pr:
            contexto = f"La entrevista es sobre el proceso «{pr['nombre']}» del área {pr['area'] or 'sin área'}."

    E.procesar_en_segundo_plano(gid, ruta_audio, ruta_video, contexto)
    auditar("grabacion_subida", "grabacion", gid,
            f"{len(datos_audio)//1024} KB de audio" + (", con video" if ruta_video else ""))

    return jsonify({"ok": True, "id": gid, "conVideo": bool(ruta_video),
                    "grabacion": E.leer(gid)})


@api.post("/grabaciones/subir/iniciar")
@puede_editar
def subir_iniciar():
    """Abre una subida por trozos. Funciona desde cualquier navegador."""
    d = request.get_json(silent=True) or {}
    u = usuario_actual()

    pid = (d.get("proceso") or "").strip() or None
    if pid:
        p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
        if not p:
            return jsonify({"error": "proceso_no_existe"}), 404
        if not _mio(p, u):
            return jsonify({"error": "no_es_tuyo"}), 403

    if not TR.proveedor_activo():
        return jsonify({"error": "sin_llave_voz"}), 422

    SUB.limpiar_viejas()
    try:
        gid = E.crear(d.get("nombre") or "entrevista", pid, u["id"],
                      int(d.get("duracion") or 0), int(d.get("bytes") or 0), 0)
    except Exception as e:
        # Un fallo aquí llegaba al navegador como un 500 sin texto, y la
        # app solo podía decir «no se pudo empezar». Mejor decir qué fue.
        current_app.logger.exception("no se pudo abrir la grabación")
        return jsonify({"error": "no_se_pudo_registrar",
                        "detalle": f"La base rechazó la grabación: {str(e)[:200]}"}), 500
    try:
        info = SUB.iniciar(gid, d.get("nombre") or "", d.get("bytes") or 0)
    except SUB.SubidaError as e:
        D.execute("DELETE FROM grabaciones WHERE id=?", (gid,))
        return jsonify({"error": e.codigo, "detalle": e.detalle}), 422
    except Exception as e:
        D.execute("DELETE FROM grabaciones WHERE id=?", (gid,))
        current_app.logger.exception("no se pudo preparar el archivo de subida")
        return jsonify({"error": "no_se_pudo_preparar",
                        "detalle": f"El servidor no pudo abrir el archivo: "
                                   f"{str(e)[:200]}"}), 500

    auditar("subida_iniciada", "grabacion", gid,
            f"{int(d.get('bytes') or 0) // (1024*1024)} MB")
    return jsonify({"ok": True, "id": gid, **info})


@api.get("/grabaciones/<gid>/subir")
@puede_editar
def subir_estado(gid):
    """Cuántos bytes hay ya: con esto el navegador sabe desde dónde seguir."""
    g = E.leer(gid)
    if not g:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if u["rol"] != "admin" and g["subidoPor"] != u["id"]:
        return jsonify({"error": "sin_permiso"}), 403
    est = SUB.estado(gid)
    if not est:
        return jsonify({"error": "no_existe"}), 404
    return jsonify(est)


@api.post("/grabaciones/<gid>/subir")
@puede_editar
def subir_trozo(gid):
    g = E.leer(gid)
    if not g:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if u["rol"] != "admin" and g["subidoPor"] != u["id"]:
        return jsonify({"error": "sin_permiso"}), 403

    datos = request.get_data()
    if not datos:
        return jsonify({"error": "trozo_vacio"}), 400

    try:
        desde = int(request.headers.get("X-Desde") or request.args.get("desde") or 0)
        r = SUB.recibir_trozo(gid, desde, datos)
    except SUB.SubidaError as e:
        # El desfase no es un fallo: el navegador reintentó algo que ya
        # había llegado. Se le dice dónde va de verdad y sigue solo.
        if e.codigo == "desfasado":
            est = SUB.estado(gid) or {}
            return jsonify({"error": e.codigo, "detalle": e.detalle, **est}), 409
        return jsonify({"error": e.codigo, "detalle": e.detalle}), 422
    return jsonify({"ok": True, **r})


@api.post("/grabaciones/<gid>/subir/terminar")
@puede_editar
def subir_terminar(gid):
    """El archivo llegó completo: se le saca la voz y se manda a analizar."""
    g = E.leer(gid)
    if not g:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if u["rol"] != "admin" and g["subidoPor"] != u["id"]:
        return jsonify({"error": "sin_permiso"}), 403
    payload, code = _cerrar_subida(gid, g)
    return jsonify(payload), code


def _cerrar_subida(gid, g):
    """Lo que pasa cuando el archivo ya llegó entero.

    Está aparte porque entran por aquí dos caminos: la app con sesión y el
    enlace del celular, que no la tiene. Si fueran dos copias, un arreglo
    en una dejaría la otra rota.
    """
    f = D.row("SELECT ruta_video FROM grabaciones WHERE id=?", (gid,))
    ruta = f["ruta_video"] if f else None
    if not ruta or not os.path.exists(ruta):
        return {"error": "sin_video"}, 422

    try:
        datos = V.info(ruta)
    except Exception as e:
        SUB.cancelar(gid)
        D.execute("UPDATE grabaciones SET estado='error', error=? WHERE id=?",
                  (f"video_ilegible: {e}", gid))
        return {"error": "video_ilegible",
                "detalle": "El archivo llegó incompleto o el formato no se "
                           "puede leer. Vuelve a subirlo."}, 422

    if not datos["tiene_audio"]:
        SUB.cancelar(gid)
        D.execute("UPDATE grabaciones SET estado='error', error=? WHERE id=?",
                  ("sin_voz: el archivo no trae audio", gid))
        return {"error": "sin_audio",
                "detalle": "El archivo no trae pista de audio. Sin voz no "
                           "hay nada que transcribir."}, 422

    # La voz se saca en segundo plano: con seis gigas, ffmpeg tarda más de
    # los 120 segundos que gunicorn le da a una petición, y el trabajador
    # moría a medio camino dejando la entrevista colgada.
    D.execute("UPDATE grabaciones SET duracion=?, ruta_video=NULL WHERE id=?",
              (int(datos["segundos"]), gid))
    # Si lo que subieron ya es audio, no hay nada que extraer ni fotogramas
    # que sacar: se manda derecho a transcribir. Lo decide el archivo, no
    # su nombre, porque un .mp4 puede traer solo voz y un .m4a mal
    # nombrado puede traer imagen.
    solo_voz = not datos["tiene_video"]

    contexto = ""
    if g["procesoId"]:
        pr = D.row("SELECT nombre, area FROM procesos WHERE id=?", (g["procesoId"],))
        if pr:
            nom, area = pr["nombre"], pr["area"] or "sin área"
            contexto = (f"La entrevista es sobre el proceso «{nom}» "
                        f"del área {area}.")

    if solo_voz:
        D.execute("UPDATE grabaciones SET audio_bytes=? WHERE id=?",
                  (os.path.getsize(ruta), gid))
        # El archivo subido ES el audio: se transcribe tal cual y se borra
        # al terminar, igual que uno extraído.
        E.procesar_en_segundo_plano(gid, ruta, None, contexto)
    else:
        # El video se procesa y se borra en el mismo paso: lo que vale son
        # los 28 MB de voz y las pocas imágenes, no los seis gigas.
        E.desde_video_en_segundo_plano(gid, ruta, contexto)
    auditar("subida_terminada", "grabacion", gid,
            f"{int(datos['segundos'])//60} min" + (" (solo voz)" if solo_voz else ""))
    return {"ok": True, "soloVoz": solo_voz, "grabacion": E.leer(gid)}, 200


# ── Subir desde el celular, sin iniciar sesión ─────────────────────────────
#
# La forma más sencilla que encontré: el mismo enlace con QR que ya se usa
# para la evidencia. Se abre la cámara del celular sobre el código, se
# escoge el video de la galería y listo. No hay que instalar nada, ni
# recordar la contraseña en un teclado de celular, ni pasar el video al
# computador primero.
#
# El enlace es la credencial y caduca solo, igual que el de captura. Se
# marca con este campo para no confundirlo con los de evidencia.
MARCA_ENTREVISTA = "__entrevista__"


@api.post("/grabaciones/enlace-celular")
@puede_editar
def enlace_celular():
    u = usuario_actual()
    d = request.get_json(silent=True) or {}
    pid = (d.get("proceso") or "").strip()
    if pid:
        p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
        if not p:
            return jsonify({"error": "proceso_no_existe"}), 404
        if not _mio(p, u):
            return jsonify({"error": "no_es_tuyo"}), 403

    # Un enlace vigente por persona y proceso: pedirlo otra vez reemplaza
    # el anterior, para que no queden enlaces viejos dando vueltas.
    D.execute("UPDATE capture_tokens SET activo=? WHERE campo_id=? AND creado_por=? "
              "AND proceso_id=?",
              (False if D.USE_PG else 0, MARCA_ENTREVISTA, u["id"], pid or "-"))

    token = secrets.token_urlsafe(24)
    expira = (datetime.utcnow() + timedelta(hours=HORAS_TOKEN)).isoformat(timespec="seconds")
    D.execute(
        "INSERT INTO capture_tokens (token, proceso_id, campo_id, creado_por, expira, "
        "activo) VALUES (?,?,?,?,?,?)",
        (token, pid or "-", MARCA_ENTREVISTA, u["id"], expira, True if D.USE_PG else 1))
    auditar("enlace_celular_creado", "grabacion", None, pid or "sin proceso")

    url = request.host_url.rstrip("/") + "/e/" + token
    return jsonify({"ok": True, "url": url, "qr": _qr_svg(url), "horas": HORAS_TOKEN,
                    "expira": expira + "Z"})


def _token_entrevista(token):
    t = _token_valido(token)
    if not t or (t["campo_id"] or "") != MARCA_ENTREVISTA:
        return None
    return t


@api.get("/entrevista/<token>")
def entrevista_info(token):
    t = _token_entrevista(token)
    if not t:
        return jsonify({"error": "enlace_vencido"}), 410
    pid = t["proceso_id"] if t["proceso_id"] != "-" else ""
    p = D.row("SELECT codigo, nombre FROM procesos WHERE id=?", (pid,)) if pid else None
    quien = D.row("SELECT nombre FROM usuarios WHERE id=?", (t["creado_por"],))
    return jsonify({"ok": True,
                    "proceso": (f"{p['codigo']} · {p['nombre']}" if p and p["codigo"]
                                else (p["nombre"] if p else "")),
                    "de": quien["nombre"] if quien else "",
                    "trozo": SUB.TROZO,
                    "sinLlave": not TR.proveedor_activo()})


@api.post("/entrevista/<token>/iniciar")
def entrevista_iniciar(token):
    t = _token_entrevista(token)
    if not t:
        return jsonify({"error": "enlace_vencido"}), 410
    if not TR.proveedor_activo():
        return jsonify({"error": "sin_llave_voz"}), 422

    d = request.get_json(silent=True) or {}
    pid = t["proceso_id"] if t["proceso_id"] != "-" else None
    SUB.limpiar_viejas()
    gid = E.crear(d.get("nombre") or "entrevista", pid, t["creado_por"],
                  0, int(d.get("bytes") or 0), 0)
    try:
        info = SUB.iniciar(gid, d.get("nombre") or "", d.get("bytes") or 0)
    except SUB.SubidaError as e:
        D.execute("DELETE FROM grabaciones WHERE id=?", (gid,))
        return jsonify({"error": e.codigo, "detalle": e.detalle}), 422
    except Exception as e:
        D.execute("DELETE FROM grabaciones WHERE id=?", (gid,))
        current_app.logger.exception("celular: no se pudo preparar la subida")
        return jsonify({"error": "no_se_pudo_preparar", "detalle": str(e)[:200]}), 500

    # Queda marcada con el enlace que la subió: el enlace solo podrá
    # tocar las suyas.
    D.execute("UPDATE grabaciones SET subido_con=? WHERE id=?", (token, gid))
    D.execute("UPDATE capture_tokens SET usos=COALESCE(usos,0)+1 WHERE token=?", (token,))
    auditar("subida_desde_celular", "grabacion", gid,
            f"{int(d.get('bytes') or 0) // (1024*1024)} MB")
    return jsonify({"ok": True, "id": gid, **info})


def _grabacion_del_token(t, gid):
    """Que el enlace solo pueda tocar lo que él mismo empezó.

    No basta con que sea de la misma persona: con el enlace en la mano,
    cualquiera podría entonces leer o pisar las demás entrevistas de ella.
    Se compara el enlace con el que quedó marcado al crearla.
    """
    f = D.row("SELECT subido_con FROM grabaciones WHERE id=?", (gid,))
    if not f or (f["subido_con"] or "") != t["token"]:
        return None
    return E.leer(gid)


@api.get("/entrevista/<token>/<gid>")
def entrevista_estado(token, gid):
    t = _token_entrevista(token)
    if not t or not _grabacion_del_token(t, gid):
        return jsonify({"error": "enlace_vencido"}), 410
    return jsonify(SUB.estado(gid) or {"error": "no_existe"})


@api.post("/entrevista/<token>/<gid>")
def entrevista_trozo(token, gid):
    t = _token_entrevista(token)
    if not t or not _grabacion_del_token(t, gid):
        return jsonify({"error": "enlace_vencido"}), 410
    datos = request.get_data()
    if not datos:
        return jsonify({"error": "trozo_vacio"}), 400
    try:
        desde = int(request.headers.get("X-Desde") or 0)
        r = SUB.recibir_trozo(gid, desde, datos)
    except SUB.SubidaError as e:
        if e.codigo == "desfasado":
            return jsonify({"error": e.codigo, **(SUB.estado(gid) or {})}), 409
        return jsonify({"error": e.codigo, "detalle": e.detalle}), 422
    return jsonify({"ok": True, **r})


@api.post("/entrevista/<token>/<gid>/terminar")
def entrevista_terminar(token, gid):
    t = _token_entrevista(token)
    g = _grabacion_del_token(t, gid) if t else None
    if not g:
        return jsonify({"error": "enlace_vencido"}), 410
    payload, code = _cerrar_subida(gid, g)
    return jsonify(payload), code


@api.delete("/grabaciones/<gid>/subir")
@puede_editar
def subir_cancelar(gid):
    g = E.leer(gid)
    if not g:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if u["rol"] != "admin" and g["subidoPor"] != u["id"]:
        return jsonify({"error": "sin_permiso"}), 403
    SUB.cancelar(gid)
    D.execute("DELETE FROM grabaciones WHERE id=?", (gid,))
    return jsonify({"ok": True})


@api.post("/procesos/<pid>/repartir-fotos")
@puede_editar
def repartir_fotos(pid):
    """Lleva a su actividad las fotos que quedaron en el cajón general.

    Sirve para arreglar lo que ya está: las entrevistas volcadas antes de
    que la app supiera deducir el paso por el minuto dejaron sus fotos
    sueltas. El minuto sigue guardado en la entrevista, así que se puede
    recuperar sin volver a subir nada.
    """
    p = D.row("SELECT id, responsable_id, respuestas FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if not _mio(p, u):
        return jsonify({"error": "no_es_tuyo"}), 403

    pasos = D.jload(p["respuestas"], {}).get("f_pasos") or []
    if not pasos:
        return jsonify({"ok": True, "movidas": 0, "detalle": "El proceso no tiene actividades."})

    # El minuto de cada foto: está en los momentos de las entrevistas de
    # este proceso, indexado por la imagen que se guardó.
    minuto_de = {}
    for f in D.rows("SELECT id FROM grabaciones WHERE proceso_id=?", (pid,)):
        for m in (E.leer(f["id"]) or {}).get("momentos") or []:
            if m.get("mediaId"):
                minuto_de[m["mediaId"]] = m.get("segundo")

    movidas, sin_minuto = 0, 0
    for e in D.rows("SELECT id, media_id FROM evidencias WHERE proceso_id=? "
                    "AND campo_id='f_pasos' AND tipo='foto'", (pid,)):
        seg = minuto_de.get(e["media_id"])
        if seg is None:
            sin_minuto += 1
            continue
        n = E._paso_del_minuto(pasos, seg)
        if not n:
            sin_minuto += 1
            continue
        D.execute("UPDATE evidencias SET campo_id=? WHERE id=?",
                  (f"f_pasos:{n - 1}", e["id"]))
        movidas += 1

    if movidas:
        auditar("fotos_repartidas", "proceso", pid, f"{movidas} fotos")
    return jsonify({"ok": True, "movidas": movidas, "sinMinuto": sin_minuto})


@api.get("/procesos/<pid>/entrevistas")
@login_required
def entrevistas_del_proceso(pid):
    """Las entrevistas que alimentan este proceso, en orden de visita.

    Un proceso se levanta en varias visitas: hace falta poder ver cuáles
    ya entraron, cuáles están a medio revisar, y qué actividades trajo
    cada una.
    """
    filas = D.rows("SELECT id FROM grabaciones WHERE proceso_id=? ORDER BY creado",
                   (pid,))
    gs = []
    for f in filas:
        g = E.leer(f["id"])
        g["transcripcion"] = []
        g["momentos"] = []
        gs.append({k: g[k] for k in ("id", "nombre", "estado", "duracion", "volcada",
                                     "volcadaEn", "creado", "subidoPor")}
                  | {"titulo": (g.get("analisis") or {}).get("titulo", ""),
                     "pasos": len(((g.get("analisis") or {}).get("pasos") or []))})
    return jsonify({"entrevistas": gs})


@api.get("/grabaciones")
@login_required
def listar_grabaciones():
    u = usuario_actual()
    solo = None if u["rol"] in ("admin", "clinica", "lector") else u["id"]
    return jsonify({"grabaciones": E.listar(solo)})


@api.get("/grabaciones/<gid>")
@login_required
def leer_grabacion(gid):
    g = E.leer(gid)
    if not g:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if u["rol"] not in ("admin", "clinica", "lector") and g["subidoPor"] != u["id"]:
        return jsonify({"error": "sin_permiso"}), 403
    return jsonify({"grabacion": g})


@api.post("/grabaciones/<gid>/momentos/<int:n>")
@puede_editar
def revisar_momento_api(gid, n):
    """Aprobar, descartar o cambiar de toma."""
    g = E.leer(gid)
    if not g:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if u["rol"] != "admin" and g["subidoPor"] != u["id"]:
        return jsonify({"error": "sin_permiso"}), 403

    d = request.get_json(silent=True) or {}
    r = E.revisar_momento(gid, n, d.get("decision"), d.get("mediaId"))
    if r.get("error"):
        return jsonify(r), 404
    return jsonify(r)


@api.put("/grabaciones/<gid>/pasos")
@puede_editar
def guardar_pasos_api(gid):
    """Los pasos corregidos a mano antes de volcarlos."""
    g = E.leer(gid)
    if not g:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if u["rol"] != "admin" and g["subidoPor"] != u["id"]:
        return jsonify({"error": "sin_permiso"}), 403

    d = request.get_json(silent=True) or {}
    r = E.guardar_pasos(gid, d.get("pasos"))
    if r.get("error"):
        return jsonify(r), 400
    return jsonify(r)


@api.post("/grabaciones/<gid>/proceso")
@puede_editar
def relacionar_grabacion(gid):
    """Guardar sin enviar: deja anotado a qué proceso va."""
    g = E.leer(gid)
    if not g:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if u["rol"] != "admin" and g["subidoPor"] != u["id"]:
        return jsonify({"error": "sin_permiso"}), 403

    pid = (request.get_json(silent=True) or {}).get("proceso") or ""
    pid = pid.strip()
    if pid:
        p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
        if not p:
            return jsonify({"error": "proceso_no_existe"}), 404
        if not _mio(p, u):
            return jsonify({"error": "no_es_tuyo"}), 403

    r = E.relacionar(gid, pid)
    if r.get("error"):
        return jsonify(r), 422
    auditar("grabacion_relacionada", "grabacion", gid, pid or "sin proceso")
    return jsonify({**r, "grabacion": E.leer(gid)})


@api.post("/grabaciones/<gid>/fotos")
@puede_editar
def fotos_de_entrevista(gid):
    """Las fotos que tomaron durante la entrevista, junto al audio.

    Van numeradas en el orden en que llegan, que es el orden en que las
    tomaron: para una foto sin video, ese orden es casi toda la pista que
    hay de a qué paso pertenece.
    """
    g = E.leer(gid)
    if not g:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if u["rol"] != "admin" and g["subidoPor"] != u["id"]:
        return jsonify({"error": "sin_permiso"}), 403

    archivos = request.files.getlist("fotos") or request.files.getlist("archivo")
    if not archivos:
        return jsonify({"error": "sin_archivos"}), 400

    f = D.row("SELECT fotos FROM grabaciones WHERE id=?", (gid,))
    ya = D.jload(f["fotos"], []) if f else []
    rechazadas = []
    for a in archivos[:60]:
        datos = a.read()
        if not datos:
            continue
        if len(datos) > MAX_MEDIA:
            rechazadas.append({"nombre": a.filename, "por_que": "muy pesada"})
            continue
        ctype = (a.mimetype or "").split(";")[0].strip()
        if not ctype.startswith("image/"):
            rechazadas.append({"nombre": a.filename, "por_que": "no es una imagen"})
            continue
        datos, ctype = _achicar_si_hace_falta(datos, ctype)
        mid = _guardar_media_bytes(None, datos, ctype, a.filename or "foto")
        ya.append({"mediaId": mid, "nombre": (a.filename or "")[:200]})

    D.execute("UPDATE grabaciones SET fotos=? WHERE id=?", (D.jdump(ya), gid))
    auditar("fotos_de_entrevista", "grabacion", gid, f"{len(ya)} en total")
    return jsonify({"ok": True, "total": len(ya), "rechazadas": rechazadas})


@api.post("/grabaciones/<gid>/momentos/<int:n>/imagen")
@puede_editar
def imagen_de_momento(gid, n):
    """Sube una foto propia para un momento, en vez de la del video."""
    g = E.leer(gid)
    if not g:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if u["rol"] != "admin" and g["subidoPor"] != u["id"]:
        return jsonify({"error": "sin_permiso"}), 403

    f = request.files.get("archivo")
    if not f:
        return jsonify({"error": "sin_archivo"}), 400
    datos = f.read()
    if not datos:
        return jsonify({"error": "archivo_vacio"}), 400
    if len(datos) > MAX_MEDIA:
        return jsonify({"error": "archivo_muy_grande",
                        "max_mb": MAX_MEDIA // (1024 * 1024)}), 413
    ctype = (f.mimetype or "").split(";")[0].strip()
    if not ctype.startswith("image/"):
        return jsonify({"error": "tiene_que_ser_imagen",
                        "detalle": "Sube una foto o un pantallazo."}), 415

    mid = _guardar_media_bytes(None, datos, ctype, f.filename or "foto")
    r = E.imagen_propia(gid, n, mid)
    if r.get("error"):
        return jsonify(r), 404
    auditar("momento_con_foto_propia", "grabacion", gid, f"momento {n}")
    return jsonify(r)


@api.post("/grabaciones/<gid>/a-proceso")
@puede_editar
def volcar_grabacion(gid):
    d = request.get_json(silent=True) or {}
    pid = (d.get("proceso") or "").strip()
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "proceso_no_existe"}), 404
    u = usuario_actual()
    if not _mio(p, u):
        return jsonify({"error": "no_es_tuyo"}), 403

    _guardar_version(pid, u["id"], "antes de volcar la entrevista grabada")
    pos = d.get("posicion")
    r = E.a_proceso(gid, pid, u["id"], llenar_campos=d.get("llenarCampos", True),
                    posicion=(None if pos in (None, "", "final") else pos))
    if r.get("error"):
        if r["error"] == "ya_volcada":
            return jsonify({**r, "detalle": "Esta entrevista ya entró en un "
                                            "proceso. Volcarla otra vez "
                                            "duplicaría los pasos."}), 409
        return jsonify(r), 422
    auditar("grabacion_volcada", "proceso", pid, f"{r['pasos']} pasos, {r['fotos']} fotos")
    return jsonify(r)


@api.delete("/grabaciones/<gid>")
@puede_editar
def borrar_grabacion(gid):
    g = E.leer(gid)
    if not g:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if u["rol"] != "admin" and g["subidoPor"] != u["id"]:
        return jsonify({"error": "sin_permiso"}), 403
    # Si era un video a medio subir, el pedazo sigue en el disco. Borrar
    # la fila sin borrarlo dejaría los gigas ocupados sin que nada los
    # reclame.
    SUB.cancelar(gid)
    D.execute("DELETE FROM grabaciones WHERE id=?", (gid,))
    auditar("grabacion_borrada", "grabacion", gid)
    return jsonify({"ok": True})


@api.get("/indice")
@login_required
def indice_procesos():
    """Nombres de todos los procesos, sin su contenido.

    Sirve para enlazar unos con otros: un analista necesita poder decir
    'esto viene de Admisiones' aunque ese proceso sea de otra persona.
    """
    ps = D.rows("SELECT id, codigo, nombre, area, responsable_id, estado "
                "FROM procesos WHERE COALESCE(eliminado,0)=0 ORDER BY codigo, nombre")
    return jsonify({"procesos": [
        {"id": p["id"], "codigo": p["codigo"], "nombre": p["nombre"],
         "area": p["area"], "responsable": p["responsable_id"], "estado": p["estado"]}
        for p in ps]})


@api.get("/mapa")
@login_required
def mapa_conexiones():
    """Qué proceso alimenta a cuál, según lo que cada quien declaró."""
    ps = D.rows("SELECT id, codigo, nombre, area, estado, responsable_id, respuestas "
                "FROM procesos WHERE COALESCE(eliminado,0)=0")
    nodos, enlaces = [], []
    por_id = {p["id"]: p for p in ps}

    for p in ps:
        r = D.jload(p["respuestas"], {})
        nodos.append({"id": p["id"], "codigo": p["codigo"], "nombre": p["nombre"],
                      "area": p["area"], "estado": p["estado"]})
        for otro in (r.get("f_viene_de") or []):
            if otro in por_id:
                enlaces.append({"de": otro, "a": p["id"]})
        for otro in (r.get("f_va_hacia") or []):
            if otro in por_id:
                enlaces.append({"de": p["id"], "a": otro})

    # Un mismo enlace declarado por los dos lados cuenta una sola vez.
    vistos, limpios = set(), []
    for e in enlaces:
        clave = (e["de"], e["a"])
        if clave not in vistos:
            vistos.add(clave)
            limpios.append(e)

    sueltos = [n["id"] for n in nodos
               if not any(e["de"] == n["id"] or e["a"] == n["id"] for e in limpios)]
    return jsonify({"nodos": nodos, "enlaces": limpios, "sueltos": sueltos})


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
            "estado": "estado", "prioridad": "prioridad", "notas": "notas",
            "contacto": "contacto"}
    # La fecha de entrega la fija quien reparte el trabajo.
    if "fechaLimite" in d and u["rol"] == "admin":
        mapa_extra = True
        campos_fecha = d.get("fechaLimite") or None
    else:
        campos_fecha = None
    campos, params = [], []
    for k, col in mapa.items():
        if k in d:
            campos.append(f"{col}=?")
            params.append(d[k])
    # Reasignar y poner fecha de entrega son potestad del administrador.
    if "responsable" in d and u["rol"] == "admin":
        campos.append("responsable_id=?")
        params.append(d["responsable"] or None)
    if "fechaLimite" in d and u["rol"] == "admin":
        campos.append("fecha_limite=?")
        params.append(campos_fecha)
    if "respuestas" in d:
        nuevas = limpiar_respuestas(d["respuestas"] or {})
        _guardar_version(pid, u["id"], "edición")
        campos.append("respuestas=?")
        params.append(D.jdump(nuevas))

    campos.append("actualizado_por=?")
    params.append(u["id"])

    sql = (f"UPDATE procesos SET {', '.join(campos)}, "
           f"actualizado={D.NOW} WHERE id=?")
    D.execute(sql, tuple(params) + (pid,))
    return jsonify({"ok": True})


@api.delete("/procesos/<pid>")
@puede_editar
def borrar_proceso(pid):
    """No borra: archiva. Nada de lo que alguien trabajó se destruye por un
    clic mal dado; el administrador siempre lo puede recuperar."""
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if not _mio(p, u):
        return jsonify({"error": "no_es_tuyo"}), 403

    _guardar_version(pid, u["id"], "antes de archivar")
    D.execute("UPDATE procesos SET eliminado=1 WHERE id=?", (pid,))
    auditar("proceso_archivado", "proceso", pid)
    return jsonify({"ok": True, "archivado": True})


@api.get("/papelera")
@rol_required("admin")
def papelera():
    ps = D.rows("SELECT id, codigo, nombre, area, responsable_id, actualizado "
                "FROM procesos WHERE COALESCE(eliminado,0)=1 ORDER BY actualizado DESC")
    return jsonify({"procesos": [
        {"id": p["id"], "codigo": p["codigo"], "nombre": p["nombre"], "area": p["area"],
         "responsable": p["responsable_id"], "actualizado": str(p["actualizado"])}
        for p in ps]})


@api.post("/procesos/<pid>/restaurar")
@rol_required("admin")
def restaurar_proceso(pid):
    D.execute("UPDATE procesos SET eliminado=0 WHERE id=?", (pid,))
    auditar("proceso_restaurado", "proceso", pid)
    return jsonify({"ok": True})


def _guardar_version(pid, uid, motivo):
    """Guarda cómo estaba el proceso ANTES de este cambio.

    Se conservan las últimas 40 versiones de cada proceso. Suficiente para
    deshacer un borrado accidental sin llenar la base de historia inútil.
    """
    actual = D.row("SELECT respuestas, nombre FROM procesos WHERE id=?", (pid,))
    if not actual:
        return
    ultima = D.row("SELECT respuestas FROM versiones WHERE proceso_id=? "
                   "ORDER BY creado DESC LIMIT 1", (pid,))
    if ultima and ultima["respuestas"] == actual["respuestas"]:
        return                      # nada cambió: no se guarda otra copia igual

    D.execute("INSERT INTO versiones (id, proceso_id, respuestas, nombre, usuario_id, motivo, creado) "
              "VALUES (?,?,?,?,?,?,?)",
              (_nuevo_id("v_"), pid, actual["respuestas"], actual["nombre"], uid, motivo,
               datetime.utcnow().isoformat(timespec="microseconds")))

    viejas = D.rows("SELECT id FROM versiones WHERE proceso_id=? ORDER BY creado DESC", (pid,))
    for v in viejas[40:]:
        D.execute("DELETE FROM versiones WHERE id=?", (v["id"],))


@api.get("/procesos/<pid>/versiones")
@puede_editar
def listar_versiones(pid):
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p or not _mio(p, usuario_actual()):
        return jsonify({"error": "no_es_tuyo"}), 403
    nombres = {u["id"]: u["nombre"] for u in D.rows("SELECT id, nombre FROM usuarios")}
    vs = D.rows("SELECT id, nombre, usuario_id, motivo, creado FROM versiones "
                "WHERE proceso_id=? ORDER BY creado DESC", (pid,))
    return jsonify({"versiones": [
        {"id": v["id"], "nombre": v["nombre"], "motivo": v["motivo"],
         "por": nombres.get(v["usuario_id"], ""), "creado": str(v["creado"])}
        for v in vs]})


@api.post("/procesos/<pid>/versiones/<vid>/restaurar")
@puede_editar
def restaurar_version(pid, vid):
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p or not _mio(p, usuario_actual()):
        return jsonify({"error": "no_es_tuyo"}), 403
    v = D.row("SELECT respuestas FROM versiones WHERE id=? AND proceso_id=?", (vid, pid))
    if not v:
        return jsonify({"error": "no_existe"}), 404

    u = usuario_actual()
    _guardar_version(pid, u["id"], "antes de restaurar")
    D.execute(f"UPDATE procesos SET respuestas=?, actualizado={D.NOW} WHERE id=?",
              (v["respuestas"], pid))
    auditar("version_restaurada", "proceso", pid, vid)
    return jsonify({"ok": True})


# ═══════════════════════════════════════════════════════════════════════════
# Evidencias (fotos y audios)
# ═══════════════════════════════════════════════════════════════════════════

# Por encima de esto, una foto se guarda achicada. El navegador ya las
# manda pequeñas, pero esto cubre lo que llegue de otro sitio: el celular
# por el enlace, un cliente viejo, un HEIC que el navegador no supo abrir.
TOPE_FOTO = int(os.environ.get("TOPE_FOTO_KB", "400")) * 1024
ANCHO_FOTO = 1600


def _achicar_si_hace_falta(datos, ctype):
    """Una foto de cuatro mil píxeles no se lee mejor que una de mil
    seiscientos, pero ocupa cinco veces más en la base y en la memoria.

    Guardar las grandes fue lo que hizo que el servidor se quedara sin
    memoria con cincuenta fotos. Si algo sale mal, se guarda la original:
    una foto pesada es mejor que ninguna.
    """
    if len(datos) <= TOPE_FOTO or not ctype.startswith("image/"):
        return datos, ctype
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(datos))
        im.load()
        if im.width > ANCHO_FOTO:
            alto = round(im.height * ANCHO_FOTO / im.width)
            im = im.resize((ANCHO_FOTO, alto), Image.LANCZOS)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=82, optimize=True)
        chico = buf.getvalue()
        if chico and len(chico) < len(datos):
            return chico, "image/jpeg"
    except Exception as e:
        print("[media] no se pudo achicar:", str(e)[:120])
    return datos, ctype


def _guardar_media_bytes(pid, datos, ctype, nombre=""):
    """Guarda un archivo que no vino de una subida, como un fotograma
    sacado de un video. Devuelve su id, o el del que ya estaba si es
    idéntico: reprocesar un video no debe duplicar las fotos."""
    firma = hashlib.sha1(datos).hexdigest()
    previo = D.row("SELECT id FROM media WHERE sha1=? AND proceso_id IS ?", (firma, pid))
    if previo:
        return previo["id"]

    mid = _nuevo_id("m_")
    if MEDIA_DIR:
        os.makedirs(MEDIA_DIR, exist_ok=True)
        ruta = os.path.join(MEDIA_DIR, mid)
        with open(ruta, "wb") as fh:
            fh.write(datos)
        D.execute(
            "INSERT INTO media (id, proceso_id, content_type, tamano, nombre, ruta, sha1) "
            "VALUES (?,?,?,?,?,?,?)",
            (mid, pid, ctype, len(datos), nombre, ruta, firma))
    else:
        D.execute(
            "INSERT INTO media (id, proceso_id, content_type, tamano, nombre, data, sha1) "
            "VALUES (?,?,?,?,?,?,?)",
            (mid, pid, ctype, len(datos), nombre, D.binary(datos), firma))
    return mid


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

    # Un PDF entraba marcado como audio, porque solo se distinguía foto de
    # «todo lo demás». En pantalla salía con un reproductor que no sonaba.
    tipo = form.get("tipo") or _clase_de(ctype)
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


@api.post("/procesos/<pid>/evidencias/lote")
@puede_editar
def subir_evidencias_lote(pid):
    """Varias fotos de un golpe, para el mismo sitio.

    El navegador las manda por tandas pequeñas: quinientas fotos no caben
    en una sola petición ni de lejos, y partirlas aquí permite además
    mostrar cuánto va subido en vez de dejar a alguien mirando una
    pantalla quieta durante diez minutos.
    """
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if not _mio(p, u):
        return jsonify({"error": "no_es_tuyo"}), 403

    archivos = request.files.getlist("fotos")
    if not archivos:
        return jsonify({"error": "sin_archivos"}), 400

    campo = (request.form.get("campo") or "").strip()
    # El orden de llegada se conserva: quien sube quinientas fotos las
    # tiene ordenadas en una carpeta, y ese orden es información.
    base = D.row("SELECT COALESCE(MAX(orden),0) m FROM evidencias WHERE proceso_id=?",
                 (pid,))["m"] or 0

    puestas, rechazadas = [], []
    for i, a in enumerate(archivos[:40], 1):
        datos = a.read()
        if not datos:
            continue
        if len(datos) > MAX_MEDIA:
            rechazadas.append({"nombre": a.filename, "por_que": "muy pesada"})
            continue
        ctype = (a.mimetype or "").split(";")[0].strip()
        if not ctype.startswith("image/"):
            rechazadas.append({"nombre": a.filename, "por_que": "no es una imagen"})
            continue
        datos, ctype = _achicar_si_hace_falta(datos, ctype)
        mid = _guardar_media_bytes(pid, datos, ctype, a.filename or "foto")
        eid = _nuevo_id("e_")
        D.execute(
            "INSERT INTO evidencias (id, proceso_id, campo_id, tipo, media_id, nota, "
            "autor_id, origen, orden) VALUES (?,?,?,?,?,?,?,?,?)",
            (eid, pid, campo, "foto", mid, (a.filename or "")[:200], u["id"],
             "lote", base + i))
        puestas.append({"id": eid, "mediaId": mid, "campo": campo,
                        "nombre": a.filename or ""})

    if puestas:
        auditar("fotos_en_lote", "proceso", pid, f"{len(puestas)} fotos")
    return jsonify({"ok": True, "puestas": puestas, "rechazadas": rechazadas})


@api.post("/procesos/<pid>/adjuntos/zip")
@puede_editar
def subir_zip(pid):
    """Una carpeta comprimida entera: cincuenta y ocho consentimientos.

    Es como llegan de verdad: alguien los manda por correo en un .zip y
    volver a escogerlos uno por uno es media hora de clics. Se abre aquí,
    se guarda cada archivo por separado y se devuelve la lista para que
    quien sube vea qué entró y qué no.
    """
    import zipfile

    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404
    u = usuario_actual()
    if not _mio(p, u):
        return jsonify({"error": "no_es_tuyo"}), 403

    f = request.files.get("archivo")
    if not f:
        return jsonify({"error": "sin_archivo"}), 400

    campo = (request.form.get("campo") or "").strip()
    try:
        # Se lee del archivo temporal que ya hizo el servidor, no de la
        # memoria: un zip de cincuenta megas cargado entero es justo lo
        # que tumbó el contenedor con las fotos.
        f.stream.seek(0)
        z = zipfile.ZipFile(f.stream)
    except Exception:
        return jsonify({"error": "no_es_zip",
                        "detalle": "El archivo no es una carpeta comprimida "
                                   "que se pueda abrir."}), 415

    base = D.row("SELECT COALESCE(MAX(orden),0) m FROM evidencias WHERE proceso_id=?",
                 (pid,))["m"] or 0
    puestas, rechazadas = [], []
    total = 0

    for info in sorted(z.infolist(), key=lambda x: x.filename):
        if info.is_dir():
            continue
        nombre = os.path.basename(info.filename)
        # Lo que mete el Mac al comprimir, y los ocultos: no son del equipo.
        if not nombre or nombre.startswith(".") or "__MACOSX" in info.filename:
            continue
        if len(puestas) + len(rechazadas) >= 200:
            rechazadas.append({"nombre": nombre, "por_que": "el zip trae demasiados"})
            break
        if info.file_size > MAX_MEDIA:
            rechazadas.append({"nombre": nombre,
                               "por_que": f"pesa más de {MAX_MEDIA // (1024*1024)} MB"})
            continue
        # Un zip puede anunciar poco y traer gigas al descomprimirse. Se
        # corta antes de que eso tumbe el servidor.
        total += info.file_size
        if total > 300 * 1024 * 1024:
            rechazadas.append({"nombre": nombre, "por_que": "la carpeta es demasiado grande"})
            break

        ext = os.path.splitext(nombre)[1].lower()
        ctype = PORTIPO.get(ext, "")
        if ctype not in TIPOS_OK:
            rechazadas.append({"nombre": nombre,
                               "por_que": "no es un documento ni una imagen"})
            continue
        try:
            datos = z.read(info)
        except Exception:
            rechazadas.append({"nombre": nombre, "por_que": "no se pudo leer"})
            continue
        if not datos:
            continue

        datos, ctype = _achicar_si_hace_falta(datos, ctype)
        mid = _guardar_media_bytes(pid, datos, ctype, nombre)
        eid = _nuevo_id("e_")
        D.execute(
            "INSERT INTO evidencias (id, proceso_id, campo_id, tipo, media_id, nota, "
            "autor_id, origen, orden) VALUES (?,?,?,?,?,?,?,?,?)",
            (eid, pid, campo, _clase_de(ctype), mid, nombre[:200], u["id"],
             "zip", base + len(puestas) + 1))
        puestas.append({"id": eid, "mediaId": mid, "nombre": nombre,
                        "tipo": _clase_de(ctype)})

    if puestas:
        auditar("zip_desarmado", "proceso", pid,
                f"{len(puestas)} archivos de {f.filename}")
    return jsonify({"ok": True, "puestas": puestas, "rechazadas": rechazadas,
                    "archivo": f.filename or ""})


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


@api.put("/procesos/<pid>/evidencias/orden")
@puede_editar
def ordenar_evidencias(pid):
    """El orden de las fotos dentro de una actividad.

    Lo pone quien revisa arrastrando: el orden en que se subieron no es el
    orden en que se entiende el proceso, y la última foto tomada es a
    menudo la que va primero.
    """
    p = D.row("SELECT id, responsable_id FROM procesos WHERE id=?", (pid,))
    if not p:
        return jsonify({"error": "no_existe"}), 404
    if not _mio(p, usuario_actual()):
        return jsonify({"error": "no_es_tuyo"}), 403

    cuerpo = request.get_json(silent=True) or {}
    ids = cuerpo.get("ids")
    # Una lista vacía es válida —no hay nada que ordenar—, pero no mandarla
    # es un error de quien llama, y callarlo haría creer que se guardó.
    if not isinstance(ids, list):
        return jsonify({"error": "falta_la_lista",
                        "detalle": "Hay que mandar 'ids' con el orden."}), 400

    # Solo se reordena lo que es de este proceso: un id de otro proceso
    # en la lista no debe poder moverse desde aquí.
    mias = {f["id"] for f in D.rows("SELECT id FROM evidencias WHERE proceso_id=?",
                                    (pid,))}
    n = 0
    for i, eid in enumerate(ids[:300]):
        if eid in mias:
            D.execute("UPDATE evidencias SET orden=? WHERE id=?", (i + 1, eid))
            n += 1
    return jsonify({"ok": True, "ordenadas": n})


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

def _datauri(mid, reducir=True, tope=None):
    """Un archivo como texto embebible. Devuelve None si no cabe."""
    m = D.row("SELECT content_type, data, ruta, tamano FROM media WHERE id=?", (mid,))
    if not m:
        return None
    if m.get("ruta"):
        try:
            with open(m["ruta"], "rb") as fh:
                datos = fh.read()
        except OSError:
            return None
    else:
        datos = D.to_bytes(m["data"])
    if not datos:
        return None

    ctype = m["content_type"] or "application/octet-stream"
    if reducir and ctype.startswith("image/"):
        datos, ctype = ia.reducir_imagen(datos, ctype)
    if tope and len(datos) > tope:
        return None
    return f"data:{ctype};base64," + base64.b64encode(datos).decode("ascii")


# Cuánto audio se permite incrustar en un archivo que alguien va a guardar
# o mandar por correo. Pasado eso, el informe pesa más de lo que aguanta
# un adjunto y es mejor que esos audios se oigan en línea.
TOPE_AUDIO_TOTAL = 12 * 1024 * 1024


def datos_informe(token, embebido=False):
    """El informe que se abre con un enlace compartido."""
    t = D.row("SELECT * FROM share_tokens WHERE token=? AND activo", (token,))
    if not t:
        return None
    D.execute("UPDATE share_tokens SET vistas = vistas + 1 WHERE token=?", (token,))
    return datos_de_proceso(t["proceso_id"], embebido, token)


def datos_de_proceso(pid, embebido=False, token=None):
    """Lo mismo, pero por el id del proceso.

    Separado del enlace compartido porque hace falta para el paquete con
    todos los procesos: ahí no hay token que valer, y duplicar este armado
    habría dejado dos informes que se van pareciendo cada vez menos.
    """
    p = D.row("SELECT * FROM procesos WHERE id=?", (pid,))
    if not p:
        return None
    t = {"proceso_id": pid}
    # Sin token, las fotos solo pueden ir embebidas: no hay una dirección
    # pública por la que pedirlas después.
    if not token:
        embebido = True

    plantilla = D.jload(D.row("SELECT data FROM plantilla WHERE id=1")["data"], {})
    respuestas = D.jload(p["respuestas"], {})
    nombres = {u["id"]: u["nombre"] for u in D.rows("SELECT id, nombre FROM usuarios")}
    enlaces = {x["id"]: x["nombre"] for x in D.rows("SELECT id, nombre FROM procesos")}

    evs = D.rows("SELECT * FROM evidencias WHERE proceso_id=? ORDER BY COALESCE(orden,0), creado", (t["proceso_id"],))
    por_campo = {}
    for e in evs:
        por_campo.setdefault(e["campo_id"] or "", []).append({
            "tipo": e["tipo"], "mediaId": e["media_id"], "nota": e["nota"],
            "duracion": e["duracion"] or 0, "origen": e["origen"] or "app",
            "autor": nombres.get(e["autor_id"], ""), "fecha": str(e["creado"])[:16],
        })

    # Evidencia pegada a una actividad o a una sub-actividad: su campo viene
    # como "f_pasos:2" o "f_pasos:2:1". Se agrupa aparte para mostrarla junto
    # al paso al que pertenece.
    por_paso = {}
    for clave, lista in por_campo.items():
        if ":" in clave:
            base = clave.split(":")[0]
            por_paso.setdefault(base, {})[clave] = lista

    secciones = []
    for s in plantilla.get("secciones", []):
        campos = []
        for c in s.get("campos", []):
            v = respuestas.get(c["id"])
            ev = por_campo.get(c["id"], [])
            extra = por_paso.get(c["id"], {})
            if not ev and not extra and (v is None or v == "" or v == [] or v == {}):
                continue
            campos.append({
                "etiqueta": c["etiqueta"], "tipo": c["tipo"],
                "valor": v, "nombres": nombres, "enlaces": enlaces, "evidencias": ev,
                "porPaso": por_paso.get(c["id"], {}),
            })
        if campos:
            secciones.append({"nombre": s.get("nombre", ""), "campos": campos})

    sueltas = por_campo.get("", [])
    avance, _ = _avance(plantilla, respuestas)
    envios = D.rows("SELECT * FROM envios WHERE proceso_id=? ORDER BY numero DESC LIMIT 1",
                    (t["proceso_id"],))

    medios = {}
    if embebido:
        gastado = 0
        for e in evs:
            if not e["media_id"] or e["media_id"] in medios:
                continue
            if e["tipo"] == "foto":
                uri = _datauri(e["media_id"])
                if uri:
                    medios[e["media_id"]] = uri
            elif e["tipo"] == "audio" and gastado < TOPE_AUDIO_TOTAL:
                uri = _datauri(e["media_id"], reducir=False,
                               tope=TOPE_AUDIO_TOTAL - gastado)
                if uri:
                    medios[e["media_id"]] = uri
                    gastado += len(uri) * 3 // 4

    return {
        "token": token,
        "embebido": embebido,
        "media": medios,
        "proceso": {
            "nombre": p["nombre"], "codigo": p["codigo"], "area": p["area"],
            "estado": p["estado"], "responsable": nombres.get(p["responsable_id"], "—"),
            "enviado": str(p.get("enviado_en") or "")[:16],
            "atiende": p.get("atiende") or "",
        },
        "nota_clinica": p.get("notas_clinica") or "",
        "analisis": (lambda f: D.jload(f["contenido"], {}) if f else None)(
            D.row("SELECT contenido FROM analisis WHERE proceso_id=? AND estado='aprobado' "
                  "ORDER BY creado DESC LIMIT 1", (t["proceso_id"],))),
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
            subs = []
            for x in (r.get("subtareas") or []):
                if isinstance(x, dict):
                    txt = x.get("texto") or ""
                    if x.get("detalle"):
                        txt += f" ({a_texto_plano(x['detalle'])})"
                elif x:
                    txt = str(x)
                else:
                    continue
                if txt.strip():
                    subs.append(txt)
            if subs:
                linea += " || Sub: " + "; ".join(subs)
            partes.append(linea)
        return " / ".join(partes)
    if t == "multi" and isinstance(v, list):
        return ", ".join(v)
    if t == "persona":
        return nombres.get(v, "")
    if t == "procesos" and isinstance(v, list):
        return ", ".join(nombres.get(x, x) for x in v)
    return a_texto_plano(str(v))


@api.get("/export/csv")
@login_required
def export_csv():
    plantilla = D.jload(D.row("SELECT data FROM plantilla WHERE id=1")["data"], {})
    campos = _campos_planos(plantilla)
    nombres = {u["id"]: u["nombre"] for u in _equipo()}
    nombres.update({p["id"]: p["nombre"] for p in D.rows("SELECT id, nombre FROM procesos")})
    procs = _procesos(_alcance())

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
