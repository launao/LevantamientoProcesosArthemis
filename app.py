"""
app.py — Punto de entrada de la aplicación.

Local:      python app.py
Railway:    gunicorn app:app   (ver Procfile)
"""
import io
import os
import re
import zipfile
from datetime import datetime, timedelta

from flask import (Flask, render_template, redirect, url_for, jsonify,
                   request, Response)

try:  # .env solo en desarrollo
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import db as D
from schema import init_db
from api import (api, servir_media, capture_media, datos_informe, informe_media,
                 documento_html)
from auth import usuario_actual


def crear_app():
    app = Flask(__name__, static_folder="static", template_folder="templates")

    secret = os.environ.get("SECRET_KEY")
    if not secret:
        if os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("PORT"):
            raise RuntimeError(
                "Falta SECRET_KEY. Defínela en las variables de Railway.")
        secret = "dev-solo-para-local-no-usar-en-produccion"
    app.secret_key = secret

    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=bool(os.environ.get("RAILWAY_ENVIRONMENT")),
        PERMANENT_SESSION_LIFETIME=timedelta(days=int(os.environ.get("SESSION_DIAS", "14"))),
        # El tope de una petición. Manda el más grande de los dos usos: un
        # archivo suelto (25 MB) y una carpeta comprimida con los
        # consentimientos de la clínica, que son decenas de PDF.
        MAX_CONTENT_LENGTH=max(int(os.environ.get("MAX_MEDIA_MB", "25")),
                               int(os.environ.get("MAX_ZIP_MB", "80"))) * 1024 * 1024
                           + 1024 * 512,
        JSON_SORT_KEYS=False,
    )

    app.register_blueprint(api, url_prefix="/api")

    # ── Vistas ──────────────────────────────────────────────────────────
    @app.get("/")
    def index():
        if not usuario_actual():
            return redirect(url_for("login_view"))
        return render_template("index.html")

    @app.get("/login")
    def login_view():
        if usuario_actual():
            return redirect(url_for("index"))
        return render_template("login.html")

    @app.get("/media/<mid>")
    def media(mid):
        return servir_media(mid)

    @app.get("/c/<token>")
    def captura(token):
        """Página que se abre en el celular desde el QR. No requiere sesión:
        el token del enlace es la credencial y caduca solo."""
        return render_template("captura.html", token=token)

    @app.get("/e/<token>")
    def subir_entrevista(token):
        """La página que se abre en el celular para subir la entrevista.

        Sin sesión a propósito: el enlace es la credencial. Escribir una
        contraseña en un teclado de celular, para subir un archivo y
        cerrar, era la parte que hacía que nadie lo usara.
        """
        return render_template("entrevista.html", token=token)

    @app.get("/c/<token>/media/<mid>")
    def captura_media(token, mid):
        return capture_media(token, mid)

    @app.get("/r/<token>")
    def informe(token):
        """Informe legible del proceso: el enlace que se manda por WhatsApp o
        correo. Fotos en grande, audios reproducibles, textos completos."""
        datos = datos_informe(token)
        if not datos:
            return render_template("informe.html", datos=None), 410
        return render_template("informe.html", datos=datos)

    @app.get("/r/<token>/media/<mid>")
    def informe_media_view(token, mid):
        return informe_media(token, mid)

    @app.get("/sw.js")
    def service_worker():
        """Se sirve desde la raíz para que su alcance cubra todo el sitio."""
        resp = app.send_static_file("sw.js")
        resp.headers["Content-Type"] = "text/javascript"
        resp.headers["Service-Worker-Allowed"] = "/"
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @app.get("/r/<token>/descargar")
    def descargar_informe(token):
        """El informe como un archivo que se guarda y sigue funcionando.

        Las fotos van dentro del archivo, y los audios también mientras
        quepan. Así el informe se puede mandar por correo o guardar en una
        carpeta sin depender de que el servidor siga en pie.
        """
        datos = datos_informe(token, embebido=True)
        if not datos:
            return render_template("informe.html", datos=None), 410

        html = render_template("informe.html", datos=datos)
        nombre = "".join(ch if ch.isalnum() or ch in " -_" else ""
                         for ch in (datos["proceso"]["nombre"] or "informe"))[:60].strip()
        return Response(html, mimetype="text/html; charset=utf-8", headers={
            "Content-Disposition": f'attachment; filename="{nombre or "informe"}.html"'})

    @app.get("/descargar/levantamiento.zip")
    def descargar_todo():
        """Todos los procesos levantados, en un solo archivo.

        Va como zip con un informe por proceso más un índice que los
        enlaza, porque es lo que de verdad se necesita: poder abrirlo en
        cualquier computador, mandarlo por correo o archivarlo, sin
        depender de que la app siga en pie.

        Las fotos van dentro de cada informe. Pesa más, pero un informe
        que apunta a fotos que viven en el servidor deja de servir el día
        que el servidor no esté, que es justo cuando hace falta.
        """
        from api import datos_de_proceso, usuario_actual
        from auth import login_required as _lr          # noqa: F401
        import db as D

        u = usuario_actual()
        if not u:
            return redirect("/login")

        # Quién ve qué: una analista se lleva lo suyo; el admin, el lector
        # y la clínica se llevan todo. Es la misma regla de la pantalla.
        solo_mios = u["rol"] not in ("admin", "lector", "clinica")
        estado = (request.args.get("estado") or "").strip()
        area = (request.args.get("area") or "").strip()

        sql = "SELECT id, codigo, nombre, area, estado FROM procesos WHERE COALESCE(eliminado,0)=0"
        args = []
        if solo_mios:
            sql += " AND responsable_id=?"
            args.append(u["id"])
        if estado:
            sql += " AND estado=?"
            args.append(estado)
        if area:
            sql += " AND area=?"
            args.append(area)
        # Los que no tienen código van al final: un código vacío ordena
        # primero y dejaba «Sin código» abriendo el paquete, que es justo
        # lo contrario de lo que uno espera encontrar de primero.
        filas = D.rows(sql + " ORDER BY CASE WHEN COALESCE(codigo,'')='' THEN 1 ELSE 0 END,"
                             " codigo, nombre", tuple(args))

        if not filas:
            return render_template("informe.html", datos=None), 404

        buf = io.BytesIO()
        indice = []
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for i, f in enumerate(filas, 1):
                datos = datos_de_proceso(f["id"], embebido=True)
                if not datos:
                    continue
                html = render_template("informe.html", datos=datos)
                nombre = _nombre_archivo(f["codigo"], f["nombre"], i)
                z.writestr(nombre, html)
                indice.append({"archivo": nombre, "codigo": f["codigo"] or "",
                               "nombre": f["nombre"], "area": f["area"] or "",
                               "estado": f["estado"] or ""})
            z.writestr("00-indice.html", _html_indice(indice))

        buf.seek(0)
        sello = datetime.now().strftime("%Y-%m-%d")
        return Response(buf.getvalue(), mimetype="application/zip", headers={
            "Content-Disposition":
                f'attachment; filename="levantamiento-{sello}.zip"'})

    @app.get("/descargar/preparar-entrevistas.zip")
    def bajar_preparador():
        """El programa que saca la voz de los videos, listo para doble clic.

        Va dentro de un zip por una razón concreta: un archivo bajado del
        navegador llega sin permiso de ejecución, y en Mac un .command sin
        ese permiso no abre —solo dice que no se puede—. El zip sí lo
        conserva, así que al descomprimirlo ya funciona.

        De paso se le inyecta la dirección de este servidor, para que
        nadie tenga que configurar nada ni se quede apuntando a otro lado
        si algún día cambia el dominio.
        """
        import io
        import zipfile

        ruta = os.path.join(app.static_folder, "preparar-entrevistas.command")
        if not os.path.exists(ruta):
            return jsonify({"error": "no_existe"}), 404

        with open(ruta, "r", encoding="utf-8") as fh:
            guion = fh.read()
        base = request.host_url.rstrip("/")
        guion = guion.replace(
            'APP="${LP_URL:-https://web-production-06eb4.up.railway.app}"',
            f'APP="${{LP_URL:-{base}}}"')

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            info = zipfile.ZipInfo("Preparar entrevistas.command")
            info.external_attr = 0o755 << 16        # el permiso de ejecución
            info.date_time = datetime.now().timetuple()[:6]
            z.writestr(info, guion)

            lea = (
                "PREPARAR ENTREVISTAS GRABADAS\n"
                "=============================\n\n"
                "1. Haz doble clic en «Preparar entrevistas.command».\n\n"
                "   La primera vez, el Mac va a decir que no puede abrirlo porque\n"
                "   viene de internet. Entonces: clic derecho sobre el archivo →\n"
                "   Abrir → Abrir. Eso pasa una sola vez.\n\n"
                "2. Te va a pedir el usuario y la contraseña de la app.\n"
                "   Los mismos de siempre.\n\n"
                "3. Arrastra los videos a la ventana y presiona Enter.\n\n"
                "El programa saca la voz de cada video y la manda a la app.\n"
                "Tus videos no se mueven ni se borran: siguen donde estaban.\n\n"
                f"La app está en: {base}\n")
            z.writestr("LÉEME.txt", lea)

        buf.seek(0)
        return Response(buf.read(), mimetype="application/zip", headers={
            "Content-Disposition": 'attachment; filename="Preparar entrevistas.zip"'})

    @app.get("/doc/<did>/descargar")
    def descargar_documento(did):
        from auth import usuario_actual as quien
        u = quien()
        if not u:
            return redirect(url_for("login_view"))

        para_cliente = u["rol"] != "admin"
        res = documento_html(did, para_cliente=para_cliente)
        if not res:
            return render_template("documento.html", doc=None, cuerpo="",
                                   organizacion="", para_cliente=False), 404
        doc, cuerpo = res
        if u["rol"] == "clinica" and doc["estado"] not in ("con_cliente", "aprobado"):
            return render_template("documento.html", doc=None, cuerpo="",
                                   organizacion="", para_cliente=True), 403

        import db as D
        cfg = D.jload(D.row("SELECT data FROM config WHERE id=1")["data"], {})
        html = render_template("documento.html", doc=doc, cuerpo=cuerpo,
                               organizacion=cfg.get("organizacion", ""),
                               para_cliente=para_cliente)
        nombre = "".join(ch if ch.isalnum() or ch in " -_" else ""
                         for ch in (doc["titulo"] or "analisis"))[:60].strip()
        return Response(html, mimetype="text/html; charset=utf-8", headers={
            "Content-Disposition": f'attachment; filename="{nombre or "analisis"}.html"'})

    @app.get("/doc/<did>")
    def documento(did):
        """El documento para leer, guardar o imprimir. Quien no sea de la
        coordinación ve la versión sin la parte técnica."""
        from auth import usuario_actual as quien
        u = quien()
        if not u:
            return redirect(url_for("login_view"))

        para_cliente = u["rol"] != "admin"
        res = documento_html(did, para_cliente=para_cliente)
        if not res:
            return render_template("documento.html", doc=None, cuerpo="",
                                   organizacion="", para_cliente=False), 404
        doc, cuerpo = res
        if u["rol"] == "clinica" and doc["estado"] not in ("con_cliente", "aprobado"):
            return render_template("documento.html", doc=None, cuerpo="",
                                   organizacion="", para_cliente=True), 403

        import db as D
        cfg = D.jload(D.row("SELECT data FROM config WHERE id=1")["data"], {})
        return render_template("documento.html", doc=doc, cuerpo=cuerpo,
                               organizacion=cfg.get("organizacion", ""),
                               para_cliente=para_cliente)

    @app.get("/healthz")
    def healthz():
        try:
            D.row("SELECT 1 AS ok")
            return jsonify({"ok": True, "db": "pg" if D.USE_PG else "sqlite"})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)[:160]}), 503

    # ── Errores ─────────────────────────────────────────────────────────
    @app.errorhandler(413)
    def muy_grande(_):
        return jsonify({"error": "archivo_muy_grande"}), 413

    @app.errorhandler(404)
    def no_encontrado(_):
        return jsonify({"error": "no_encontrado"}), 404

    @app.errorhandler(500)
    def error_interno(e):
        app.logger.exception(e)
        return jsonify({"error": "error_interno"}), 500

    # ── Cabeceras de seguridad ──────────────────────────────────────────
    @app.after_request
    def cabeceras(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        return resp

    with app.app_context():
        init_db()
        print(f"[app] Base de datos lista ({'PostgreSQL' if D.USE_PG else 'SQLite'})")

    return app


app = crear_app()

if __name__ == "__main__":
    puerto = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=puerto, debug=os.environ.get("DEBUG") == "1")


