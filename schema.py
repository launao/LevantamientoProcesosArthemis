"""
schema.py — Creación idempotente de tablas y semilla inicial.

Se ejecuta en cada arranque (init_db). No borra nada existente.
"""
import os
import uuid
import db as D
from auth import hash_password

# ─────────────────────────────────────────────────────────────────────────────
# DDL
# ─────────────────────────────────────────────────────────────────────────────

def _ddl():
    pg = D.USE_PG
    txt = "TEXT"
    ts = "TIMESTAMPTZ DEFAULT NOW()" if pg else "TEXT DEFAULT CURRENT_TIMESTAMP"
    blob = "BYTEA" if pg else "BLOB"
    intt = "INTEGER"
    boolt = "BOOLEAN DEFAULT TRUE" if pg else "INTEGER DEFAULT 1"

    return [
        f"""CREATE TABLE IF NOT EXISTS usuarios (
              id            {txt} PRIMARY KEY,
              usuario       {txt} UNIQUE NOT NULL,
              nombre        {txt} NOT NULL,
              rol           {txt} NOT NULL DEFAULT 'analista',
              contacto      {txt},
              password_hash {txt} NOT NULL,
              activo        {boolt},
              creado        {ts}
            )""",

        f"""CREATE TABLE IF NOT EXISTS config (
              id         {intt} PRIMARY KEY,
              data       {txt} NOT NULL,
              actualizado {ts}
            )""",

        f"""CREATE TABLE IF NOT EXISTS plantilla (
              id          {intt} PRIMARY KEY,
              data        {txt} NOT NULL,
              version     {intt} DEFAULT 1,
              actualizado {ts}
            )""",

        f"""CREATE TABLE IF NOT EXISTS procesos (
              id              {txt} PRIMARY KEY,
              codigo          {txt},
              nombre          {txt} NOT NULL,
              area            {txt},
              responsable_id  {txt},
              estado          {txt} DEFAULT 'pendiente',
              prioridad       {txt},
              notas           {txt},
              respuestas      {txt} DEFAULT '{{}}',
              creado          {ts},
              creado_por      {txt},
              actualizado     {ts},
              actualizado_por {txt}
            )""",

        f"""CREATE TABLE IF NOT EXISTS media (
              id           {txt} PRIMARY KEY,
              proceso_id   {txt},
              content_type {txt} NOT NULL,
              tamano       {intt} DEFAULT 0,
              nombre       {txt},
              data         {blob},
              ruta         {txt},
              creado       {ts}
            )""",

        f"""CREATE TABLE IF NOT EXISTS evidencias (
              id         {txt} PRIMARY KEY,
              proceso_id {txt} NOT NULL,
              campo_id   {txt},
              tipo       {txt} NOT NULL,
              media_id   {txt},
              nota       {txt},
              autor_id   {txt},
              creado     {ts}
            )""",

        f"""CREATE TABLE IF NOT EXISTS capture_tokens (
              token      {txt} PRIMARY KEY,
              proceso_id {txt} NOT NULL,
              campo_id   {txt},
              creado_por {txt},
              expira     {txt} NOT NULL,
              usos       {intt} DEFAULT 0,
              activo     {boolt},
              creado     {ts}
            )""",

        f"""CREATE TABLE IF NOT EXISTS envios (
              id         {txt} PRIMARY KEY,
              proceso_id {txt} NOT NULL,
              usuario_id {txt},
              numero     {intt} DEFAULT 1,
              resumen    {txt},
              avance     {intt} DEFAULT 0,
              fotos      {intt} DEFAULT 0,
              audios     {intt} DEFAULT 0,
              creado     {ts}
            )""",

        f"""CREATE TABLE IF NOT EXISTS versiones (
              id          {txt} PRIMARY KEY,
              proceso_id  {txt} NOT NULL,
              respuestas  {txt} NOT NULL,
              nombre      {txt},
              usuario_id  {txt},
              motivo      {txt},
              creado      {ts}
            )""",

        f"""CREATE TABLE IF NOT EXISTS share_tokens (
              token      {txt} PRIMARY KEY,
              proceso_id {txt} NOT NULL,
              creado_por {txt},
              vistas     {intt} DEFAULT 0,
              activo     {boolt},
              creado     {ts}
            )""",

        f"""CREATE TABLE IF NOT EXISTS auditoria (
              id         {txt} PRIMARY KEY,
              usuario_id {txt},
              accion     {txt},
              entidad    {txt},
              entidad_id {txt},
              detalle    {txt},
              ip         {txt},
              creado     {ts}
            )""",

        "CREATE INDEX IF NOT EXISTS ix_proc_area ON procesos(area)",
        "CREATE INDEX IF NOT EXISTS ix_proc_estado ON procesos(estado)",
        "CREATE INDEX IF NOT EXISTS ix_proc_resp ON procesos(responsable_id)",
        "CREATE INDEX IF NOT EXISTS ix_ev_proc ON evidencias(proceso_id)",
        "CREATE INDEX IF NOT EXISTS ix_aud_creado ON auditoria(creado)",
        "CREATE INDEX IF NOT EXISTS ix_tok_proc ON capture_tokens(proceso_id)",
        "CREATE INDEX IF NOT EXISTS ix_env_proc ON envios(proceso_id)",
        "CREATE INDEX IF NOT EXISTS ix_ver_proc ON versiones(proceso_id)",
        "CREATE INDEX IF NOT EXISTS ix_share_proc ON share_tokens(proceso_id)",
    ]


