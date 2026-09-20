"""
documentos.py — El análisis convertido en documento que se aprueba.

El flujo tiene cuatro estados y una regla que lo justifica todo:

    borrador → revisado → con el cliente → aprobado

La regla es qué ve cada quien. El análisis crudo trae recomendaciones
técnicas —módulos, webhooks, agentes— que son insumo para construir
Arthemis, no material para mostrarle a la clínica. Al cliente le llega
únicamente lo que describe SU trabajo: el proceso, el paso a paso, los
campos de sus formatos y las fotos. Si viera la parte técnica, la
conversación se desviaría a discutir soluciones antes de haber
confirmado los hechos.

Cada sección tiene un ancla estable para poder comentar sobre ella,
como los comentarios al margen de un documento compartido.
"""
import secrets

import db as D

# Qué secciones ve el cliente. Todo lo demás es interno.
PARA_CLIENTE = {"panorama", "cadenas", "pasos", "campos_formulario",
                "fotos", "duplicidades", "vacios"}

# Orden y títulos del documento.
SECCIONES = [
    ("panorama", "Panorama general", True),
    ("cadenas", "Cómo se encadena el trabajo", True),
    ("campos_formulario", "Los formatos y sus campos", True),
    ("duplicidades", "Lo que se repite", True),
    ("fotos", "Evidencia fotográfica", True),
    ("conexiones", "Conexiones entre procesos", False),
    ("modulos_sugeridos", "Módulos propuestos", False),
    ("automatizacion", "Oportunidades de automatización", False),
    ("vacios", "Qué falta levantar", True),
    ("siguiente_paso", "Por dónde empezar", False),
]

ESTADOS = ("borrador", "revisado", "con_cliente", "aprobado")


def crear(titulo, contenido, procesos, fotos, creado_por, origen=""):
    did = "doc_" + secrets.token_hex(8)
    D.execute(
        "INSERT INTO documentos (id, titulo, origen, procesos, contenido, fotos, "
        "estado, creado_por, token) VALUES (?,?,?,?,?,?,?,?,?)",
        (did, titulo[:200], origen, D.jdump(procesos), D.jdump(contenido),
         D.jdump(fotos), "borrador", creado_por, secrets.token_urlsafe(20)))
    return did


def leer(did):
    f = D.row("SELECT * FROM documentos WHERE id=?", (did,))
    if not f:
        return None
    return _armar(f)


def por_token(token):
    f = D.row("SELECT * FROM documentos WHERE token=?", (token,))
    if not f:
        return None
    return _armar(f)


def _armar(f):
    return {
        "id": f["id"], "titulo": f["titulo"], "estado": f["estado"],
        "origen": f["origen"] or "",
        "procesos": D.jload(f["procesos"], []),
        "contenido": D.jload(f["contenido"], {}),
        "fotos": D.jload(f["fotos"], []),
        "token": f["token"],
        "creadoPor": f["creado_por"] or "",
        "aprobadoPor": f["aprobado_por"] or "",
        "aprobadoEn": str(f["aprobado_en"] or ""),
        "enviadoEn": str(f["enviado_en"] or ""),
        "vistoCliente": str(f["visto_cliente"] or ""),
        "okCliente": str(f["ok_cliente"] or ""),
        "creado": str(f["creado"]),
        "actualizado": str(f["actualizado"] or ""),
    }


def listar():
    filas = D.rows("SELECT * FROM documentos ORDER BY creado DESC LIMIT 50")
    return [_armar(f) for f in filas]


def para_cliente(doc):
    """La versión que sale de la casa: sin la parte técnica."""
    limpio = dict(doc)
    contenido = doc.get("contenido") or {}
    limpio["contenido"] = {k: v for k, v in contenido.items() if k in PARA_CLIENTE}
    limpio.pop("token", None)
    return limpio


def sumar_comentario(did, ancla, cita, texto, autor_id, autor_nombre, es_cliente):
    cid = "c_" + secrets.token_hex(8)
    D.execute(
        "INSERT INTO comentarios (id, documento_id, ancla, cita, texto, autor_id, "
        "autor_nombre, es_cliente) VALUES (?,?,?,?,?,?,?,?)",
        (cid, did, (ancla or "")[:100], (cita or "")[:400], texto[:4000],
         autor_id, autor_nombre[:120], 1 if es_cliente else 0))
    return cid


def comentarios(did, solo_cliente=False):
    filas = D.rows("SELECT * FROM comentarios WHERE documento_id=? ORDER BY creado", (did,))
    return [{
        "id": f["id"], "ancla": f["ancla"] or "", "cita": f["cita"] or "",
        "texto": f["texto"], "autor": f["autor_nombre"] or "",
        "esCliente": bool(f["es_cliente"]), "resuelto": bool(f["resuelto"]),
        "respuesta": f["respuesta"] or "", "creado": str(f["creado"]),
    } for f in filas]
