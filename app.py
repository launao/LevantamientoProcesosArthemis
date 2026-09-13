"""
app.py — Punto de entrada de la aplicación.

Local:      python app.py
Railway:    gunicorn app:app   (ver Procfile)
"""
import os
from datetime import timedelta

from flask import Flask, render_template, redirect, url_for, jsonify

try:  # .env solo en desarrollo
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import db as D
from schema import init_db
from api import api, servir_media, capture_media, datos_informe, informe_media
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
        MAX_CONTENT_LENGTH=int(os.environ.get("MAX_MEDIA_MB", "25")) * 1024 * 1024 + 1024 * 512,
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
