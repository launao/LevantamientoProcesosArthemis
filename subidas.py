"""
subidas.py — Recibir videos grandes desde cualquier aparato.

El equipo graba con celulares Android, con iPhone, y trabaja en Mac y en
Windows. Un programa de escritorio no le sirve a todos, así que el video
tiene que poder subirse desde el navegador —que es lo único que hay en
todas partes—.

Un video de dos horas pesa seis gigas. Mandarlo de una sola vez no
funciona: ningún servidor lo acepta, y si la conexión se corta a los
cuarenta minutos se pierde todo. Así que va por trozos de cinco megas,
que se van pegando al final del archivo conforme llegan.

Lo que hace que esto sea usable es la reanudación: el navegador pregunta
cuántos bytes hay ya recibidos y sigue desde ahí. Se puede cerrar la
pestaña, perder el wifi o quedarse sin batería, y al volver continúa
donde iba en vez de empezar de nuevo.

El video no se queda. Apenas termina de llegar se le saca la voz y se
borra: lo que vale son los 28 MB de audio y las pocas imágenes de los
momentos que importan.
"""
import os
import shutil
import tempfile
from pathlib import Path

import db as D

# El tamaño del trozo es un equilibrio: grande gasta menos viajes, pero
# si se corta uno se repite más. Cinco megas aguanta bien un wifi malo.
TROZO = 5 * 1024 * 1024

# Tope por video. Dos horas en 4K llegan a veinte gigas, que no tiene
# sentido recibir: antes de eso conviene bajar la calidad de grabación.
MAX_VIDEO = int(os.environ.get("MAX_VIDEO_SUBIDA_GB", "12")) * 1024 * 1024 * 1024

# Dónde se arman los videos mientras llegan. En Railway el disco del
# contenedor se borra al reiniciar, que es justo lo que queremos: si algo
# falla a medias, no quedan seis gigas de basura ocupando espacio.
def carpeta_temporal():
    base = os.environ.get("SUBIDAS_DIR") or os.path.join(tempfile.gettempdir(),
                                                         "levantamiento_subidas")
    os.makedirs(base, exist_ok=True)
    return base


class SubidaError(Exception):
    def __init__(self, codigo, detalle=""):
        super().__init__(codigo)
        self.codigo = codigo
        self.detalle = detalle


def espacio_libre():
    try:
        return shutil.disk_usage(carpeta_temporal()).free
    except OSError:
        return 0


def iniciar(gid, nombre, esperados):
    """Prepara el archivo donde se va a ir armando el video."""
    esperados = int(esperados or 0)
    if esperados > MAX_VIDEO:
        raise SubidaError("video_muy_grande",
                          f"El tope es {MAX_VIDEO // (1024**3)} GB. "
                          "Si graban en 4K, bajen la calidad a 1080p: "
                          "para una entrevista se ve igual y pesa la tercera parte.")

    # Se comprueba el espacio antes de empezar, no a los cuarenta minutos.
    libre = espacio_libre()
    if esperados and libre and esperados > libre * 0.8:
        raise SubidaError(
            "sin_espacio",
            f"No hay espacio para este video ({esperados // (1024**2)} MB "
            f"y quedan {libre // (1024**2)} MB). Espera a que termine otra subida.")

    ruta = os.path.join(carpeta_temporal(), f"{gid}.video")
    Path(ruta).write_bytes(b"")
    D.execute("UPDATE grabaciones SET ruta_video=?, recibidos=0, esperados=?, "
              "estado='subiendo' WHERE id=?", (ruta, esperados, gid))
    return {"ruta": ruta, "trozo": TROZO, "recibidos": 0}


def estado(gid):
    """Cuántos bytes hay ya, para poder seguir desde ahí."""
    f = D.row("SELECT ruta_video, recibidos, esperados, estado FROM grabaciones "
              "WHERE id=?", (gid,))
    if not f:
        return None
    ruta = f["ruta_video"]
    # Manda el tamaño real del archivo, no el contador: si el servidor se
    # reinició a medias, el contador puede mentir y el archivo no.
    reales = os.path.getsize(ruta) if ruta and os.path.exists(ruta) else 0
    if reales != (f["recibidos"] or 0):
        D.execute("UPDATE grabaciones SET recibidos=? WHERE id=?", (reales, gid))
    return {"recibidos": reales, "esperados": f["esperados"] or 0,
            "estado": f["estado"], "trozo": TROZO,
            "completo": bool(f["esperados"]) and reales >= f["esperados"]}


def recibir_trozo(gid, desde, datos):
    """Pega un trozo al final del archivo.

    'desde' es dónde dice el navegador que va. Si no coincide con lo que
    hay, se rechaza en vez de escribir en el sitio equivocado: un video
    con un hueco en la mitad no se puede leer y el error aparecería mucho
    después, cuando ya nadie recuerda esta subida.
    """
    f = D.row("SELECT ruta_video, recibidos, esperados FROM grabaciones WHERE id=?",
              (gid,))
    if not f or not f["ruta_video"]:
        raise SubidaError("no_iniciada")

    ruta = f["ruta_video"]
    actual = os.path.getsize(ruta) if os.path.exists(ruta) else 0
    desde = int(desde)

    if desde != actual:
        raise SubidaError("desfasado",
                          f"El servidor tiene {actual} bytes y el trozo empieza "
                          f"en {desde}.")

    if f["esperados"] and actual + len(datos) > f["esperados"] * 1.02:
        raise SubidaError("de_mas", "Llegaron más bytes de los anunciados.")

    with open(ruta, "ab") as fh:
        fh.write(datos)

    nuevo = os.path.getsize(ruta)
    D.execute("UPDATE grabaciones SET recibidos=? WHERE id=?", (nuevo, gid))
    return {"recibidos": nuevo, "esperados": f["esperados"] or 0,
            "completo": bool(f["esperados"]) and nuevo >= f["esperados"]}


def cancelar(gid):
    """Tira lo que se alcanzó a subir. Para cuando alguien se arrepiente."""
    f = D.row("SELECT ruta_video FROM grabaciones WHERE id=?", (gid,))
    if f and f["ruta_video"] and os.path.exists(f["ruta_video"]):
        try:
            os.remove(f["ruta_video"])
        except OSError:
            pass
    D.execute("UPDATE grabaciones SET ruta_video=NULL, recibidos=0 WHERE id=?", (gid,))


def limpiar_viejas(horas=6):
    """Barre los videos a medio subir que nadie terminó.

    Sin esto, una subida abandonada deja seis gigas ocupados hasta que
    alguien se dé cuenta, que suele ser cuando el disco ya se llenó.
    """
    import time
    base = carpeta_temporal()
    limite = time.time() - horas * 3600
    borrados = 0
    try:
        for n in os.listdir(base):
            r = os.path.join(base, n)
            try:
                if os.path.isfile(r) and os.path.getmtime(r) < limite:
                    os.remove(r)
                    borrados += 1
            except OSError:
                pass
    except OSError:
        pass
    return borrados
