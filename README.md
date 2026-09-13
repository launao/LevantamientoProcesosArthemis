# Levantamiento de Procesos

Aplicación web para levantar procesos en campo: estructura configurable, captura por
escrito, notas de voz y fotos pegadas a cada pregunta, gestión del equipo que hace el
levantamiento y seguimiento del avance.

Todo queda guardado en PostgreSQL. Nada vive solo en el navegador.

- **Backend**: Flask 3 + SQL crudo (sin ORM)
- **Base de datos**: PostgreSQL en producción, SQLite en desarrollo local
- **Frontend**: HTML + CSS + JS sin framework, responsive, con modo claro/oscuro
- **Autenticación**: usuario y contraseña con bcrypt, sesión en cookie firmada, tres roles

---

## 1. Desplegar en Railway

### 1.1 Subir el código

```bash
cd levantamiento-procesos
git init
git add .
git commit -m "Levantamiento de procesos"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/levantamiento-procesos.git
git push -u origin main
```

En Railway: **New Project → Deploy from GitHub repo** y elige el repositorio.
(También sirve `railway up` desde la CLI si prefieres no usar GitHub.)

### 1.2 Agregar la base de datos

Dentro del proyecto en Railway: **New → Database → Add PostgreSQL**.

Railway crea la variable `DATABASE_URL` y la inyecta en el servicio web automáticamente.
Si no aparece, ve a tu servicio web → *Variables* → *Add Reference* → `DATABASE_URL`
del servicio Postgres.

No hay que correr migraciones: las tablas se crean solas en el primer arranque.

### 1.3 Definir las variables

En el servicio web → *Variables*:

| Variable | Valor | Obligatoria |
|---|---|---|
| `SECRET_KEY` | cadena aleatoria larga | **Sí** |
| `ADMIN_USER` | `admin` | recomendada |
| `ADMIN_PASSWORD` | tu contraseña inicial | **Sí** |
| `ADMIN_NOMBRE` | tu nombre | no |
| `APP_NOMBRE` | nombre del proyecto | no |
| `APP_ORG` | nombre de la organización | no |
| `MAX_MEDIA_MB` | `25` por defecto | no |
| `MEDIA_DIR` | ver sección 3 | no |
| `CAPTURE_HORAS` | vigencia del QR, `12` por defecto | no |

Genera la clave así:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### 1.4 Publicar

En *Settings → Networking* pulsa **Generate Domain**. Railway detecta el `Procfile`,
instala `requirements.txt` y arranca gunicorn. El chequeo de salud apunta a `/healthz`.

Entra a la URL, inicia sesión con `ADMIN_USER` / `ADMIN_PASSWORD` y **cambia la
contraseña de inmediato** desde *Ajustes → Mi cuenta*. El usuario administrador solo
se crea si la tabla de usuarios está vacía, así que cambiar la variable después no
cambia la contraseña.

---

