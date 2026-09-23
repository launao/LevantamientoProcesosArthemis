"""
flujo.py — Dibuja el flujo del proceso.

Se genera en el servidor, no en el navegador, por una razón concreta: el
mismo dibujo tiene que aparecer en la pantalla, en el documento que se
imprime y en el archivo que alguien se descarga y abre sin conexión. Un
SVG hecho aquí sirve para los tres; uno hecho con JavaScript solo para
el primero.

El trazado es por carriles: una columna por actor, y las filas siguen el
orden del recorrido. Es como la gente dibuja un proceso en un tablero.
"""
from html import escape

ANCHO_CARRIL = 230
ALTO_FILA = 96
ALTO_CAJA = 62
MARGEN_X = 24
MARGEN_Y = 70
CABECERA = 44

COLORES = ["#5998B3", "#2E9E6B", "#D9862B", "#8E6FB5", "#C7503F", "#4E8AA6", "#7A9E3F"]

FORMAS = {
    "inicio": {"relleno": "#E7F3EC", "borde": "#2E9E6B", "radio": 28},
    "fin": {"relleno": "#F6E9E7", "borde": "#C7503F", "radio": 28},
    "decision": {"relleno": "#FDF3E0", "borde": "#D9862B", "radio": 8},
    "documento": {"relleno": "#EEF1F6", "borde": "#5C6B85", "radio": 8},
    "espera": {"relleno": "#F2F0EC", "borde": "#8494A2", "radio": 8},
    "tarea": {"relleno": "#FFFFFF", "borde": "#3A7CA5", "radio": 10},
}


def _orden(nodos, flechas):
    """Coloca cada nodo en una fila siguiendo las flechas.

    Se recorre desde los nodos que nadie alimenta. El tope de vueltas
    evita quedarse dando círculos si alguien declaró un ciclo, que en
    procesos reales pasa (un caso que se devuelve a corregir).
    """
    fila = {n["id"]: 0 for n in nodos}
    for _ in range(len(nodos) + 2):
        cambio = False
        for f in flechas:
            if f.get("de") in fila and f.get("a") in fila:
                if fila[f["a"]] <= fila[f["de"]]:
                    fila[f["a"]] = fila[f["de"]] + 1
                    cambio = True
        if not cambio:
            break
    return fila


def _recortar(t, n):
    t = str(t or "")
    return t if len(t) <= n else t[:n - 1] + "…"


def _lineas(texto, ancho=26, maximo=3):
    """Parte el texto en renglones que quepan en la caja."""
    palabras = str(texto or "").split()
    renglones, actual = [], ""
    for p in palabras:
        if len(actual) + len(p) + 1 <= ancho:
            actual = (actual + " " + p).strip()
        else:
            renglones.append(actual)
            actual = p
            if len(renglones) == maximo:
                break
    if actual and len(renglones) < maximo:
        renglones.append(actual)
    if renglones and len(" ".join(renglones)) < len(str(texto or "")):
        renglones[-1] = _recortar(renglones[-1] + "…", ancho)
    return renglones or [""]


