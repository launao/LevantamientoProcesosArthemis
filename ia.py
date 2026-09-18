"""
ia.py — Análisis del levantamiento con Claude.

Lo que hace: toma un proceso ya levantado —respuestas, actividades,
sub-actividades, notas— y le pide a Claude que devuelva un documento
paralelo: resumen, paso a paso limpio, oportunidades de optimización y
automatización, y qué otros procesos parecen conectar con este.

Lo que NO hace: tocar el levantamiento original. El análisis vive aparte
y solo entra al proceso si alguien lo aprueba. La máquina propone; la
persona que conoce la clínica decide.
"""
import base64
import io
import json
import os
import re
import urllib.error
import urllib.request

import db as D
from sanitizar import a_texto_plano

API_URL = "https://api.anthropic.com/v1/messages"
MODELO_DEFECTO = os.environ.get("CLAUDE_MODELO", "claude-sonnet-5")
TIMEOUT = 180

# Cuántas fotos se le muestran. Cada imagen cuesta tokens; ocho suele ser
# más que suficiente para entender un formato en papel o una pantalla, y
# mantiene el costo por proceso en centavos.
MAX_IMAGENES = int(os.environ.get("CLAUDE_MAX_IMAGENES", "8"))
LADO_MAX = 1024          # se reducen antes de enviarlas


class IAError(Exception):
    """Falla al pedir o interpretar el análisis.

    Lleva siempre el detalle y, cuando existe, lo que Claude devolvió tal
    cual. Un error que solo dice "no se pudo" obliga a adivinar.
    """

    def __init__(self, codigo, detalle="", crudo="", extra=None):
        super().__init__(codigo)
        self.codigo = codigo
        self.detalle = detalle
        self.crudo = crudo
        self.extra = extra or {}


# ── La llave ────────────────────────────────────────────────────────────────

def guardar_llave(valor: str):
    """La llave vive en la base, no en el código ni en el navegador."""
    valor = (valor or "").strip()
    if not valor:
        D.execute("DELETE FROM secretos WHERE clave='anthropic'")
        return
    if D.row("SELECT clave FROM secretos WHERE clave='anthropic'"):
        D.execute("UPDATE secretos SET valor=? WHERE clave='anthropic'", (valor,))
    else:
        D.execute("INSERT INTO secretos (clave, valor) VALUES ('anthropic', ?)", (valor,))


def leer_llave():
    fila = D.row("SELECT valor FROM secretos WHERE clave='anthropic'")
    if fila and fila["valor"]:
        return fila["valor"]
    return os.environ.get("ANTHROPIC_API_KEY", "").strip()


def hay_llave():
    return bool(leer_llave())


def llave_enmascarada():
    """Para mostrar en pantalla sin exponerla: sk-ant-…4f2a."""
    k = leer_llave()
    if not k:
        return ""
    return (k[:7] + "…" + k[-4:]) if len(k) > 14 else "configurada"


# ── El texto que se le manda ────────────────────────────────────────────────

def _valor_legible(campo, valor, nombres, procesos):
    tipo = campo.get("tipo")
    if valor is None or valor == "" or valor == []:
        return None

    if tipo == "pasos" and isinstance(valor, list):
        lineas = []
        for i, r in enumerate(valor):
            if not r.get("actividad"):
                continue
            lineas.append(f"  Actividad {i+1}: {r['actividad']}"
                          f" | responsable: {r.get('responsable') or '?'}"
                          f" | sistema: {r.get('sistema') or '?'}"
                          f" | tiempo: {r.get('tiempo') or '?'}")
            if r.get("detalle"):
                lineas.append(f"    Cómo se hace: {a_texto_plano(r['detalle'])}")
            for j, t in enumerate(r.get("subtareas") or []):
                texto = t.get("texto") if isinstance(t, dict) else str(t)
                detalle = t.get("detalle") if isinstance(t, dict) else ""
                if not texto:
                    continue
                lineas.append(f"    {i+1}.{j+1} {texto}"
                              + (f" — {a_texto_plano(detalle)}" if detalle else ""))
        return "\n".join(lineas) or None

    if tipo == "multi" and isinstance(valor, list):
        return ", ".join(valor)
    if tipo == "persona":
        return nombres.get(valor, "")
    if tipo == "procesos" and isinstance(valor, list):
        return ", ".join(procesos.get(x, x) for x in valor)
    return a_texto_plano(str(valor))


