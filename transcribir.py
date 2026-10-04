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

from pathlib import Path

import db as D

PROVEEDORES = ("openai", "deepgram")
TIMEOUT = 900          # dos horas de audio tardan varios minutos

# OpenAI no recibe archivos de más de 25 MB. Una entrevista de dos horas
# pesa unos 28, así que hay que partirla. Se deja margen porque el límite
# es del cuerpo entero de la petición, no solo del audio.
TOPE_OPENAI = int(os.environ.get("TOPE_AUDIO_MB", "24")) * 1024 * 1024
MINUTOS_TROZO = int(os.environ.get("MINUTOS_TROZO", "20"))


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


def _partir(ruta_audio, minutos=None):
    """Corta el audio en trozos para los servicios que no reciben archivos
    grandes. Devuelve [(ruta, segundo_en_que_empieza)].

    Se corta por tiempo exacto, no por silencio: una frase partida se
    recupera al unir los textos, pero un desfase en los minutos haría que
    las fotos salieran del momento equivocado.
    """
    import subprocess
    import tempfile
    # Se resuelve aquí y no en la firma: así un cambio del valor —por
    # variable de entorno o en una prueba— tiene efecto de verdad.
    minutos = minutos or MINUTOS_TROZO
    carpeta = tempfile.mkdtemp(prefix="trozos_")
    patron = os.path.join(carpeta, "t%03d.m4a")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(ruta_audio),
         "-f", "segment", "-segment_time", str(minutos * 60),
         "-c", "copy", "-reset_timestamps", "1", patron],
        capture_output=True, timeout=600)

    trozos = sorted(Path(carpeta).glob("t*.m4a"))
    if not trozos:
        return []
    return [(t, i * minutos * 60) for i, t in enumerate(trozos)]


def transcribir(datos_audio, nombre="audio.m4a", idioma="es", proveedor=None,
                ruta_audio=None):
    """Devuelve (segmentos, proveedor). Cada segmento trae inicio y texto.

    Si el audio no cabe en el servicio, se parte y se vuelve a unir
    corriendo los tiempos de cada trozo. Para quien lee el resultado es
    como si hubiera ido entero.
    """
    proveedor = proveedor or proveedor_activo()
    if not proveedor:
        raise TranscripcionError("sin_llave")

    if (proveedor == "openai" and len(datos_audio) > TOPE_OPENAI
            and ruta_audio and os.path.exists(ruta_audio)):
        trozos = _partir(ruta_audio)
        if trozos:
            todos = []
            for ruta, desfase in trozos:
                parte, _ = transcribir(ruta.read_bytes(), ruta.name, idioma,
                                       proveedor)
                for s in parte:
                    todos.append({**s,
                                  "inicio": s["inicio"] + desfase,
                                  "fin": s.get("fin", 0) + desfase})
                try:
                    ruta.unlink()
                except OSError:
                    pass
            if todos:
                return todos, proveedor

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
            raise TranscripcionError(
                "audio_muy_grande",
                "El servicio no recibe archivos de este tamaño. "
                "Con Deepgram no hay ese límite." + (" " + detalle if detalle else ""))
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
