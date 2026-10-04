#!/bin/bash
#
# Levantamiento de Procesos — Preparar entrevistas grabadas
#
# Saca la voz de los videos y la manda a la app. El video se queda en el
# computador: pesa cien veces más y lo que hace falta es lo que la
# persona dijo.
#
# Se usa con doble clic. La primera vez pide el correo y la contraseña de
# la app; después ya no vuelve a preguntar.
#

set -u
cd "$(dirname "$0")" 2>/dev/null || true

APP="${LP_URL:-https://web-production-06eb4.up.railway.app}"
BASE="$HOME/.levantamiento"
mkdir -p "$BASE"
SESION="$BASE/sesion.txt"
CONF="$BASE/config.txt"
FFMPEG="$(command -v ffmpeg || echo "$BASE/ffmpeg")"

azul()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
gris()  { printf '\033[0;90m%s\033[0m\n' "$*"; }
verde() { printf '\033[1;32m%s\033[0m\n' "$*"; }
rojo()  { printf '\033[1;31m%s\033[0m\n' "$*"; }

clear
azul "═══════════════════════════════════════════════════"
azul "  Preparar entrevistas grabadas"
azul "═══════════════════════════════════════════════════"
echo

# ── ffmpeg, la herramienta que saca el audio ──────────────────────────
if [ ! -x "$FFMPEG" ]; then
  gris "Falta una herramienta para leer los videos. Se baja una sola vez (unos 45 MB)."
  echo
  ARQ="$(uname -m)"
  case "$(uname -s)" in
    Darwin) URL="https://www.osxexperts.net/ffmpeg7arm.zip"
            [ "$ARQ" = "x86_64" ] && URL="https://www.osxexperts.net/ffmpeg7intel.zip" ;;
    Linux)  URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" ;;
    *)      rojo "Este programa funciona en Mac. En Windows, avísale a Laura."; read -r; exit 1 ;;
  esac

  TMP="$(mktemp -d)"
  if curl -fL# "$URL" -o "$TMP/ff.pkg" 2>&1; then
    ( cd "$TMP"
      case "$URL" in
        *.zip)    unzip -qo ff.pkg ;;
        *.tar.xz) tar xf ff.pkg --strip-components=1 ;;
      esac
      BIN="$(find . -name 'ffmpeg' -type f -perm -u+x 2>/dev/null | head -1)"
      [ -z "$BIN" ] && BIN="$(find . -name 'ffmpeg' -type f 2>/dev/null | head -1)"
      [ -n "$BIN" ] && cp "$BIN" "$BASE/ffmpeg" && chmod +x "$BASE/ffmpeg" )
    rm -rf "$TMP"
  fi

  FFMPEG="$BASE/ffmpeg"
  if [ ! -x "$FFMPEG" ]; then
    rojo "No se pudo bajar la herramienta."
    gris "Puede ser que no haya internet, o que la red del trabajo lo bloquee."
    gris "Avísale a Laura y pásale esta pantalla."
    echo; gris "Presiona Enter para cerrar."; read -r; exit 1
  fi
  verde "Listo. Esto no vuelve a pasar."
  echo
fi

# ── Entrar a la app ───────────────────────────────────────────────────
entrar() {
  echo
  azul "Entra con el mismo usuario de la app:"
  printf '  Usuario: '; read -r USUARIO
  printf '  Contraseña: '; stty -echo 2>/dev/null; read -r CLAVE; stty echo 2>/dev/null; echo
  echo

  CODIGO=$(curl -s -o "$BASE/r.json" -w '%{http_code}' -c "$SESION" \
    -H 'Content-Type: application/json' \
    -d "{\"usuario\":\"$USUARIO\",\"password\":\"$CLAVE\"}" \
    "$APP/api/login")

  if [ "$CODIGO" != "200" ]; then
    rojo "No se pudo entrar (usuario o contraseña)."
    return 1
  fi
  echo "$USUARIO" > "$CONF"
  verde "Entraste como $USUARIO."
  return 0
}

if [ ! -f "$SESION" ] || ! curl -s -b "$SESION" "$APP/api/procesos" | grep -q '"procesos"'; then
  until entrar; do :; done
else
  gris "Sesión guardada: $(cat "$CONF" 2>/dev/null || echo '—')"
fi

# ── Elegir los videos ─────────────────────────────────────────────────
echo
azul "Ahora los videos."
gris "Arrástralos a esta ventana (puedes soltar varios) y presiona Enter."
gris "También sirve escribir la carpeta donde están."
echo
printf '  > '
read -r ENTRADA

