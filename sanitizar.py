"""
sanitizar.py — Limpieza del texto con formato que escriben los usuarios.

Las respuestas largas admiten negrilla, cursiva, subrayado, listas y color.
Eso significa que el navegador manda HTML, y el HTML que llega del navegador
nunca se guarda tal cual: se reconstruye desde cero dejando pasar solo las
etiquetas y los estilos de esta lista. Todo lo demás —scripts, enlaces,
atributos, estilos raros— se descarta.

Es la única forma segura de guardar texto con formato: quien escribe es
gente de confianza, pero el texto viaja al informe público, y ahí lo abre
cualquiera con el enlace.
"""
import re
from html import escape
from html.parser import HTMLParser

ETIQUETAS = {"b", "strong", "i", "em", "u", "s", "br", "p", "div",
             "ul", "ol", "li", "span", "mark"}
VACIAS = {"br"}

# De estas no se conserva ni el contenido: lo que llevan dentro es código,
# no texto que alguien quisiera leer en el informe.
MUDAS = {"script", "style", "iframe", "object", "embed", "noscript", "template"}

# Solo color de letra y de resaltado, y solo en formatos reconocibles.
COLOR = re.compile(r"^(#[0-9a-fA-F]{3,8}|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)"
                   r"|rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)"
                   r"|[a-zA-Z]{3,20})$")
ESTILOS = ("color", "background-color")

LIMITE = 60_000


def _estilo_limpio(valor: str) -> str:
    salida = []
    for parte in (valor or "").split(";"):
        if ":" not in parte:
            continue
        prop, _, val = parte.partition(":")
        prop, val = prop.strip().lower(), val.strip()
        if prop in ESTILOS and COLOR.match(val):
            salida.append(f"{prop}:{val}")
    return ";".join(salida)


class _Limpiador(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.partes = []
        self.abiertas = []
        self.mudo = 0

    def handle_starttag(self, tag, attrs):
        if tag in MUDAS:
            self.mudo += 1
            return
        if tag not in ETIQUETAS:
            return
        estilo = ""
        for nombre, valor in attrs:
            if nombre.lower() == "style":
                estilo = _estilo_limpio(valor or "")
        if tag in VACIAS:
            self.partes.append("<br>")
            return
        self.partes.append(f'<{tag} style="{estilo}">' if estilo else f"<{tag}>")
        self.abiertas.append(tag)

    def handle_endtag(self, tag):
        if tag in MUDAS:
            self.mudo = max(0, self.mudo - 1)
            return
        if tag not in ETIQUETAS or tag in VACIAS:
            return
        if tag in self.abiertas:
            # Cierra todo lo que quedó abierto por dentro, para no devolver
            # etiquetas descuadradas que rompan el informe.
            while self.abiertas:
                abierta = self.abiertas.pop()
                self.partes.append(f"</{abierta}>")
                if abierta == tag:
                    break

    def handle_data(self, data):
        if self.mudo:
            return
        self.partes.append(escape(data))

    def resultado(self) -> str:
        while self.abiertas:
            self.partes.append(f"</{self.abiertas.pop()}>")
        return "".join(self.partes)


def limpiar_html(texto) -> str:
    """Devuelve HTML seguro, conservando el formato permitido."""
    if not isinstance(texto, str):
        return texto
    if len(texto) > LIMITE:
        texto = texto[:LIMITE]
    p = _Limpiador()
    try:
        p.feed(texto)
        p.close()
    except Exception:
        return escape(texto)
    return p.resultado()


ETIQUETA_RE = re.compile(r"<[^>]+>")


def a_texto_plano(html: str) -> str:
    """Versión sin etiquetas, para el CSV y para medir si hay contenido."""
    if not isinstance(html, str):
        return html
    plano = html.replace("<br>", "\n").replace("</p>", "\n").replace("</div>", "\n")
    plano = plano.replace("</li>", "\n").replace("<li>", "• ")
    plano = ETIQUETA_RE.sub("", plano)
    from html import unescape
    return unescape(plano).strip()


def limpiar_respuestas(respuestas):
    """Recorre las respuestas de un proceso y sanea cada texto."""
    if not isinstance(respuestas, dict):
        return {}
    salida = {}
    for clave, valor in respuestas.items():
        salida[clave] = _limpiar_valor(valor)
    return salida


def _limpiar_valor(v):
    if isinstance(v, str):
        return limpiar_html(v) if "<" in v else v
    if isinstance(v, list):
        return [_limpiar_valor(x) for x in v]
    if isinstance(v, dict):
        return {k: _limpiar_valor(x) for k, x in v.items()}
    return v