## 2. Correr en local

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env          # completa SECRET_KEY y ADMIN_PASSWORD
python app.py
```

Abre http://localhost:8080. Sin `DATABASE_URL` usa SQLite en `data/levantamiento.db`,
así que puedes probar sin instalar Postgres.

---

## 3. Dónde se guardan las fotos y los audios

Por defecto van dentro de PostgreSQL como binarios. Es lo más simple y sobrevive a
cada redespliegue, porque el disco de un contenedor de Railway se borra al reiniciar.

Si esperas mucho volumen y prefieres sacarlos de la base:

1. Railway → tu servicio → *Volumes* → crea uno montado en `/data/media`.
2. Agrega la variable `MEDIA_DIR=/data/media`.

A partir de ahí los archivos nuevos se escriben en el volumen. Los que ya estaban en
la base se siguen sirviendo sin problema: cada registro sabe dónde vive.

Antes de subir, el navegador comprime las fotos a 1600 px y JPEG al 82 %, así que una
foto de celular termina pesando unos cientos de kilobytes.

---

## 4. Roles

| Rol | Puede |
|---|---|
| `admin` | todo: plantilla, equipo, configuración, procesos |
| `analista` | crear y editar procesos, subir fotos y audios |
| `lector` | consultar y exportar |

El administrador crea las cuentas desde *Equipo*. Cada persona entra con su usuario
desde el computador o desde el celular, con la misma URL.

---

## 5. Captura desde el celular

Dentro de un proceso hay un botón **📱 Capturar desde el celular**, y otro más pequeño
📱 junto a cada pregunta. Al pulsarlo la app genera un **código QR** y un enlace corto.

1. Apuntas la cámara del celular al QR (cualquier celular, no hace falta que sea el
   tuyo ni instalar nada).
2. Se abre una página pensada para una mano: botones grandes de **📷 Foto**,
   **🖼 Galería** y **🎙 Voz**.
3. Todo lo que capture entra directo en ese proceso —y en esa pregunta, si generaste
   el QR desde el botón del campo—. No hay que iniciar sesión ni mandar nada por correo.

El enlace es la credencial, así que está acotado a propósito:

- vence a las **12 horas** (ajustable con `CAPTURE_HORAS`),
- sirve **solo para ese proceso**, no da acceso al resto del sistema,
- al generar uno nuevo el anterior queda revocado,
- la subida queda marcada con origen `celular` y queda registrada en auditoría.

Esto sirve para el caso típico de campo: el analista tiene el computador abierto en la
entrevista y usa el celular para fotografiar el formato en papel, la cartelera del
puesto o la pantalla del sistema viejo.

---

## 6. Que no se pierda nada

Este fue el punto de diseño más cuidado, porque en campo la señal falla.

**Todo se escribe primero en el celular o el computador, y solo después se envía.**
Cada foto y cada audio pasa por una cola en IndexedDB antes de salir a la red. Si no
hay conexión, si el servidor no responde o si cierras el navegador a media subida, el
archivo sigue ahí y se reintenta solo: al recuperar señal, cada 15 segundos y al volver
a abrir la app. Un contador visible te dice cuántos archivos están esperando.

**Las grabaciones se guardan cada 5 segundos mientras grabas.** No al final. Si el
celular se bloquea, se queda sin batería o el navegador se cierra en mitad de una
entrevista de 20 minutos, al volver a abrir el enlace lo grabado hasta ese momento se
recupera y se sube. El tope es de 30 minutos por nota desde el celular.

**Reintentar nunca duplica.** El servidor calcula el SHA-1 de cada archivo: si ese
mismo contenido ya entró en ese proceso y esa pregunta, devuelve la evidencia que ya
existía en vez de crear otra. Por eso la cola puede reintentar sin miedo.

**Las respuestas escritas** se guardan solas mientras escribes, con un indicador de
estado junto al título. Si el guardado falla, el indicador lo dice en vez de fingir que
todo está bien.

**De los audios se guarda** el archivo, la duración en segundos, quién lo grabó, desde
dónde (app o celular), a qué proceso y a qué pregunta pertenece, y la fecha.

Lo único que se pierde es lo que nunca llegó a capturarse. Si un archivo falla seis
veces seguidas queda marcado en la cola para revisión manual en vez de reintentar en
un bucle infinito.

---

## 7. Borrador, envío e informe compartible

Un proceso arranca en **Borrador**. Mientras esté así, quien lo tiene asignado escribe,
sube fotos y graba audios a su ritmo, tantos días como haga falta. Nada de eso avisa a
nadie todavía.

Cuando está listo pulsa **✈ Enviar**. Eso hace tres cosas:

1. Verifica que no falten campos obligatorios. Si faltan, los lista y te deja decidir
   entre completar o enviar así.
2. Espera a que termine de subir lo que quede en la cola, para que el informe no salga
   con fotos a medias.
3. Registra el envío en el proceso (número, quién, cuándo, avance, cuántas fotos y
   audios) y pasa el estado a **Enviado**.

**Se puede seguir editando después de enviar.** Al pulsar **↻ Reenviar** se registra un
envío nuevo y el informe se actualiza **con el mismo enlace**: quien ya lo tenía ve la
versión nueva sin que le mandes nada. El historial guarda todos los envíos.

### Por qué un enlace y no un PDF

Un PDF no reproduce audio, y un JSON no lo lee nadie. Por eso "Enviar" no genera un
archivo: genera una **página de informe** en `/r/<token>`, pensada para abrirse en el
celular de quien la reciba.

En esa página se ve el proceso completo: cada pregunta con su respuesta, la tabla de
actividades, **las fotos en grande** y **los audios con su reproductor**, cada uno con
quién lo capturó, cuándo y desde dónde. No pide contraseña.

El modal de envío te da todo listo:

- **📲 WhatsApp** — abre WhatsApp con el mensaje y el enlace ya escritos
- **✉ Correo** — abre tu cliente de correo con asunto y cuerpo
- **Copiar mensaje** — para pegarlo donde sea
- **Ver informe** — para revisarlo antes de mandarlo

Si imprimes el informe desde el navegador sale limpio, pero los audios quedan como una
nota que avisa que hay que abrir la versión web. Es una limitación del papel, no del
sistema.

Puedes anular el enlace en cualquier momento; al reenviar se genera uno nuevo.

---

## 8. Asignación

La pestaña **Asignación** muestra a cada persona por separado, en su propia tarjeta:
cuántos procesos tiene, cuántos ya envió, su avance promedio y la lista completa de lo
suyo con estado y barra de progreso.

Arriba aparecen los procesos **sin responsable**, y desde cada tarjeta los asignas con
un desplegable. La × junto a un proceso retira la asignación y lo devuelve a la bolsa
de pendientes.

Los usuarios con rol `lector` no aparecen, porque no levantan procesos.

---

## 9. Cómo se usa

**Plantilla.** Define las secciones y los campos con que se levanta cada proceso.
Tipos disponibles: texto corto, párrafo, lista de una opción, lista de varias, número,
fecha, sí/no, persona del equipo y tabla de actividades (actividad, responsable,
sistema, tiempo). Marca los campos obligatorios: sobre ellos se calcula el % de avance.
Viene con una plantilla de ocho secciones lista para usar.

**Captura.** En cada campo hay tres botones: 🎙 graba voz con cronómetro (tope de
10 minutos por nota), 📷 abre la cámara del dispositivo, 🖼 sube fotos tomadas con otro
equipo. La evidencia queda amarrada a la pregunta, no suelta en una carpeta. Se guarda
solo mientras escribes; no hay botón de guardar que se pueda olvidar.

**Seguimiento.** El Tablero muestra avance global, por estado, por área y la carga de
cada persona.

**Exportar.** CSV con una columna por campo de la plantilla, o JSON completo con
plantilla, equipo, procesos y referencias a la evidencia.

---

## 10. Estructura

```
├── app.py              punto de entrada, rutas de vista, healthcheck
├── api.py              API REST completa
├── auth.py             contraseñas, sesión, roles, auditoría
├── db.py               conexión y helpers SQL (PostgreSQL / SQLite)
├── schema.py           DDL idempotente + plantilla y config por defecto
├── requirements.txt
├── Procfile            comando de arranque para Railway
├── railway.json        builder, healthcheck y política de reinicio
├── .env.example
├── templates/
│   ├── index.html
│   ├── login.html
│   ├── captura.html    página que abre el QR en el celular
│   └── informe.html    informe compartible por WhatsApp o correo
└── static/
    ├── app.js          toda la aplicación cliente
    └── styles.css