# Las rutas arrastradas vienen separadas por espacios y escapadas
eval "ARCHIVOS=($ENTRADA)" 2>/dev/null || ARCHIVOS=("$ENTRADA")

VIDEOS=()
for a in "${ARCHIVOS[@]}"; do
  a="${a%\'}"; a="${a#\'}"
  if [ -d "$a" ]; then
    while IFS= read -r f; do VIDEOS+=("$f"); done < <(
      find "$a" -maxdepth 1 -type f \( -iname '*.mp4' -o -iname '*.mov' \
        -o -iname '*.m4v' -o -iname '*.avi' -o -iname '*.mkv' \) | sort)
  elif [ -f "$a" ]; then
    VIDEOS+=("$a")
  fi
done

if [ ${#VIDEOS[@]} -eq 0 ]; then
  rojo "No se encontró ningún video ahí."
  echo; gris "Presiona Enter para cerrar."; read -r; exit 1
fi

echo
azul "Se van a preparar ${#VIDEOS[@]} video(s):"
for v in "${VIDEOS[@]}"; do
  MB=$(( $(stat -f%z "$v" 2>/dev/null || stat -c%s "$v" 2>/dev/null || echo 0) / 1048576 ))
  gris "  · $(basename "$v")  (${MB} MB)"
done
echo
printf 'Seguimos? [Enter para sí, n para no] '
read -r R
[ "$R" = "n" ] && exit 0

# ── Trabajar ──────────────────────────────────────────────────────────
echo
OK=0; FALLO=0
for v in "${VIDEOS[@]}"; do
  NOMBRE="$(basename "$v")"
  azul "── $NOMBRE"

  SEG=$("$FFMPEG" -i "$v" 2>&1 | awk -F'[:,]' '/Duration/{print int($2*3600+$3*60+$4)}' | head -1)
  SEG="${SEG:-0}"
  [ "$SEG" -gt 0 ] && gris "   $(( SEG / 60 )) minutos de grabación"

  AUDIO="$BASE/audio_$$.m4a"
  gris "   sacando la voz…"
  if ! "$FFMPEG" -v error -y -i "$v" -vn -ac 1 -ar 16000 -c:a aac -b:a 32k "$AUDIO" 2>"$BASE/err.txt"; then
    rojo "   no se pudo leer este video"
    gris "   $(tail -1 "$BASE/err.txt" 2>/dev/null)"
    FALLO=$((FALLO+1)); rm -f "$AUDIO"; continue
  fi

  AMB=$(( $(stat -f%z "$AUDIO" 2>/dev/null || stat -c%s "$AUDIO" 2>/dev/null || echo 0) / 1048576 ))
  VMB=$(( $(stat -f%z "$v" 2>/dev/null || stat -c%s "$v" 2>/dev/null || echo 0) / 1048576 ))
  gris "   la voz pesa ${AMB} MB (el video pesaba ${VMB} MB)"

  gris "   enviando…"
  RESP=$(curl -s -b "$SESION" \
    -F "audio=@$AUDIO" \
    -F "nombre=$NOMBRE" \
    -F "duracion=$SEG" \
    -F "origenBytes=$(stat -f%z "$v" 2>/dev/null || stat -c%s "$v" 2>/dev/null || echo 0)" \
    "$APP/api/grabaciones")
  rm -f "$AUDIO"

  if echo "$RESP" | grep -q '"ok"'; then
    verde "   ✓ enviada. La app la está analizando."
    OK=$((OK+1))
  else
    rojo "   ✗ no se pudo enviar"
    case "$RESP" in
      *sin_llave_voz*)    gris "   Falta configurar el servicio de voz. Avísale a Laura." ;;
      *audio_muy_grande*) gris "   La grabación es muy larga. Pártela en dos." ;;
      *)                  gris "   $(echo "$RESP" | head -c 160)" ;;
    esac
    FALLO=$((FALLO+1))
  fi
  echo
done

echo
azul "═══════════════════════════════════════════════════"
[ $OK -gt 0 ]    && verde "  $OK entrevista(s) enviadas"
[ $FALLO -gt 0 ] && rojo  "  $FALLO con problemas"
azul "═══════════════════════════════════════════════════"
echo
gris "Los videos siguen donde estaban: no se movió ni se borró nada."
gris "En la app, entra a «Entrevistas» para ver el paso a paso."
gris "El análisis tarda unos minutos; puedes cerrar esto."
echo
gris "Presiona Enter para cerrar."
read -r
