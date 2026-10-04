"""
videos.py — De una grabación de entrevista a un proceso levantado.

El problema que resuelve: el equipo graba con el celular mientras la
persona explica y muestra su pantalla. Son hasta dos horas. Volver a
verlas, escribir el paso a paso y sacar pantallazos es más trabajo que
la entrevista misma.

La decisión que ordena todo el diseño: el audio de dos horas pesa 28 MB
y el video 6 GB. Así que el video no viaja. Se sube la voz, que es donde
está el conocimiento, y solo después se piden las imágenes de los
momentos que valen la pena —que son quince o veinte, no mil—.

El trabajo va en dos pasadas, y el orden importa:

  1. Claude lee la transcripción completa con sus tiempos y arma el paso
     a paso. Como va entendiendo el proceso, puede decir en qué minutos
     necesita ver la pantalla: "cuando menciona el formato", "cuando
     muestra el error".
  2. Se sacan esos fotogramas —el más nítido de cada momento, porque la
     mano tiembla— y Claude los mira para confirmar, corregir y nombrar
     los campos que se ven.

Al revés no funciona: mandar mil fotogramas a ciegas cuesta una fortuna
en tokens y la mayoría son la misma pantalla con el cursor movido.
"""
import json
import math
import os
import subprocess
import tempfile
from pathlib import Path

# Cuántos segundos alrededor del momento pedido se exploran buscando el
# fotograma nítido. Con la mano temblando, uno de siete suele servir.
VENTANA = 3
PASOS_VENTANA = 7

# Tope de imágenes que se le muestran a Claude en la segunda pasada.
MAX_IMAGENES = 24


class VideoError(Exception):
    pass


def _correr(args, timeout=1800):
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise VideoError((r.stderr or "")[-400:])
    return r


def info(video):
    """Duración, peso y si trae pista de audio."""
    r = _correr(["ffprobe", "-v", "error", "-show_entries",
                 "format=duration,size", "-show_entries", "stream=codec_type",
                 "-of", "json", str(video)], timeout=120)
    d = json.loads(r.stdout)
    tipos = [s.get("codec_type") for s in d.get("streams", [])]
    return {
        "segundos": float(d.get("format", {}).get("duration") or 0),
        "bytes": int(d.get("format", {}).get("size") or 0),
        "tiene_audio": "audio" in tipos,
        "tiene_video": "video" in tipos,
    }


def extraer_audio(video, destino):
    """La voz sola, en el formato que piden los transcriptores.

    Mono a 16 kHz no es una pérdida: es exactamente el rango de la voz
    humana, y es lo que esos servicios usan por dentro de todos modos.
    Bajar de ahí ahorraría poco y empezaría a comerse las consonantes.
    """
    datos = info(video)
    if not datos["tiene_audio"]:
        raise VideoError("El video no trae audio. Sin voz no hay nada que transcribir.")
    _correr(["ffmpeg", "-v", "error", "-y", "-i", str(video),
             "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k",
             str(destino)])
    return Path(destino).stat().st_size


def _nitidez(ruta):
    """Qué tan movido salió el fotograma.

    Varianza del laplaciano: mide cuánto contraste hay entre píxeles
    vecinos. Una foto quieta tiene bordes marcados y da un número alto;
    una movida los tiene lavados y da casi cero. En la prueba, el nítido
    midió más de mil veces el movido.
    """
    try:
        from PIL import Image
        import numpy as np
        g = np.asarray(Image.open(ruta).convert("L"), dtype=float)
        if g.size < 100:
            return 0.0
        lap = (-4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1]
               + g[1:-1, :-2] + g[1:-1, 2:])
        return float(lap.var())
    except Exception:
        return 0.0