def svg(flujo, ancho_max=None):
    """Devuelve el SVG del flujo, o None si no hay nada que dibujar."""
    if not isinstance(flujo, dict):
        return None
    nodos = [n for n in (flujo.get("nodos") or []) if isinstance(n, dict) and n.get("id")]
    if len(nodos) < 2:
        return None
    flechas = [f for f in (flujo.get("flechas") or []) if isinstance(f, dict)]

    actores = flujo.get("actores") or []
    for n in nodos:
        a = n.get("actor") or "Sin asignar"
        if a not in actores:
            actores.append(a)
    if not actores:
        actores = ["Proceso"]

    carril = {a: i for i, a in enumerate(actores)}
    fila = _orden(nodos, flechas)
    filas = max(fila.values()) + 1 if fila else 1

    # Dos nodos en la misma casilla se separan hacia abajo.
    ocupadas = {}
    pos = {}
    for n in sorted(nodos, key=lambda x: fila[x["id"]]):
        c = carril.get(n.get("actor") or "Sin asignar", 0)
        f = fila[n["id"]]
        while (c, f) in ocupadas:
            f += 1
            filas = max(filas, f + 1)
        ocupadas[(c, f)] = n["id"]
        pos[n["id"]] = (c, f)

    ancho = MARGEN_X * 2 + len(actores) * ANCHO_CARRIL
    alto = MARGEN_Y + CABECERA + filas * ALTO_FILA + 20

    def centro(nid):
        c, f = pos[nid]
        return (MARGEN_X + c * ANCHO_CARRIL + ANCHO_CARRIL / 2,
                MARGEN_Y + CABECERA + f * ALTO_FILA + ALTO_CAJA / 2)

    partes = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {ancho} {alto}" '
        f'width="{ancho}" height="{alto}" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif">',
        '<defs><marker id="pf" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
        'markerHeight="7" orient="auto-start-reverse">'
        '<path d="M0,0 L10,5 L0,10 z" fill="#6B7C8B"/></marker></defs>',
        f'<rect width="{ancho}" height="{alto}" fill="#FCFBF9"/>',
    ]

    # Carriles
    for a, i in carril.items():
        x = MARGEN_X + i * ANCHO_CARRIL
        color = COLORES[i % len(COLORES)]
        if i % 2:
            partes.append(f'<rect x="{x}" y="{MARGEN_Y}" width="{ANCHO_CARRIL}" '
                          f'height="{alto - MARGEN_Y - 10}" fill="#F4F6F3"/>')
        partes.append(
            f'<rect x="{x + 4}" y="{MARGEN_Y}" width="{ANCHO_CARRIL - 8}" height="32" '
            f'rx="8" fill="{color}" opacity="0.16"/>'
            f'<text x="{x + ANCHO_CARRIL / 2}" y="{MARGEN_Y + 21}" text-anchor="middle" '
            f'font-size="13" font-weight="700" fill="{color}">'
            f'{escape(_recortar(a, 24))}</text>')

    def estorba(c, f1, f2):
        """¿Hay una caja entre estas dos filas del mismo carril?"""
        return any((c, f) in ocupadas for f in range(min(f1, f2) + 1, max(f1, f2)))

    # Flechas primero, para que las cajas queden encima
    for f in flechas:
        if f.get("de") not in pos or f.get("a") not in pos:
            continue
        x1, y1 = centro(f["de"])
        x2, y2 = centro(f["a"])
        c1, f1 = pos[f["de"]]
        c2, f2 = pos[f["a"]]
        y1 += ALTO_CAJA / 2 - 2
        y2 -= ALTO_CAJA / 2 + 2

        if abs(x1 - x2) < 2:
            if estorba(c1, f1, f2):
                # Un salto que se brinca pasos intermedios se va por el
                # costado: si lo dibujáramos recto, la línea atravesaría
                # las cajas del medio y parecería pasar por ellas.
                lado = x1 + (ANCHO_CARRIL - 34) / 2 + 16
                d = (f"M{x1},{y1} L{lado},{y1} L{lado},{y2} L{x2},{y2}")
            else:
                d = f"M{x1},{y1} L{x2},{y2}"
        else:
            medio = (y1 + y2) / 2
            d = f"M{x1},{y1} L{x1},{medio} L{x2},{medio} L{x2},{y2}"
        partes.append(f'<path d="{d}" fill="none" stroke="#6B7C8B" stroke-width="1.6" '
                      f'marker-end="url(#pf)" opacity="0.8"/>')
        if f.get("condicion"):
            if abs(x1 - x2) < 2 and estorba(c1, f1, f2):
                mx, my = x1 + (ANCHO_CARRIL - 34) / 2 + 16, (y1 + y2) / 2
            else:
                mx, my = (x1 + x2) / 2, (y1 + y2) / 2
            texto = escape(_recortar(f["condicion"], 18))
            partes.append(
                f'<rect x="{mx - len(texto) * 3.4 - 6}" y="{my - 9}" '
                f'width="{len(texto) * 6.8 + 12}" height="18" rx="9" fill="#FCFBF9" '
                f'stroke="#DCD6CA"/>'
                f'<text x="{mx}" y="{my + 4}" text-anchor="middle" font-size="11" '
                f'fill="#3C4C5C">{texto}</text>')

    # Cajas
    for n in nodos:
        if n["id"] not in pos:
            continue
        cx, cy = centro(n["id"])
        tipo = (n.get("tipo") or "tarea").lower()
        forma = FORMAS.get(tipo, FORMAS["tarea"])
        w = ANCHO_CARRIL - 34
        x = cx - w / 2
        y = cy - ALTO_CAJA / 2

        if tipo == "decision":
            partes.append(
                f'<path d="M{cx},{y} L{x + w},{cy} L{cx},{y + ALTO_CAJA} L{x},{cy} Z" '
                f'fill="{forma["relleno"]}" stroke="{forma["borde"]}" stroke-width="2"/>')
        else:
            partes.append(
                f'<rect x="{x}" y="{y}" width="{w}" height="{ALTO_CAJA}" '
                f'rx="{forma["radio"]}" fill="{forma["relleno"]}" '
                f'stroke="{forma["borde"]}" stroke-width="2"/>')

        renglones = _lineas(n.get("texto"), 24 if tipo != "decision" else 18, 2)
        base = cy - (len(renglones) - 1) * 7 - (5 if n.get("sistema") else 0)
        for i, r in enumerate(renglones):
            partes.append(
                f'<text x="{cx}" y="{base + i * 14 + 4}" text-anchor="middle" '
                f'font-size="12.5" font-weight="600" fill="#0C1A2A">{escape(r)}</text>')

        pie = " · ".join(x2 for x2 in [n.get("sistema"), n.get("tiempo")] if x2)
        if pie:
            partes.append(
                f'<text x="{cx}" y="{cy + ALTO_CAJA / 2 - 8}" text-anchor="middle" '
                f'font-size="10.5" fill="#6B7C8B">{escape(_recortar(pie, 28))}</text>')

    partes.append("</svg>")
    return "".join(partes)


def a_mermaid(flujo):
    """El mismo flujo en texto, para pegarlo en otra herramienta."""
    if not isinstance(flujo, dict):
        return ""
    nodos = [n for n in (flujo.get("nodos") or []) if n.get("id")]
    if not nodos:
        return ""
    lineas = ["flowchart TD"]
    for n in nodos:
        t = str(n.get("texto") or "").replace('"', "'")
        actor = n.get("actor")
        etiqueta = f"{t}" + (f"<br><i>{actor}</i>" if actor else "")
        tipo = (n.get("tipo") or "tarea").lower()
        if tipo == "decision":
            lineas.append(f'  {n["id"]}{{"{etiqueta}"}}')
        elif tipo in ("inicio", "fin"):
            lineas.append(f'  {n["id"]}(["{etiqueta}"])')
        else:
            lineas.append(f'  {n["id"]}["{etiqueta}"]')
    for f in flujo.get("flechas") or []:
        if not f.get("de") or not f.get("a"):
            continue
        cond = str(f.get("condicion") or "").replace('"', "'")
        lineas.append(f'  {f["de"]} -->' + (f'|{cond}|' if cond else "") + f' {f["a"]}')
    return "\n".join(lineas)