# Columnas añadidas después de la primera versión. Se agregan solo si faltan,
# para que un despliegue existente se actualice sin perder datos.
COLUMNAS_NUEVAS = [
    ("evidencias", "duracion", "INTEGER DEFAULT 0"),
    ("evidencias", "origen", "TEXT"),
    ("media", "sha1", "TEXT"),
    ("procesos", "enviado_en", "TEXT"),
    ("procesos", "enviado_por", "TEXT"),
    ("procesos", "envios_total", "INTEGER DEFAULT 0"),
    ("procesos", "fecha_limite", "TEXT"),
    ("procesos", "contacto", "TEXT"),
    ("procesos", "eliminado", "INTEGER DEFAULT 0"),
    ("procesos", "atiende", "TEXT"),
    ("procesos", "notas_clinica", "TEXT"),
    ("procesos", "propuesto_por", "TEXT"),
]


def _migrar_columnas():
    for tabla, col, tipo in COLUMNAS_NUEVAS:
        try:
            D.execute(f"ALTER TABLE {tabla} ADD COLUMN {col} {tipo}")
            print(f"[schema] columna añadida: {tabla}.{col}")
        except Exception:
            pass  # ya existe


# ─────────────────────────────────────────────────────────────────────────────
# Plantilla por defecto
# ─────────────────────────────────────────────────────────────────────────────

def _c(cid, etiqueta, tipo, obligatorio=False, opciones=None, ayuda="",
       catalogo="", pregunta="", ejemplo=""):
    """Un campo de la plantilla.

    etiqueta  — nombre corto, el que sale en tablas y exportaciones
    pregunta  — cómo preguntárselo a la persona, en voz alta
    ayuda     — qué se espera que responda
    ejemplo   — una respuesta real, para que no arranque de cero
    """
    return {"id": cid, "etiqueta": etiqueta, "tipo": tipo,
            "obligatorio": obligatorio, "opciones": opciones or [],
            "ayuda": ayuda, "catalogo": catalogo,
            "pregunta": pregunta or etiqueta, "ejemplo": ejemplo}


# Se sube este número cada vez que la plantilla base estrena campos. Sirve
# para sembrarlos UNA sola vez en las instalaciones que ya existen: si
# alguien borra un campo a propósito, no se lo devolvemos en cada arranque.
PLANTILLA_BASE_VERSION = 3