def armar_texto(proceso, plantilla, respuestas, nombres, procesos, evidencias):
    partes = [
        f"PROCESO: {proceso['nombre']}",
        f"Código: {proceso.get('codigo') or 'sin código'}",
        f"Área: {proceso.get('area') or 'sin área'}",
        f"Levantado por: {nombres.get(proceso.get('responsable_id'), 'n/d')}",
    ]
    if proceso.get("notas_clinica"):
        partes.append(f"Advertencia de la clínica: {a_texto_plano(proceso['notas_clinica'])}")
    partes.append("")

    for sec in plantilla.get("secciones", []):
        lineas = []
        for c in sec.get("campos", []):
            v = _valor_legible(c, respuestas.get(c["id"]), nombres, procesos)
            if v:
                lineas.append(f"- {c['etiqueta']}: {v}")
        if lineas:
            partes.append(f"## {sec.get('nombre', '')}")
            partes.extend(lineas)
            partes.append("")

    # La evidencia se lista diciendo a qué pregunta o actividad pertenece:
    # una foto suelta no dice nada, "la foto del formato que llenan en el
    # paso 2" sí.
    etiquetas = {c["id"]: c["etiqueta"]
                 for s2 in plantilla.get("secciones", []) for c in s2.get("campos", [])}

    def donde(campo):
        if not campo:
            return "general"
        partes_campo = campo.split(":")
        base = etiquetas.get(partes_campo[0], partes_campo[0])
        if len(partes_campo) == 3:
            return f"{base}, sub-actividad {int(partes_campo[1])+1}.{int(partes_campo[2])+1}"
        if len(partes_campo) == 2:
            return f"{base}, actividad {int(partes_campo[1])+1}"
        return base

    fotos = [e for e in evidencias if e["tipo"] == "foto"]
    audios = [e for e in evidencias if e["tipo"] == "audio"]
    notas = [e for e in evidencias if e["tipo"] == "nota" and e.get("nota")]

    partes.append("## Evidencia recogida en campo")
    if fotos:
        partes.append(f"- {len(fotos)} foto(s). Las que te adjunto van al final, "
                      "numeradas y con la pregunta a la que pertenecen.")
    if audios:
        partes.append(f"- {len(audios)} nota(s) de voz que NO puedes escuchar:")
        for e in audios:
            seg = e.get("duracion") or 0
            partes.append(f"    · audio de {seg // 60}:{seg % 60:02d} en «{donde(e.get('campo_id'))}»")
        partes.append("    Si el análisis de alguno de esos puntos queda flojo por no "
                      "haberlos oído, dilo en 'audios_por_escuchar'.")
    if notas:
        for e in notas:
            partes.append(f"- Nota escrita en «{donde(e.get('campo_id'))}»: "
                          f"{a_texto_plano(e['nota'])}")
    if not (fotos or audios or notas):
        partes.append("- Ninguna. El levantamiento es solo texto.")

    return "\n".join(partes)


def reducir_imagen(datos, ctype):
    """Baja la resolución antes de enviarla: una foto de celular a tamaño
    completo cuesta el triple de tokens y no se entiende mejor."""
    try:
        from PIL import Image
    except ImportError:
        return datos, ctype
    try:
        img = Image.open(io.BytesIO(datos))
        img = img.convert("RGB")
        if max(img.size) > LADO_MAX:
            escala = LADO_MAX / max(img.size)
            img = img.resize((int(img.width * escala), int(img.height * escala)),
                             Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80, optimize=True)
        return buf.getvalue(), "image/jpeg"
    except Exception:
        return datos, ctype


