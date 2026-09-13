#!/usr/bin/env bash
# Sube este proyecto al repositorio de GitHub.
# Uso:  bash subir-a-github.sh
set -e

REPO="https://github.com/launao/LevantamientoProcesosArthemis.git"

echo "→ Preparando repositorio local…"
git init -q 2>/dev/null || true
git add .
git -c user.email="${GIT_EMAIL:-$(git config user.email || echo tu@correo.com)}" \
    -c user.name="${GIT_NAME:-$(git config user.name || echo launao)}" \
    commit -qm "Levantamiento de procesos: app completa" || echo "  (sin cambios que confirmar)"

git branch -M main
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO"

echo "→ Empujando a GitHub…"
echo "  Si pide contraseña, usa un Personal Access Token, no tu clave."
echo "  Se crea en: GitHub → Settings → Developer settings → Tokens (classic) → scope 'repo'"
git push -u origin main

echo
echo "✓ Listo. Ahora en Railway:"
echo "  New Project → Deploy from GitHub repo → LevantamientoProcesosArthemis"
echo "  New → Database → Add PostgreSQL"
echo "  Variables: SECRET_KEY y ADMIN_PASSWORD"
echo "  Settings → Networking → Generate Domain"