PLANTILLA_DEFAULT = {"secciones": [
    {"id": "s_id", "nombre": "1. Identificación", "campos": [
        _c("f_objetivo", "Objetivo del proceso", "parrafo", True,
           pregunta="¿Para qué existe este proceso? ¿Qué pasaría si nadie lo hiciera?",
           ayuda="Una o dos frases. No hace falta que sea formal.",
           ejemplo="Registrar al paciente que llega a urgencias para que quede en el sistema y se le pueda facturar a la EPS."),
        _c("f_dueno", "Dueño del proceso", "texto", True,
           pregunta="¿Quién responde por este proceso cuando algo sale mal?",
           ayuda="El cargo, no necesariamente el nombre.",
           ejemplo="Coordinadora de Admisiones"),
        _c("f_clase", "Clasificación", "lista", True, catalogo="cat_clase",
           pregunta="¿Qué tipo de proceso es?",
           ayuda="Misional es lo que se hace con el paciente. De apoyo es lo que sostiene al resto."),
        _c("f_norma", "Normativa aplicable", "parrafo",
           pregunta="¿Hay alguna norma, resolución o requisito de habilitación que obligue a hacerlo así?",
           ayuda="Si no sabes, déjalo vacío y se revisa después.",
           ejemplo="Resolución 3100 de 2019, habilitación de urgencias."),
        _c("f_freq", "Frecuencia", "texto",
           pregunta="¿Cada cuánto se hace? ¿Cuántas veces al día o al mes?",
           ejemplo="Unas 120 veces al día, más en fines de semana."),
    ]},
    {"id": "s_alc", "nombre": "2. Dónde empieza y dónde termina", "campos": [
        _c("f_inicio", "Evento que lo inicia", "texto", True,
           pregunta="¿Qué tiene que pasar para que usted empiece a hacer esto?",
           ayuda="El disparador. Alguien llega, suena el teléfono, llega un correo.",
           ejemplo="El paciente llega al kiosco y saca su turno."),
        _c("f_fin", "Evento que lo cierra", "texto", True,
           pregunta="¿En qué momento usted dice “ya, terminé”?",
           ejemplo="Cuando el paciente queda admitido y pasa a la sala de espera del consultorio."),
        _c("f_entradas", "Entradas", "parrafo",
           pregunta="¿Qué necesita tener a la mano para poder hacerlo?",
           ayuda="Documentos, datos, autorizaciones, equipos.",
           ejemplo="Cédula del paciente, carné de la EPS y el turno del kiosco."),
        _c("f_salidas", "Salidas", "parrafo",
           pregunta="¿Qué queda hecho o impreso cuando termina?",
           ejemplo="La admisión abierta en el sistema y el brazalete impreso."),
        _c("f_excl", "Exclusiones", "parrafo",
           pregunta="¿Hay algo parecido que usted NO hace en este proceso?",
           ayuda="Sirve para no confundirlo con otro proceso.",
           ejemplo="No incluye el triage: eso lo hace la enfermera antes."),
    ]},
    {"id": "s_act", "nombre": "3. Quién participa y con qué", "campos": [
        _c("f_roles", "Roles que participan", "parrafo", True,
           pregunta="¿Quiénes intervienen, además de usted?",
           ayuda="Cargos, no nombres propios.",
           ejemplo="Admisionista, enfermera de triage, auxiliar de facturación."),
        _c("f_sist", "Sistemas o soportes que usa hoy", "multi", catalogo="cat_sistemas",
           pregunta="¿En qué lo registra? Marque todo lo que use, incluso lo informal.",
           ayuda="Si usa algo que no está en la lista, escríbalo en la casilla “Otro”."),
        _c("f_sist_det", "Para qué usa cada uno", "parrafo",
           pregunta="¿Y para qué usa cada uno de esos?",
           ejemplo="Agilmed para la admisión, la planilla en papel para el consecutivo, y WhatsApp para avisarle a facturación."),
        _c("f_prov", "De quién recibe", "texto",
           pregunta="¿Quién le pasa el trabajo o la información antes de usted?",
           ejemplo="La enfermera de triage."),
        _c("f_cli", "A quién le entrega", "texto",
           pregunta="¿A quién le sirve lo que usted hace? ¿Quién sigue después?",
           ejemplo="El médico del consultorio y el área de facturación."),
    ]},
    {"id": "s_flu", "nombre": "4. Paso a paso", "campos": [
        _c("f_pasos", "Actividades", "pasos", True,
           pregunta="Cuénteme paso a paso qué hace, desde que empieza hasta que termina.",
           ayuda="Una fila por cada cosa que hace. En cada fila puede abrir el detalle y explicar cómo se hace, qué datos escribe o qué revisa."),
        _c("f_dec", "Qué pasa cuando algo se sale de lo normal", "parrafo",
           pregunta="¿Qué hace si el paciente no tiene cédula, si el sistema se cae, si la EPS no aparece?",
           ayuda="Aquí es donde está el conocimiento que no está escrito en ninguna parte.",
           ejemplo="Si Agilmed se cae, anoto en una hoja y lo digito cuando vuelve. Si la EPS no aparece, llamo a la coordinadora."),
    ]},
    {"id": "s_dol", "nombre": "5. Qué le complica el trabajo", "campos": [
        _c("f_dolor", "Puntos de dolor", "parrafo", True,
           pregunta="¿Qué es lo que más tiempo le quita o más rabia le da de este proceso?",
           ayuda="Con toda confianza. Esto es lo que más sirve para mejorarlo.",
           ejemplo="Tengo que escribir los mismos datos en el sistema y en la planilla. Y si el paciente ya vino antes, igual toca preguntarle todo otra vez."),
        _c("f_riesgo", "Riesgos", "parrafo",
           pregunta="¿Qué puede salir mal y qué consecuencias trae?",
           ejemplo="Si se digita mal la EPS, la cuenta se glosa y toca rehacerla."),
        _c("f_ctrl", "Controles que ya existen", "parrafo",
           pregunta="¿Alguien revisa lo que usted hace? ¿Cómo se dan cuenta si hubo un error?",
           ejemplo="Facturación revisa al día siguiente y devuelve las que están malas."),
        _c("f_crit", "Criticidad", "lista", False, catalogo="cat_criticidad",
           pregunta="Si este proceso se detiene un día, ¿qué tan grave es?"),
    ]},
    {"id": "s_ind", "nombre": "6. Tiempos y medición", "campos": [
        _c("f_tiempo", "Tiempo del ciclo", "texto",
           pregunta="¿Cuánto se demora normalmente, de principio a fin?",
           ejemplo="Unos 6 minutos por paciente, si todo sale bien."),
        _c("f_ind", "Indicadores actuales", "parrafo",
           pregunta="¿Se mide algo de este proceso hoy? ¿Alguien le pide cifras?",
           ayuda="Si no se mide nada, escríbalo así. También es un hallazgo.",
           ejemplo="No se mide nada. Solo el conteo de admisiones del día."),
    ]},
    {"id": "s_bre", "nombre": "7. Qué se podría mejorar", "campos": [
        _c("f_soporte", "¿Cómo se soporta hoy?", "lista", False, catalogo="cat_soporte",
           pregunta="¿Qué parte del proceso está en el sistema y qué parte sigue en papel?"),
        _c("f_req", "Qué le gustaría que hiciera el sistema", "parrafo",
           pregunta="Si pudiera pedir un cambio, ¿cuál pediría?",
           ayuda="La respuesta de quien hace el trabajo suele ser la mejor pista.",
           ejemplo="Que al digitar la cédula ya me traiga los datos del paciente si vino antes."),
        _c("f_cobertura", "Cobertura del sistema actual", "lista", False, catalogo="cat_cobertura",
           pregunta="(Para el analista) ¿Qué tanto cubre el sistema este proceso?"),
    ]},
    {"id": "s_con", "nombre": "8. Qué pasa antes y qué sigue después", "campos": [
        _c("f_antes_texto", "Qué pasa antes", "parrafo",
           pregunta="Antes de que usted haga esto, ¿qué tuvo que pasar? ¿Quién se lo entrega?",
           ayuda="Dígalo con sus palabras, no importa el nombre técnico. Vale “me lo pasa la niña de la entrada” o “llega el correo de la EPS”.",
           ejemplo="La chica del call center ya agendó la cita el día anterior, y el paciente llega con el turno del kiosco."),
        _c("f_viene_de", "Procesos que vienen antes", "procesos",
           pregunta="De lo que acaba de contar, ¿alguno de estos procesos es el que le entrega el trabajo?",
           ayuda="PARA QUIEN ENTREVISTA: marque solo si el proceso ya está levantado en la lista. Si el que menciona no aparece, no marque nada: quedó escrito arriba y lo enlazamos cuando alguien lo levante."),
        _c("f_despues_texto", "Qué sigue después", "parrafo", True,
           pregunta="Cuando usted termina, ¿qué pasa con el paciente o con el caso? ¿A quién le queda el turno?",
           ayuda="La pregunta clave. Si responde “ya, nada más”, valga la pena repreguntar: ¿y el papel dónde queda? ¿alguien lo revisa después?",
           ejemplo="Le entrego la historia a la enfermera de optometría y el paciente pasa a la sala de espera. La copia física va a facturación al final del día."),
        _c("f_va_hacia", "Procesos que siguen después", "procesos",
           pregunta="De lo que sigue, ¿alguno de estos procesos es el que recibe?",
           ayuda="PARA QUIEN ENTREVISTA: esto arma el mapa de la clínica. Si lo que sigue todavía no está levantado, déjelo escrito arriba y avísele a la coordinación: es un proceso que falta."),
    ]},
    {"id": "s_cie", "nombre": "9. Cierre", "campos": [
        _c("f_valida", "Validado con", "persona",
           pregunta="¿Con quién del equipo se revisó y confirmó esta información?"),
        _c("f_obs", "Observaciones finales", "parrafo",
           pregunta="¿Algo más que quiera agregar que no le haya preguntado?",
           ayuda="Esta pregunta suele traer lo más valioso. Vale la pena hacerla siempre."),
    ]},
]}


