"""
entrevistas.py — El trabajo completo, de la grabación al proceso levantado.

Une las piezas en el orden que importa: primero la voz, después las
imágenes. La razón es económica y de calidad a la vez. Mandar mil
fotogramas a ciegas cuesta una fortuna y la mayoría son la misma escena
con el pulso movido; en cambio, quien ya entendió el proceso sabe pedir
quince momentos que valen la pena.

Corre en segundo plano porque transcribir dos horas tarda minutos, y
nadie va a quedarse mirando una pantalla todo ese rato. El estado queda
guardado en cada paso para que la persona pueda cerrar e irse.
"""
import json
import os
import secrets
import tempfile
import threading
import traceback
from pathlib import Path

import db as D
import ia
import transcribir as TR
import videos as V

# Cuántos momentos se le muestran a Claude en la segunda pasada. Pide
# entre 8 y 20; el tope deja margen sin que el costo se dispare.
MAX_MOMENTOS = 22

# "subiendo" es el video que va llegando por trozos y todavía no está
# completo. Es un estado aparte de "subida" a propósito: en uno hay que
# esperar a que la app trabaje, en el otro hay que volver a escoger el
# archivo para que siga. Confundirlos hacía que un video a medio llegar
# apareciera como recibido.
ESTADOS = ("subiendo", "subida", "transcribiendo", "analizando", "imagenes",
           "listo", "error")


def _ahora():
    from datetime import datetime
    return datetime.utcnow().isoformat(timespec="seconds")


def crear(nombre, proceso_id, subido_por, duracion=0, origen_bytes=0, audio_bytes=0):
    gid = "gr_" + secrets.token_hex(8)
    D.execute(
        "INSERT INTO grabaciones (id, proceso_id, nombre, duracion, estado, "
        "subido_por, origen_bytes, audio_bytes) VALUES (?,?,?,?,?,?,?,?)",
        (gid, proceso_id or None, nombre[:200], int(duracion), "subida",
         subido_por, int(origen_bytes), int(audio_bytes)))
    return gid


def leer(gid):
    f = D.row("SELECT * FROM grabaciones WHERE id=?", (gid,))
    if not f:
        return None
    return {
        "id": f["id"], "procesoId": f["proceso_id"] or "", "nombre": f["nombre"],
        "duracion": f["duracion"] or 0, "estado": f["estado"],
        "transcripcion": D.jload(f["transcripcion"], []),
        "analisis": D.jload(f["analisis"], {}),
        "momentos": D.jload(f["momentos"], []),
        "error": f["error"] or "", "subidoPor": f["subido_por"] or "",
        "origenBytes": f["origen_bytes"] or 0, "audioBytes": f["audio_bytes"] or 0,
        # Para poder retomar una subida que se cortó: cuánto pesa el video
        # y cuánto llegó. Sin esto no hay forma de seguir desde donde iba.
        "esperados": f["esperados"] or 0, "recibidos": f["recibidos"] or 0,
        "creado": str(f["creado"]), "actualizado": str(f["actualizado"] or ""),
    }


def listar(solo_de=None):
    if solo_de:
        filas = D.rows("SELECT * FROM grabaciones WHERE subido_por=? "
                       "ORDER BY creado DESC LIMIT 60", (solo_de,))
    else:
        filas = D.rows("SELECT * FROM grabaciones ORDER BY creado DESC LIMIT 60")
    salida = []
    for f in filas:
        g = leer(f["id"])
        # El listado no necesita cargar la transcripción entera.
        g["transcripcion"] = []
        a = g.get("analisis") or {}
        g["resumenCorto"] = (a.get("resumen") or "")[:220]
        g["pasos"] = len(a.get("pasos") or [])
        salida.append(g)
    return salida


def _marcar(gid, estado, **campos):
    sets = ["estado=?", f"actualizado={D.NOW}"]
    vals = [estado]
    for k, v in campos.items():
        sets.append(f"{k}=?")
        vals.append(v)
    vals.append(gid)
    D.execute(f"UPDATE grabaciones SET {', '.join(sets)} WHERE id=?", tuple(vals))


