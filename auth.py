"""
auth.py — Contraseñas, sesión y decoradores de acceso.

Roles:
  admin     — todo, incluida la plantilla, el equipo y la configuración
  analista  — crea y edita procesos, sube evidencias
  clinica   — contraparte de la institución: ve la agenda, designa a quién
              atiende de su lado y consulta los informes
  lector    — solo lectura y exportación
"""
import functools
import time
import uuid
from collections import defaultdict

import bcrypt
from flask import session, jsonify, request

import db as D

ROLES = ("admin", "analista", "clinica", "lector")
PUEDE_EDITAR = ("admin", "analista")

# El rol "clinica" es para la gente de la institución: ve la agenda de lo
# que se va a levantar, anota a quién van a mandar de su lado, y consulta
# los informes terminados. No edita el contenido del levantamiento.

_intentos = defaultdict(list)          # ip -> [timestamps]
MAX_INTENTOS = 8
VENTANA = 300                          # 5 minutos


# ── Contraseñas ─────────────────────────────────────────────────────────────

def hash_password(plano: str) -> str:
    return bcrypt.hashpw(plano.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plano: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plano.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, AttributeError):
        return False


def validar_password(p: str):
    if not p or len(p) < 8:
        return "La contraseña debe tener al menos 8 caracteres."
    return None


# ── Rate limiting de login ──────────────────────────────────────────────────

def login_permitido(ip: str) -> bool:
    ahora = time.time()
    _intentos[ip] = [t for t in _intentos[ip] if ahora - t < VENTANA]
    return len(_intentos[ip]) < MAX_INTENTOS


def registrar_fallo(ip: str):
    _intentos[ip].append(time.time())


def limpiar_intentos(ip: str):
    _intentos.pop(ip, None)


# ── Sesión ──────────────────────────────────────────────────────────────────

def usuario_actual():
    uid = session.get("uid")
    if not uid:
        return None
    u = D.row(
        "SELECT id, usuario, nombre, rol, contacto FROM usuarios "
        "WHERE id=? AND activo", (uid,))
    return u


def iniciar_sesion(u):
    session.clear()
    session["uid"] = u["id"]
    session["rol"] = u["rol"]
    session.permanent = True


def cerrar_sesion():
    session.clear()


# ── Decoradores ─────────────────────────────────────────────────────────────

def login_required(fn):
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        if not usuario_actual():
            return jsonify({"error": "no_autenticado"}), 401
        return fn(*a, **kw)
    return wrapper


def rol_required(*roles):
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*a, **kw):
            u = usuario_actual()
            if not u:
                return jsonify({"error": "no_autenticado"}), 401
            if u["rol"] not in roles:
                return jsonify({"error": "sin_permiso"}), 403
            return fn(*a, **kw)
        return wrapper
    return deco


def puede_editar(fn):
    return rol_required(*PUEDE_EDITAR)(fn)


# ── Auditoría ───────────────────────────────────────────────────────────────

def auditar(accion, entidad=None, entidad_id=None, detalle=None):
    u = usuario_actual()
    try:
        D.execute(
            "INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, detalle, ip) "
            "VALUES (?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), u["id"] if u else None, accion, entidad, entidad_id,
             detalle, request.headers.get("X-Forwarded-For", request.remote_addr)),
        )
    except Exception as e:  # la auditoría nunca debe romper la operación
        print("[auditoria] error:", e)