def candidatos_del_momento(video, segundo, carpeta, cuantos=3, ventana=5):
    """Varias opciones del mismo momento, de la más nítida a la menos.

    Quien revisa necesita poder decir "esa no, la de un segundo antes".
    Guardar tres alternativas cuesta unos 100 KB y evita tener que
    conservar el video entero —seis gigas— solo por si acaso.
    """
    dur = info(video)["segundos"]
    inicio = max(0, segundo - ventana)
    fin = min(dur - 0.2, segundo + ventana) if dur else segundo + ventana
    if fin <= inicio:
        fin = inicio + 0.1

    carpeta = Path(carpeta)
    carpeta.mkdir(parents=True, exist_ok=True)
    tomas = []
    pasos = max(cuantos * 3, 9)
    for i in range(pasos):
        t = inicio + (fin - inicio) * i / max(1, pasos - 1)
        f = carpeta / f"t{i:02d}.jpg"
        try:
            _correr(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}",
                     "-i", str(video), "-frames:v", "1", "-q:v", "3",
                     "-vf", "scale=\'min(1600,iw)\':-2", str(f)], timeout=90)
        except VideoError:
            continue
        if f.exists():
            tomas.append({"ruta": f, "segundo": round(t, 1), "nitidez": _nitidez(f)})

    # Las alternativas se reparten por la ventana: la mejor de antes, la
    # mejor del momento y la mejor de después. Escoger las tres más
    # nítidas a secas devolvería tres veces el mismo instante, que no le
    # sirve a quien quiere ver otra cosa.
    elegidas = []
    for z in range(cuantos):
        desde = inicio + (fin - inicio) * z / cuantos
        hasta = inicio + (fin - inicio) * (z + 1) / cuantos
        zona = [t for t in tomas if desde <= t["segundo"] <= hasta]
        if zona:
            elegidas.append(max(zona, key=lambda x: x["nitidez"]))
    elegidas.sort(key=lambda x: -x["nitidez"])

    for t in tomas:
        if t["ruta"] not in [e["ruta"] for e in elegidas]:
            try:
                t["ruta"].unlink()
            except OSError:
                pass
    return elegidas


def fotograma_nitido(video, segundo, destino, ventana=VENTANA, pasos=PASOS_VENTANA):
    """El mejor fotograma de los alrededores de ese segundo.

    Pedir el instante exacto sale mal con un celular en la mano: la
    probabilidad de caer justo en un fotograma movido es alta. Se miran
    varios y se escoge.
    """
    dur = info(video)["segundos"]
    inicio = max(0, segundo - ventana)
    fin = min(dur - 0.2, segundo + ventana) if dur else segundo + ventana
    if fin <= inicio:
        fin = inicio + 0.1

    mejor, mejor_n, mejor_t = None, -1.0, segundo
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(pasos):
            t = inicio + (fin - inicio) * i / max(1, pasos - 1)
            f = os.path.join(tmp, f"c{i}.jpg")
            try:
                _correr(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}",
                         "-i", str(video), "-frames:v", "1", "-q:v", "3",
                         "-vf", "scale='min(1600,iw)':-2", f], timeout=90)
            except VideoError:
                continue
            if not os.path.exists(f):
                continue
            n = _nitidez(f)
            if n > mejor_n:
                mejor_n, mejor_t = n, t
                mejor = open(f, "rb").read()

    if mejor is None:
        raise VideoError(f"No se pudo sacar ningún fotograma cerca del segundo {segundo}")
    Path(destino).write_bytes(mejor)
    return {"segundo": round(mejor_t, 1), "nitidez": round(mejor_n, 1),
            "bytes": len(mejor)}


def muestreo_general(video, cada=None, maximo=12):
    """Unos pocos fotogramas repartidos, para la primera mirada.

    Sirven para que Claude vea de entrada con qué se está trabajando —si
    es una pantalla, un formato en papel, un mostrador— antes de pedir
    momentos concretos.
    """
    dur = info(video)["segundos"]
    if not dur:
        return []
    n = min(maximo, max(3, int(dur // (cada or max(60, dur / maximo)))))
    salida = []
    carpeta = Path(tempfile.mkdtemp(prefix="muestreo_"))
    for i in range(n):
        t = dur * (i + 0.5) / n
        f = carpeta / f"m{i:02d}.jpg"
        try:
            datos = fotograma_nitido(video, t, f, ventana=2, pasos=3)
            salida.append({"ruta": str(f), "segundo": datos["segundo"]})
        except VideoError:
            continue
    return salida


def mmss(segundos):
    s = int(segundos)
    return f"{s // 60:02d}:{s % 60:02d}"


def texto_de_transcripcion(segmentos, limite=120_000):
    """La transcripción con sus marcas de tiempo, lista para leer.

    Los tiempos son lo que permite después pedir "muéstrame el 14:32":
    sin ellos, la transcripción es un muro de texto del que no se puede
    volver al video.
    """
    partes, largo = [], 0
    for s in segmentos:
        linea = f"[{mmss(s['inicio'])}] {s['texto'].strip()}"
        if largo + len(linea) > limite:
            partes.append(f"\n[… transcripción recortada en {mmss(s['inicio'])} …]")
            break
        partes.append(linea)
        largo += len(linea)
    return "\n".join(partes)