def procesar(gid, ruta_audio, ruta_video=None, contexto=""):
    """El trabajo completo. Pensado para correr en un hilo aparte.

    ruta_video es opcional: sin él se hace todo salvo las imágenes, que es
    mejor que nada cuando el video se quedó en el computador de alguien.
    """
    try:
        # ── 1. La voz ───────────────────────────────────────────────────
        _marcar(gid, "transcribiendo")
        datos = Path(ruta_audio).read_bytes()
        segmentos, proveedor = TR.transcribir(
            datos, Path(ruta_audio).name, ruta_audio=ruta_audio)
        D.execute("UPDATE grabaciones SET transcripcion=? WHERE id=?",
                  (D.jdump(segmentos), gid))

        dur = max((s.get("fin") or 0) for s in segmentos) if segmentos else 0
        if dur:
            D.execute("UPDATE grabaciones SET duracion=? WHERE id=?", (int(dur), gid))

        # ── 2. Entender el proceso, solo oyendo ─────────────────────────
        _marcar(gid, "analizando")
        texto = V.texto_de_transcripcion(segmentos)
        fila = D.row("SELECT data FROM plantilla WHERE id=1")
        campos = ia.campos_para_llenar(D.jload(fila["data"], {})) if fila else None
        analisis, modelo, uso = ia.analizar_entrevista(texto, dur, contexto, campos)
        D.execute("UPDATE grabaciones SET analisis=? WHERE id=?",
                  (D.jdump(analisis), gid))

        # ── 3. Mirar los momentos pedidos ───────────────────────────────
        momentos = (analisis.get("momentos_para_ver") or [])[:MAX_MOMENTOS]
        if ruta_video and os.path.exists(ruta_video) and momentos:
            _marcar(gid, "imagenes")
            guardados = _sacar_momentos(gid, ruta_video, momentos)
            D.execute("UPDATE grabaciones SET momentos=? WHERE id=?",
                      (D.jdump(guardados), gid))

            imagenes = []
            for n, m in enumerate(guardados, 1):
                mid = m.get("mediaId")
                if not mid:
                    continue
                fila = D.row("SELECT content_type, data, ruta FROM media WHERE id=?", (mid,))
                if not fila:
                    continue
                if fila.get("ruta"):
                    try:
                        b = open(fila["ruta"], "rb").read()
                    except OSError:
                        continue
                else:
                    b = D.to_bytes(fila["data"])
                if b:
                    imagenes.append({"n": n, "segundo": m["segundo"],
                                     "por_que": m.get("por_que", ""),
                                     "datos": b, "tipo": fila["content_type"] or "image/jpeg"})

            if imagenes:
                revision, _, _ = ia.revisar_imagenes(analisis, imagenes)
                analisis["revision_imagenes"] = revision
                # Lo que Claude corrigió al ver se incorpora al análisis:
                # el texto de la entrevista era una hipótesis, la imagen manda.
                if revision.get("campos_formulario"):
                    analisis["campos_formulario"] = revision["campos_formulario"]
                D.execute("UPDATE grabaciones SET analisis=? WHERE id=?",
                          (D.jdump(analisis), gid))

        _marcar(gid, "listo", error="")
        return True

    except (TR.TranscripcionError, ia.IAError) as e:
        _marcar(gid, "error", error=f"{e.codigo}: {getattr(e, 'detalle', '')[:300]}")
    except Exception as e:
        _marcar(gid, "error", error=f"inesperado: {e}")
        print("[entrevistas]", traceback.format_exc()[-800:])
    return False


def _sacar_momentos(gid, ruta_video, momentos):
    """Los fotogramas de los momentos pedidos, con alternativas.

    De cada momento se guardan tres tomas repartidas por los alrededores,
    no una sola. Quien revisa casi siempre acepta la primera, pero cuando
    no —la mano se movió, alguien se cruzó, la pantalla estaba cambiando—
    puede escoger otra sin tener que volver al video, que para entonces ya
    no existe.
    """
    from api import _guardar_media_bytes       # tardío: evita importación circular

    g = leer(gid)
    salida = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, m in enumerate(momentos, 1):
            try:
                seg = float(m.get("segundo") or 0)
            except (TypeError, ValueError):
                continue
            carpeta = os.path.join(tmp, f"m{i:02d}")
            try:
                tomas = V.candidatos_del_momento(ruta_video, seg, carpeta)
            except V.VideoError:
                continue
            if not tomas:
                continue

            guardadas = []
            for t in tomas:
                mid = _guardar_media_bytes(
                    g.get("procesoId") or None, Path(t["ruta"]).read_bytes(),
                    "image/jpeg", f"momento_{i:02d}_{int(t['segundo'])}s.jpg")
                guardadas.append({"mediaId": mid, "segundo": t["segundo"],
                                  "nitidez": round(t["nitidez"], 1)})

            salida.append({"n": i, "pedido": seg,
                           "segundo": guardadas[0]["segundo"],
                           "nitidez": guardadas[0]["nitidez"],
                           "mediaId": guardadas[0]["mediaId"],
                           "alternativas": guardadas[1:],
                           "por_que": m.get("por_que", ""),
                           "que_busco": m.get("que_busco", ""),
                           "prioridad": m.get("prioridad", ""),
                           # Nadie la ha revisado todavía: ni aprobada ni
                           # descartada. El vacío es un estado, no un error.
                           "decision": ""})
    return salida


