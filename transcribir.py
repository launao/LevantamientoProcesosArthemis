"""
transcribir.py — De la voz grabada a texto con minutos.

Los minutos son lo que hace útil la transcripción: sin ellos queda un
muro de texto del que no se puede volver al video. Con ellos, cuando
Claude dice "aquí se ve el formato", sabemos exactamente qué fotograma
sacar.

Habla con dos servicios porque ninguno es obviamente mejor y conviene
poder cambiar sin tocar el resto: OpenAI (Whisper) y Deepgram. El primero
entiende mejor el acento y los nombres propios; el segundo es más barato
y más rápido. Se elige con una variable y se puede cambiar cualquier día.
"""
import json
import os
import urllib.error
import urllib.request

import db as D

PROVEEDORES = ("openai", "deepgram")
TIMEOUT = 900          # dos horas de audio tardan varios minutos


class TranscripcionError(Exception):
    def __init__(self, codigo, detalle=""):
        super().__init__(codigo)
        self.codigo = codigo
        self.detalle = detalle


# ── La llave ────────────────────────────────────────────────────────────────

def guardar_llave(proveedor, valor):
    clave = "voz_" + proveedor
    valor = (valor or "").strip()
    if not valor:
        D.execute("DELETE FROM secretos WHERE clave=?", (clave,))
        return
    if D.row("SELECT clave FROM secretos WHERE clave=?", (clave,)):
        D.execute("UPDATE secretos SET valor=? WHERE clave=?", (valor, clave))
    else:
        D.execute("INSERT INTO secretos (clave, valor) VALUES (?,?)", (clave, valor))


def leer_llave(proveedor):
    f = D.row("SELECT valor FROM secretos WHERE clave=?", ("voz_" + proveedor,))
    if f and f["valor"]:
        return f["valor"]
    return os.environ.get(
        {"openai": "OPENAI_API_KEY", "deepgram": "DEEPGRAM_API_KEY"}[proveedor], "").strip()


def proveedor_activo():
    """El que esté configurado. Si hay dos, manda la preferencia."""
    preferido = os.environ.get("VOZ_PROVEEDOR", "").strip().lower()
    if preferido in PROVEEDORES and leer_llave(preferido):
        return preferido
    for p in PROVEEDORES:
        if leer_llave(p):
            return p
    return None


def estado():
    return {p: {"configurada": bool(leer_llave(p)),
                "llave": _enmascarar(leer_llave(p))} for p in PROVEEDORES} | {
        "activo": proveedor_activo()}


def _enmascarar(k):
    if not k:
        return ""
    return (k[:6] + "…" + k[-4:]) if len(k) > 12 else "configurada"


# ── Las llamadas ────────────────────────────────────────────────────────────

def _multipart(campos, archivo):
    """Arma el cuerpo de la petición a mano.

    Es poco código y evita una dependencia más solo para subir un
    archivo. El límite se escoge para que no pueda aparecer dentro del
    audio.
    """
    linde = "----levantamiento7f3a9c2e"
    partes = []
    for k, v in campos.items():
        partes.append(f"--{linde}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n"
                      .encode())
    nombre, ctype, datos = archivo
    partes.append(
        f"--{linde}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{nombre}\"\r\n"
        f"Content-Type: {ctype}\r\n\r\n".encode())
    partes.append(datos)
    partes.append(f"\r\n--{linde}--\r\n".encode())
    return b"".join(partes), f"multipart/form-data; boundary={linde}"


def _openai(datos, nombre, idioma="es"):
    llave = leer_llave("openai")
    cuerpo, ctype = _multipart(
        {"model": "whisper-1", "language": idioma,
         "response_format": "verbose_json", "timestamp_granularities[]": "segment"},
        (nombre, "audio/m4a", datos))
    req = urllib.request.Request(
        "https://api.openai.com/v1/audio/transcriptions", data=cuerpo, method="POST",
        headers={"Authorization": f"Bearer {llave}", "Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        d = json.loads(r.read().decode("utf-8"))
    return [{"inicio": s.get("start", 0), "fin": s.get("end", 0),
             "texto": (s.get("text") or "").strip()}
            for s in d.get("segments", []) if (s.get("text") or "").strip()]


def _deepgram(datos, nombre, idioma="es"):
    llave = leer_llave("deepgram")
    url = ("https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true"
           f"&punctuate=true&paragraphs=true&language={idioma}&diarize=true")
    req = urllib.request.Request(url, data=datos, method="POST", headers={
        "Authorization": f"Token {llave}", "Content-Type": "audio/m4a"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        d = json.loads(r.read().decode("utf-8"))

    alt = (d.get("results", {}).get("channels") or [{}])[0].get("alternatives") or [{}]
    parrafos = (alt[0].get("paragraphs") or {}).get("paragraphs") or []
    salida = []
    for p in parrafos:
        for f in p.get("sentences", []):
            texto = (f.get("text") or "").strip()
            if texto:
                salida.append({"inicio": f.get("start", 0), "fin": f.get("end", 0),
                               "texto": texto, "quien": p.get("speaker")})
    if salida:
        return salida
    # Si no hubo párrafos, se cae a las palabras sueltas agrupadas por frase.
    palabras = alt[0].get("words") or []
    bloque, salida = [], []
    for w in palabras:
        bloque.append(w)
        if (w.get("punctuated_word") or "").endswith((".", "?", "!")):
            salida.append({"inicio": bloque[0].get("start", 0), "fin": w.get("end", 0),
                           "texto": " ".join(x.get("punctuated_word") or x.get("word", "")
                                             for x in bloque)})
            bloque = []
    return salida


def transcribir(datos_audio, nombre="audio.m4a", idioma="es", proveedor=None):
    """Devuelve (segmentos, proveedor). Cada segmento trae inicio y texto."""
    proveedor = proveedor or proveedor_activo()
    if not proveedor:
        raise TranscripcionError("sin_llave")

    fn = {"openai": _openai, "deepgram": _deepgram}[proveedor]
    try:
        segmentos = fn(datos_audio, nombre, idioma)
    except urllib.error.HTTPError as e:
        detalle = ""
        try:
            detalle = e.read().decode("utf-8")[:400]
        except Exception:
            pass
        if e.code in (401, 403):
            raise TranscripcionError("llave_invalida", detalle)
        if e.code == 429:
            raise TranscripcionError("limite_alcanzado", detalle)
        if e.code == 413:
            raise TranscripcionError("audio_muy_grande", detalle)
        raise TranscripcionError("error_servicio", f"HTTP {e.code}: {detalle}")
    except urllib.error.URLError as e:
        raise TranscripcionError("sin_conexion", str(e.reason))

    if not segmentos:
        raise TranscripcionError("sin_voz",
                                 "El servicio no encontró voz en la grabación.")
    return segmentos, proveedor


def costo_estimado(segundos, proveedor=None):
    """Para poder decirle a alguien cuánto va a gastar antes de gastarlo."""
    proveedor = proveedor or proveedor_activo() or "openai"
    por_minuto = {"openai": 0.006, "deepgram": 0.0043}[proveedor]
    return round(segundos / 60 * por_minuto, 3)