SISTEMA = """Eres un analista de procesos con experiencia en instituciones de salud \
colombianas. Recibes el levantamiento de un proceso hecho en campo por alguien que \
entrevistó al personal que lo ejecuta.

Tu trabajo es producir un documento paralelo que le sirva a la coordinación para \
decidir. No reescribes el levantamiento: lo interpretas.

Reglas que no puedes romper:
- No inventes datos. Si algo no está en el levantamiento, dilo como vacío detectado, \
no lo completes con lo que suele pasar en otras clínicas.
- Distingue siempre lo que la persona dijo de lo que tú deduces.
- Escribe en español de Colombia, claro y directo, sin jerga de consultoría. \
Quien lee esto coordina una clínica, no compra metodologías.
- Sé concreto en las propuestas: "que al digitar la cédula traiga los datos del \
paciente" sirve; "implementar una solución de gestión documental" no sirve.
- Si el levantamiento está muy incompleto, dilo con franqueza en 'calidad' en vez de \
producir un análisis bonito sobre nada.
- Las fotos son parte del levantamiento, no decoración: léelas. Un formato en papel \
fotografiado dice qué campos se llenan a mano, y eso casi nunca está escrito.
- No puedes escuchar las notas de voz. Nunca supongas qué dicen. Si un punto queda \
flojo porque la respuesta está en un audio, señálalo en 'audios_por_escuchar'.

Respondes ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después y sin \
marcas de código. Esta es la forma exacta:

{
  "resumen": "4 a 6 líneas sobre qué hace este proceso y qué problema real tiene",
  "calidad": {
    "completitud": "alta | media | baja",
    "vacios": ["qué falta preguntar, en lenguaje de pregunta concreta"]
  },
  "pasos_mejorados": [
    {"n": 1, "actividad": "...", "responsable": "...", "sistema": "...",
     "observacion": "qué se aclaró o corrigió frente a lo que quedó escrito"}
  ],
  "dolores": [
    {"dolor": "...", "impacto": "a qué afecta: tiempo, glosas, paciente, reprocesos"}
  ],
  "optimizaciones": [
    {"propuesta": "...", "por_que": "...", "esfuerzo": "bajo | medio | alto",
     "impacto": "bajo | medio | alto"}
  ],
  "automatizaciones": [
    {"propuesta": "...", "que_haria_el_sistema": "...", "requisito": "qué hace falta para poder hacerlo"}
  ],
  "riesgos": ["..."],
  "hallazgos_en_fotos": [
    {"foto": 1, "observacion": "qué se ve ahí que no estaba escrito, o que lo contradice"}
  ],
  "audios_por_escuchar": [
    {"donde": "la pregunta o actividad donde está", "por_que": "qué esperas que aclare"}
  ],
  "conexiones": [
    {"proceso": "nombre exacto de la lista de procesos existentes, o el nombre tal como lo mencionaron",
     "direccion": "antes | despues",
     "razon": "por qué crees que conectan",
     "confianza": "alta | media | baja"}
  ],
  "preguntas_para_la_siguiente_visita": ["..."]
}

Las listas pueden ir vacías si no hay nada que decir. Prefiere tres cosas buenas a \
diez de relleno."""