CONFIG_DEFAULT = {
    "proyecto": os.environ.get("APP_NOMBRE", "Levantamiento de Procesos"),
    "organizacion": os.environ.get("APP_ORG", ""),
    "areas": ["Admisiones", "Call center", "Caja", "Tesorería", "Facturación",
              "Optometría", "Oftalmología", "Dilatación", "Enfermería",
              "Cirugía", "Calidad", "TI"],
    # Cuántos levantamientos se consideran razonables en un mismo día.
    # Pasado ese número, la app avisa: una persona no rinde igual en la
    # cuarta entrevista del día que en la primera.
    "maxPorDia": 3,
    "estados": [
        {"k": "pendiente", "n": "Borrador"},
        {"k": "en_curso", "n": "En curso"},
        {"k": "en_revision", "n": "Enviado"},
        {"k": "aprobado", "n": "Aprobado"},
    ],
    # Listas con nombre que cualquier campo de la plantilla puede reutilizar,
    # para no repetir las mismas opciones en veinte lugares.
    "catalogos": [
        {"id": "cat_clase", "nombre": "Clasificación del proceso",
         "opciones": ["Estratégico", "Misional", "De apoyo", "De evaluación y control"]},
        {"id": "cat_criticidad", "nombre": "Criticidad",
         "opciones": ["Baja", "Media", "Alta", "Crítica"]},
        {"id": "cat_soporte", "nombre": "Soporte actual",
         "opciones": ["100% papel", "Mixto papel/digital", "Digital fuera del sistema", "Ya en el sistema"]},
        {"id": "cat_cobertura", "nombre": "Cobertura del sistema",
         "opciones": ["No existe", "Parcial", "Cubierto"]},
        {"id": "cat_sistemas", "nombre": "Sistemas y soportes",
         "opciones": ["Agilmed", "Arthemis", "Papel / formato impreso", "Cuaderno o planilla",
                      "Excel", "Correo electrónico", "WhatsApp", "Llamada telefónica",
                      "Verbal / personalmente", "Carpeta compartida", "Otro sistema"]},
        {"id": "cat_frecuencia", "nombre": "Frecuencia",
         "opciones": ["Por evento", "Diaria", "Semanal", "Mensual", "Trimestral", "Anual"]},
    ],
}