def _nombre_archivo(codigo, nombre, i):
    """Un nombre de archivo que ordena solo y se puede abrir en cualquier
    sistema: sin tildes raras, sin barras, sin dos puntos."""
    base = f"{(codigo or '').strip()} {nombre or ''}".strip() or f"proceso-{i}"
    limpio = re.sub(r"[^\w \-]", "", base, flags=re.UNICODE).strip()[:70]
    return f"{i:02d}-{limpio or 'proceso'}.html"


def _html_indice(filas):
    """La portada del paquete: la lista de lo que hay, con sus enlaces.

    Sin esto, quien reciba el zip se encuentra sesenta archivos sueltos y
    tiene que abrirlos uno por uno para saber qué hay dentro.
    """
    hoy = datetime.now().strftime("%d/%m/%Y")
    por_area = {}
    for f in filas:
        por_area.setdefault(f["area"] or "Sin área", []).append(f)

    bloques = []
    for area in sorted(por_area):
        items = "".join(
            f'<li><a href="{f["archivo"]}">'
            f'<b>{f["codigo"]}</b> {f["nombre"]}</a>'
            f'<span class="e">{f["estado"].replace("_", " ")}</span></li>'
            for f in por_area[area])
        bloques.append(f"<h2>{area}</h2><ul>{items}</ul>")

    return f"""<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<title>Levantamiento de procesos</title>
<style>
 body{{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:860px;
   margin:40px auto;padding:0 20px;color:#112236;line-height:1.5}}
 h1{{margin:0 0 4px}} .sub{{color:#5b6b7c;margin-bottom:28px}}
 h2{{font-size:17px;margin:28px 0 8px;padding-bottom:6px;border-bottom:1.5px solid #e3e8ee}}
 ul{{list-style:none;padding:0;margin:0}}
 li{{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f0f3f6}}
 li a{{flex:1;color:#112236;text-decoration:none}}
 li a:hover{{text-decoration:underline}}
 .e{{font-size:12.5px;color:#5b6b7c;background:#f3f6f9;padding:2px 9px;border-radius:99px}}
</style></head><body>
<h1>Levantamiento de procesos</h1>
<div class="sub">Clínica Centro Ocular Dr. Rincón · {len(filas)} procesos · {hoy}</div>
{"".join(bloques)}
<p class="sub" style="margin-top:34px">Cada archivo lleva sus fotos dentro:
funcionan sin internet y se pueden guardar o reenviar tal cual.</p>
</body></html>"""