```

### Tablas

`usuarios`, `config`, `plantilla`, `procesos`, `evidencias`, `media`,
`capture_tokens`, `envios`, `share_tokens`, `auditoria`.

Las columnas añadidas después de la primera versión se agregan solas al arrancar
(`COLUMNAS_NUEVAS` en `schema.py`), así que actualizar un despliegue existente no
requiere tocar la base ni perder datos.

Las respuestas de cada proceso van en una columna JSON, de modo que cambiar la
plantilla no obliga a migrar la base. Cada cambio de plantilla incrementa su versión.

---

## 11. Notas operativas

- **Edición simultánea**: si dos personas abren el mismo proceso a la vez, gana quien
  guarde de último. Asigna un responsable por proceso.
- **Copias de seguridad**: Railway hace snapshots del Postgres; aun así, exporta el
  JSON completo al cerrar cada fase del levantamiento.
- **Los audios no se transcriben.** Quedan como archivo reproducible. Si quieres
  transcripción automática hay que conectar un servicio de voz a texto; el punto de
  enganche natural es `subir_evidencia` en `api.py`.
- **Bloqueo de intentos**: 8 intentos fallidos de login por IP en 5 minutos.
- **Auditoría**: la tabla `auditoria` registra logins, creación y borrado de procesos,
  subida de evidencias y cambios de plantilla, con usuario, IP y fecha.