# ─────────────────────────────────────────────────────────────────────────────
# Init
# ─────────────────────────────────────────────────────────────────────────────

# Campos cuya redacción se mejoró después de haberse sembrado. Se reescriben
# solo si el texto guardado es exactamente el que puso el sistema antes: si
# alguien lo editó, se respeta lo suyo.
RETOQUES = {
    "f_viene_de": {
        "antes": "¿De qué otro proceso le llega el trabajo a usted?",
        "etiqueta": "Procesos que vienen antes",
        "pregunta": "De lo que acaba de contar, ¿alguno de estos procesos es el que le entrega el trabajo?",
        "ayuda": "PARA QUIEN ENTREVISTA: marque solo si el proceso ya está levantado en la lista. Si el que menciona no aparece, no marque nada: quedó escrito arriba y lo enlazamos cuando alguien lo levante.",
    },
    "f_va_hacia": {
        "antes": "Cuando usted termina, ¿a qué otro proceso pasa el caso?",
        "etiqueta": "Procesos que siguen después",
        "pregunta": "De lo que sigue, ¿alguno de estos procesos es el que recibe?",
        "ayuda": "PARA QUIEN ENTREVISTA: esto arma el mapa de la clínica. Si lo que sigue todavía no está levantado, déjelo escrito arriba y avísele a la coordinación: es un proceso que falta.",
    },
}