def _pedir(llave, modelo, contenido, max_tokens=8000, sistema=None):
    if isinstance(contenido, str):
        contenido = [{"type": "text", "text": contenido}]
    cuerpo = json.dumps({
        "model": modelo,
        "max_tokens": max_tokens,
        "system": sistema or SISTEMA,
        "messages": [{"role": "user", "content": contenido}],
    }).encode("utf-8")

    req = urllib.request.Request(API_URL, data=cuerpo, method="POST", headers={
        "content-type": "application/json",
        "x-api-key": llave,
        "anthropic-version": "2023-06-01",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detalle = ""
        try:
            detalle = json.loads(e.read().decode("utf-8")).get("error", {}).get("message", "")
        except Exception:
            pass
        if e.code == 401:
            raise IAError("llave_invalida", detalle)
        if e.code == 429:
            raise IAError("limite_alcanzado", detalle)
        if e.code == 400 and "credit" in detalle.lower():
            raise IAError("sin_saldo", detalle)
        raise IAError("error_api", f"HTTP {e.code}: {detalle}")
    except urllib.error.URLError as e:
        raise IAError("sin_conexion", str(e.reason))
    except Exception as e:
        raise IAError("error_api", str(e))


def _cierres(prefijo):
    """Qué llaves y corchetes quedaron abiertos en este trozo."""
    pila = []
    en_cadena = escapado = False
    for ch in prefijo:
        if escapado:
            escapado = False
        elif ch == "\\":
            escapado = True
        elif ch == '"':
            en_cadena = not en_cadena
        elif not en_cadena:
            if ch in "{[":
                pila.append(ch)
            elif ch in "}]" and pila:
                pila.pop()
    if en_cadena:
        return None                       # cortado dentro de una cadena
    return "".join("}" if c == "{" else "]" for c in reversed(pila))


def _cerrar_json(t):
    """Rescata un JSON truncado.

    Se va recortando desde el final hasta dar con un punto donde lo que
    queda, más los cierres que falten, sea válido. Se pierde la cola pero
    se salva el análisis, que suele traer lo importante al principio.
    """
    t = t.rstrip()
    intentos = 0
    for i in range(len(t) - 1, 0, -1):
        if t[i] not in '}]"0123456789eslu':       # fin de valor plausible
            continue
        intentos += 1
        if intentos > 4000:
            break
        trozo = re.sub(r",\s*$", "", t[:i + 1])
        cierre = _cierres(trozo)
        if cierre is None:
            continue
        try:
            datos = json.loads(trozo + cierre)
            if isinstance(datos, dict) and datos:
                return trozo + cierre
        except ValueError:
            continue
    return ""


def _extraer_json(texto, contexto=None):
    """Claude a veces enmarca el JSON aunque se le pida que no. Se limpia."""
    contexto = contexto or {}
    t = (texto or "").strip()
    if not t:
        raise IAError("respuesta_vacia",
                      "Claude no devolvió texto. " + _pista(contexto),
                      "", contexto)

    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)

    for candidato in (t, t[t.find("{"): t.rfind("}") + 1] if "{" in t else "",
                      _cerrar_json(t)):
        if not candidato:
            continue
        try:
            datos = json.loads(candidato)
            if isinstance(datos, dict):
                if candidato != t:
                    datos["_recuperado"] = True
                return datos
        except ValueError:
            continue

    raise IAError("respuesta_ilegible", _pista(contexto), t, contexto)


def _pista(contexto):
    """Traduce el motivo técnico a algo que se pueda actuar."""
    razon = contexto.get("stop_reason")
    if razon == "max_tokens":
        return ("La respuesta se cortó por llegar al límite de longitud: el proceso "
                "es muy extenso. Vuelve a intentarlo; si se repite, reduce el detalle "
                "de las actividades o analiza por partes.")
    if razon == "refusal":
        return "Claude se negó a responder sobre este contenido."
    if razon in ("pause_turn", "tool_use"):
        return f"La respuesta terminó de forma inesperada ({razon})."
    return ("Devolvió texto que no era el JSON esperado. Suele resolverse "
            "intentando de nuevo.")


def analizar(texto_proceso, lista_procesos, imagenes=None, modelo=None):
    """Devuelve (analisis, modelo, uso).

    imagenes: lista de {"etiqueta": str, "datos": bytes, "tipo": str}
    """
    llave = leer_llave()
    if not llave:
        raise IAError("sin_llave")

    modelo = modelo or MODELO_DEFECTO
    catalogo = "\n".join(f"- {p}" for p in lista_procesos) or "- (ninguno todavía)"
    prompt = (
        "Analiza este levantamiento de proceso.\n\n"
        "Procesos ya registrados en la clínica, para que puedas proponer conexiones "
        "usando sus nombres exactos:\n" + catalogo +
        "\n\n=== LEVANTAMIENTO ===\n" + texto_proceso
    )

    contenido = [{"type": "text", "text": prompt}]
    for i, img in enumerate(imagenes or []):
        contenido.append({"type": "text",
                          "text": f"\nFoto {i+1} — tomada en «{img['etiqueta']}»:"})
        contenido.append({"type": "image", "source": {
            "type": "base64", "media_type": img["tipo"],
            "data": base64.b64encode(img["datos"]).decode("ascii")}})
    if imagenes:
        contenido.append({"type": "text", "text":
            "\nLee las fotos: suelen traer el formato en papel, la pantalla del "
            "sistema o el letrero pegado en la pared. Si ves algo que contradice o "
            "completa lo que escribieron, dilo explícitamente en 'hallazgos_en_fotos'."})

    data = _pedir(llave, modelo, contenido)
    texto = "".join(b.get("text", "") for b in data.get("content", [])
                    if b.get("type") == "text")
    uso = data.get("usage", {})
    contexto = {
        "stop_reason": data.get("stop_reason"),
        "modelo": data.get("model", modelo),
        "tokens_salida": uso.get("output_tokens", 0),
        "tokens_entrada": uso.get("input_tokens", 0),
        "caracteres": len(texto),
    }

    try:
        analisis = _extraer_json(texto, contexto)
    except IAError as e:
        if e.codigo != "respuesta_ilegible":
            raise
        # Segunda oportunidad: se le devuelve lo que escribió y se le pide
        # que lo entregue como JSON válido, sin nada más.
        try:
            reparado = _pedir(llave, modelo,
                              "Esto debía ser un único objeto JSON válido pero no lo es. "
                              "Devuélvelo corregido, completo y sin texto alrededor ni "
                              "marcas de código:\n\n" + texto[:12000])
            t2 = "".join(b.get("text", "") for b in reparado.get("content", [])
                         if b.get("type") == "text")
            analisis = _extraer_json(t2, contexto)
            analisis["_reparado"] = True
        except IAError:
            raise e

    return analisis, contexto["modelo"], {
        "entrada": contexto["tokens_entrada"],
        "salida": contexto["tokens_salida"],
        "corte": contexto["stop_reason"],
    }


SISTEMA_LOTE = """Eres un arquitecto de sistemas de información en salud. Recibes \
varios levantamientos de procesos de una misma clínica y tu trabajo es mirarlos \
en conjunto, no uno por uno.

Este análisis alimenta el diseño de los módulos de un sistema que va a reemplazar \
lo que hoy hacen en papel y en herramientas sueltas. Así que lo que digas tiene \
consecuencias: si agrupas mal, se construye un módulo que nadie usa.

Reglas:
- No inventes. Si dos procesos parecen conectar pero nadie lo dijo, márcalo como \
hipótesis con confianza baja, no como hecho.
- Las fotos son evidencia de primera mano: un formato en papel fotografiado te dice \
exactamente qué campos necesita una pantalla. Léelas con atención y sé específico: \
nombra los campos que ves.
- Busca lo que se repite. Si tres procesos piden los mismos datos del paciente, eso \
es una sola funcionalidad, no tres.
- Distingue el proceso de la herramienta. "Lo llevan en Excel" no es un proceso, es \
un síntoma.
- En español de Colombia, concreto. Quien lee esto va a construir software.

Respondes ÚNICAMENTE con un objeto JSON válido, sin texto alrededor ni marcas de código:

{
  "panorama": "6 a 10 líneas sobre qué muestran estos procesos vistos juntos",
  "cadenas": [
    {"nombre": "cómo llamarías a esta cadena de trabajo",
     "procesos": ["nombres exactos, en el orden en que ocurren"],
     "descripcion": "qué recorre el caso de punta a punta",
     "rupturas": ["dónde se rompe la cadena hoy: reprocesos, saltos a papel, datos que se repiten"]}
  ],
  "conexiones": [
    {"de": "nombre exacto", "a": "nombre exacto",
     "que_pasa": "qué se entrega concretamente",
     "confianza": "alta | media | baja",
     "declarada": true}
  ],
  "duplicidades": [
    {"que_se_repite": "el dato, la validación o el paso que aparece en varios",
     "procesos": ["nombres"],
     "propuesta": "cómo resolverlo de una sola vez"}
  ],
  "modulos_sugeridos": [
    {"modulo": "nombre del módulo",
     "cubre": ["nombres de los procesos que quedarían dentro"],
     "funciones": ["qué tiene que saber hacer, en frases concretas"],
     "datos_clave": ["los campos que vio en las fotos y formatos, con su nombre real"],
     "prioridad": "alta | media | baja",
     "por_que": "qué dolor concreto resuelve"}
  ],
  "hallazgos_en_fotos": [
    {"foto": 1, "proceso": "a qué proceso pertenece", "observacion": "qué se ve, con detalle: campos, sellos, casillas"}
  ],
  "vacios": ["qué falta levantar para poder diseñar con seguridad"],
  "siguiente_paso": "qué haría usted primero, en una frase"
}

Las listas pueden ir vacías. Prefiere precisión a cantidad."""


def analizar_lote(bloques, imagenes=None, modelo=None):
    """Analiza varios procesos juntos: relaciones, duplicidades y módulos.

    bloques: lista de textos, uno por proceso, ya armados.
    """
    llave = leer_llave()
    if not llave:
        raise IAError("sin_llave")

    modelo = modelo or MODELO_DEFECTO
    prompt = ("Analiza estos " + str(len(bloques)) + " procesos EN CONJUNTO.\n\n"
              + "\n\n" + ("=" * 60) + "\n\n".join(bloques))

    contenido = [{"type": "text", "text": prompt}]
    for i, img in enumerate(imagenes or []):
        contenido.append({"type": "text",
                          "text": f"\nFoto {i+1} — proceso «{img['proceso']}», en «{img['etiqueta']}»:"})
        contenido.append({"type": "image", "source": {
            "type": "base64", "media_type": img["tipo"],
            "data": base64.b64encode(img["datos"]).decode("ascii")}})
    if imagenes:
        contenido.append({"type": "text", "text":
            "\nLas fotos son la mejor fuente para 'datos_clave': cuando veas un formato, "
            "enumera los campos que pide. Eso es lo que va a tener que tener la pantalla."})

    data = _pedir(llave, modelo, contenido, max_tokens=16000, sistema=SISTEMA_LOTE)
    texto = "".join(b.get("text", "") for b in data.get("content", [])
                    if b.get("type") == "text")
    uso = data.get("usage", {})
    contexto = {"stop_reason": data.get("stop_reason"),
                "modelo": data.get("model", modelo),
                "tokens_salida": uso.get("output_tokens", 0),
                "tokens_entrada": uso.get("input_tokens", 0),
                "caracteres": len(texto)}
    analisis = _extraer_json(texto, contexto)
    return analisis, contexto["modelo"], {
        "entrada": contexto["tokens_entrada"],
        "salida": contexto["tokens_salida"],
        "corte": contexto["stop_reason"],
    }


def probar_llave(modelo=None):
    """Una llamada mínima, para avisar antes de que falle en medio del trabajo."""
    llave = leer_llave()
    if not llave:
        raise IAError("sin_llave")
    cuerpo = json.dumps({
        "model": modelo or MODELO_DEFECTO,
        "max_tokens": 16,
        "messages": [{"role": "user", "content": "Responde solo: ok"}],
    }).encode("utf-8")
    req = urllib.request.Request(API_URL, data=cuerpo, method="POST", headers={
        "content-type": "application/json",
        "x-api-key": llave,
        "anthropic-version": "2023-06-01",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read().decode("utf-8"))
            return d.get("model", modelo or MODELO_DEFECTO)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise IAError("llave_invalida")
        raise IAError("error_api", f"HTTP {e.code}")
    except Exception as e:
        raise IAError("sin_conexion", str(e))