def procesar_en_segundo_plano(gid, ruta_audio, ruta_video=None, contexto=""):
    """Arranca el trabajo y devuelve el control enseguida.

    Dos horas de audio tardan varios minutos en transcribirse. Dejar la
    petición abierta todo ese rato haría que el navegador se cansara y que
    el servidor no pudiera atender a nadie más.
    """
    h = threading.Thread(target=_con_limpieza,
                         args=(gid, ruta_audio, ruta_video, contexto), daemon=True)
    h.start()
    return h


def _con_limpieza(gid, ruta_audio, ruta_video, contexto):
    try:
        procesar(gid, ruta_audio, ruta_video, contexto)
    finally:
        for r in (ruta_audio, ruta_video):
            try:
                if r and os.path.exists(r):
                    os.remove(r)
            except OSError:
                pass


def revisar_momento(gid, n, decision, media_id=None):
    """Lo que decidió quien revisó: sirve, no sirve, o esta otra toma.

    Es el único punto donde una persona corrige a la máquina antes de que
    su trabajo entre al levantamiento. Claude propuso los momentos oyendo
    y escogió las tomas por nitidez; ninguna de las dos cosas sabe si la
    foto muestra lo que hacía falta.
    """
    g = leer(gid)
    if not g:
        return {"error": "no_existe"}
    momentos = g.get("momentos") or []
    for m in momentos:
        if m.get("n") != n:
            continue
        if decision in ("si", "no", ""):
            m["decision"] = decision
        if media_id:
            # Cambiar de toma: la elegida y la que estaba intercambian sitio,
            # para no perder ninguna de las alternativas.
            alternativas = m.get("alternativas") or []
            nueva = next((a for a in alternativas if a["mediaId"] == media_id), None)
            if nueva:
                anterior = {"mediaId": m["mediaId"], "segundo": m["segundo"],
                            "nitidez": m.get("nitidez", 0)}
                m["mediaId"] = nueva["mediaId"]
                m["segundo"] = nueva["segundo"]
                m["nitidez"] = nueva.get("nitidez", 0)
                m["alternativas"] = [anterior] + [a for a in alternativas
                                                  if a["mediaId"] != media_id]
        D.execute("UPDATE grabaciones SET momentos=? WHERE id=?",
                  (D.jdump(momentos), gid))
        return {"ok": True, "momento": m}
    return {"error": "momento_no_existe"}


def guardar_pasos(gid, pasos):
    """Los pasos corregidos a mano antes de volcarlos.

    Claude oyó bien pero no estuvo ahí. Quien hizo la entrevista sí, y a
    veces corrige el orden, junta dos pasos o quita uno que era una
    digresión.
    """
    g = leer(gid)
    if not g:
        return {"error": "no_existe"}
    a = g.get("analisis") or {}
    limpios = []
    for p in (pasos or [])[:80]:
        if not isinstance(p, dict) or not (p.get("actividad") or "").strip():
            continue
        limpios.append({
            "n": len(limpios) + 1,
            "desde": p.get("desde") or 0,
            "actividad": str(p.get("actividad"))[:300],
            "detalle": str(p.get("detalle") or "")[:4000],
            "sistema": str(p.get("sistema") or "")[:120],
            "tiempo": str(p.get("tiempo") or "")[:60],
            "es_excepcion": bool(p.get("es_excepcion")),
        })
    a["pasos"] = limpios
    D.execute("UPDATE grabaciones SET analisis=? WHERE id=?", (D.jdump(a), gid))
    return {"ok": True, "pasos": len(limpios)}