# En algunas secciones el orden importa: primero se deja hablar a la persona
# y solo después se le muestran las casillas. Si los campos llegaron en otro
# orden por venir de una versión anterior, se reacomodan al de la base.
SECCIONES_ORDENADAS = ("s_con",)

SECCIONES_RENOMBRADAS = {
    "s_con": ("8. Con qué otros procesos se conecta", "8. Qué pasa antes y qué sigue después"),
}


def init_db():
    with D.conn_ctx() as con:
        cur = con.cursor()
        for stmt in _ddl():
            cur.execute(stmt)
        cur.close()

    _migrar_columnas()

    fila = D.row("SELECT data FROM config WHERE id=1")
    if not fila:
        D.execute("INSERT INTO config (id, data) VALUES (1, ?)", (D.jdump(CONFIG_DEFAULT),))
    else:
        # Un despliegue anterior puede no tener las claves nuevas. Se añaden
        # sin tocar lo que el usuario ya configuró.
        cfg = D.jload(fila["data"], {})
        faltan = {k: v for k, v in CONFIG_DEFAULT.items() if k not in cfg}
        if faltan:
            cfg.update(faltan)
            D.execute("UPDATE config SET data=? WHERE id=1", (D.jdump(cfg),))
            print(f"[schema] configuración completada: {', '.join(faltan)}")

    fila = D.row("SELECT data, version FROM plantilla WHERE id=1")
    if not fila:
        base = dict(PLANTILLA_DEFAULT, _base=PLANTILLA_BASE_VERSION)
        D.execute("INSERT INTO plantilla (id, data, version) VALUES (1, ?, 1)",
                  (D.jdump(base), ))
    else:
        # Una plantilla de una versión anterior no trae la pregunta ni el
        # ejemplo. Se completan campo por campo, respetando cualquier texto
        # que el usuario ya haya escrito.
        tpl = D.jload(fila["data"], {})
        base = {c["id"]: c
                for s in PLANTILLA_DEFAULT["secciones"] for c in s["campos"]}
        tocada = False
        for sec in tpl.get("secciones", []):
            for c in sec.get("campos", []):
                orig = base.get(c.get("id"), {})
                for clave in ("pregunta", "ayuda", "ejemplo", "catalogo"):
                    if not c.get(clave):
                        valor = orig.get(clave) or ("" if clave != "pregunta" else c.get("etiqueta", ""))
                        if valor:
                            c[clave] = valor
                            tocada = True
        for sec in tpl.get("secciones", []):
            viejo_nombre, nuevo_nombre = SECCIONES_RENOMBRADAS.get(sec.get("id"), (None, None))
            if viejo_nombre and sec.get("nombre") == viejo_nombre:
                sec["nombre"] = nuevo_nombre
                tocada = True
            for c in sec.get("campos", []):
                r = RETOQUES.get(c.get("id"))
                if r and c.get("pregunta") == r["antes"]:
                    c["pregunta"] = r["pregunta"]
                    c["ayuda"] = r["ayuda"]
                    c["etiqueta"] = r["etiqueta"]
                    tocada = True

        # Campos nuevos de la plantilla base. Solo se siembran si esta
        # instalación todavía no vio esta versión.
        sembrada = tpl.get("_base", 0)
        ids_existentes = {c.get("id") for s in tpl.get("secciones", [])
                          for c in s.get("campos", [])}
        ids_secciones = {s.get("id") for s in tpl.get("secciones", [])}
        for sec_base in (PLANTILLA_DEFAULT["secciones"]
                         if sembrada < PLANTILLA_BASE_VERSION else []):
            faltantes = [c for c in sec_base["campos"]
                         if c["id"] not in ids_existentes]
            if not faltantes:
                continue
            if sec_base["id"] in ids_secciones:
                destino = next(s for s in tpl["secciones"] if s.get("id") == sec_base["id"])
                destino.setdefault("campos", []).extend(faltantes)
            else:
                tpl.setdefault("secciones", []).append(
                    {"id": sec_base["id"], "nombre": sec_base["nombre"], "campos": faltantes})
            tocada = True
            print(f"[schema] campos añadidos a la plantilla: "
                  f"{', '.join(c['id'] for c in faltantes)}")

        for sec_id in SECCIONES_ORDENADAS:
            sec = next((x for x in tpl.get("secciones", []) if x.get("id") == sec_id), None)
            base = next((x for x in PLANTILLA_DEFAULT["secciones"] if x["id"] == sec_id), None)
            if not sec or not base:
                continue
            orden = [c["id"] for c in base["campos"]]
            actual = [c.get("id") for c in sec.get("campos", [])]
            if set(actual) == set(orden) and actual != orden:
                sec["campos"].sort(key=lambda c: orden.index(c.get("id")))
                tocada = True

        if sembrada < PLANTILLA_BASE_VERSION:
            tpl["_base"] = PLANTILLA_BASE_VERSION
            tocada = True

        if tocada:
            D.execute("UPDATE plantilla SET data=?, version=? WHERE id=1",
                      (D.jdump(tpl), (fila["version"] or 1) + 1))

    if not D.row("SELECT id FROM usuarios LIMIT 1"):
        usuario = os.environ.get("ADMIN_USER", "admin")
        clave = os.environ.get("ADMIN_PASSWORD", "cambiar123")
        D.execute(
            "INSERT INTO usuarios (id, usuario, nombre, rol, password_hash, activo) "
            "VALUES (?,?,?,?,?,?)",
            (str(uuid.uuid4()), usuario, os.environ.get("ADMIN_NOMBRE", "Administrador"),
             "admin", hash_password(clave), True if D.USE_PG else 1),
        )
        print(f"[schema] Usuario inicial creado: {usuario}")