def a_proceso(gid, proceso_id, usuario_id, llenar_campos=True):
    """Vuelca lo revisado en el proceso: respuestas, actividades y fotos.

    Tres reglas que no cambian:
      · No pisa nada escrito. Lo que ya tenía texto se queda como estaba.
      · Las actividades se agregan al final, no reemplazan a las que había.
      · Solo entran las fotos que alguien aprobó. Una foto que nadie miró
        no es evidencia de nada.
    """
    g = leer(gid)
    if not g:
        return {"error": "no_existe"}
    a = g.get("analisis") or {}
    pasos = a.get("pasos") or []
    if not pasos:
        return {"error": "sin_pasos"}

    p = D.row("SELECT respuestas FROM procesos WHERE id=?", (proceso_id,))
    if not p:
        return {"error": "proceso_no_existe"}

    respuestas = D.jload(p["respuestas"], {})
    actuales = respuestas.get("f_pasos") or []
    desde = len(actuales)

    for paso in pasos:
        actuales.append({
            "actividad": (paso.get("actividad") or "")[:300],
            "responsable": (a.get("quien_habla") or "")[:120],
            "sistema": (paso.get("sistema") or "")[:120],
            "tiempo": (paso.get("tiempo") or "")[:60],
            "detalle": (paso.get("detalle") or "")[:4000],
            "subtareas": [],
        })
    respuestas["f_pasos"] = actuales

    # Las respuestas del formulario, solo donde no hay nada escrito.
    llenados = []
    if llenar_campos:
        fila = D.row("SELECT data FROM plantilla WHERE id=1")
        plantilla = D.jload(fila["data"], {}) if fila else {}
        validos = {c["id"]: c for s in plantilla.get("secciones", [])
                   for c in s.get("campos", [])}
        for cid, valor in (a.get("respuestas") or {}).items():
            if cid not in validos or cid == "f_pasos":
                continue
            if str(respuestas.get(cid) or "").strip():
                continue                      # ya había algo: no se toca
            if isinstance(valor, list):
                respuestas[cid] = [str(x)[:400] for x in valor[:30]]
            else:
                respuestas[cid] = str(valor)[:8000]
            llenados.append(cid)

    if a.get("resumen") and not str(respuestas.get("f_objetivo") or "").strip():
        respuestas["f_objetivo"] = a["resumen"][:2000]
        llenados.append("f_objetivo")
    dolores = a.get("dolores") or []
    if dolores and not str(respuestas.get("f_dolor") or "").strip():
        respuestas["f_dolor"] = " · ".join(
            f"{d.get('dolor','')} ({d.get('impacto','')})" for d in dolores)[:2000]
        llenados.append("f_dolor")

    D.execute("UPDATE procesos SET respuestas=? WHERE id=?",
              (D.jdump(respuestas), proceso_id))

    # Solo las fotos aprobadas. Si nadie revisó ninguna, se usa el criterio
    # de Claude como punto de partida, pero marcándolo en la respuesta para
    # que quien llamó sepa que nadie miró todavía.
    revision = a.get("revision_imagenes") or {}
    por_imagen = {e.get("imagen"): e for e in (revision.get("evidencias") or [])}
    descartadas = {x.get("imagen") for x in (revision.get("sin_valor") or [])}
    momentos = g.get("momentos") or []
    hubo_revision = any(m.get("decision") for m in momentos)

    puestas = 0
    for m in momentos:
        if hubo_revision:
            if m.get("decision") != "si":
                continue
        else:
            if m["n"] in descartadas:
                continue

        info = por_imagen.get(m["n"]) or {}
        paso_n = info.get("paso")
        campo = (f"f_pasos:{desde + int(paso_n) - 1}"
                 if paso_n and 1 <= int(paso_n) <= len(pasos) else "f_pasos")
        nota = info.get("que_muestra") or m.get("por_que", "")
        eid = "e_" + secrets.token_hex(8)
        D.execute(
            "INSERT INTO evidencias (id, proceso_id, campo_id, tipo, media_id, nota, "
            "autor_id, origen) VALUES (?,?,?,?,?,?,?,?)",
            (eid, proceso_id, campo, "foto", m["mediaId"], nota[:2000],
             usuario_id, "video"))
        puestas += 1

    D.execute("UPDATE grabaciones SET proceso_id=? WHERE id=?", (proceso_id, gid))
    return {"ok": True, "pasos": len(pasos), "fotos": puestas,
            "campos": llenados, "revisadas": hubo_revision}
