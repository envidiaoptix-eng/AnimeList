# AGENTS.md

## Stack

- **Backend:** Flask 3.1.3 + flask-cors, Python 3.14. Las APIs externas se llaman con `urllib` de la stdlib. En producción se añaden `gunicorn` y `firebase-admin` (ver `requirements.txt`).
- **Frontend:** HTML/JS/CSS estático con módulos ES nativos. Sin build, sin gestor de paquetes.
- **Datos:** JSON planos en `Backend/` (`users.json`, `anime_list.json`) escritos de forma atómica, o **Firestore** si se activa (ver «Persistencia»).
- **Venv:** `Backend/env/` — recrear con `pip install flask flask-cors`, y `pip install firebase-admin` solo si se va a usar Firestore.

## Running

- **Todo en uno:** `Backend/env/Scripts/python.exe Backend/app.py` → `http://localhost:5000`
  Flask sirve la API **y** el frontend, así que no hace falta ningún servidor aparte.
- **Sin servidor:** también se puede abrir `Frontend/index.html` directamente (CORS permite `Origin: null`).
- Sin comandos de build, lint ni typecheck

## Arquitectura del backend

Un módulo por responsabilidad, todos importándose entre sí por ruta de módulo:

| Archivo | Responsabilidad |
|---|---|
| `app.py` | fábrica de la app, CORS restringido, blueprints, servido del frontend, arranque |
| `config.py` | rutas, clave de firma, timeouts, límites de validación, variables de Firebase |
| `store.py` | conmutación JSON/Firestore + escritura JSON atómica y migración del formato de usuarios |
| `firestore_store.py` | adaptador de Firestore (Admin SDK), import perezoso, escritura por diferencias |
| `migrate_to_firestore.py` | migración JSON → Firestore, con simulación por defecto |
| `auth.py` | tokens Bearer HMAC-SHA256, `require_auth` |
| `external.py` | clientes de AniList y Kitsu, caché, reintentos, normalización |
| `routes_auth.py` | registro, login, perfil, contraseña |
| `routes_anime.py` | CRUD de anime, búsqueda, estadísticas |

- **Frontend estático:** `GET /` y `GET /<path>` entregan `Frontend/` con `send_from_directory`, que bloquea el path traversal; `api/*` no pasa por ahí y cae en el 404 JSON.
- **Tokens:** `base64url(payload).base64url(hmac)` con `{"u": usuario, "exp": ts}`, 7 días de validez. La clave vive en `Backend/secret.key` (generada sola, gitignored), salvo que exista `ANIMELIST_SECRET_KEY`, que siempre manda.
- **Propiedad:** todo el CRUD exige `@require_auth`, y cada anime se valida contra `anime['user']` contra el usuario del token. 401 sin token, 403 si el recurso es de otro.
- **Escrituras:** `store.write_json` usa fichero temporal + `os.replace`; un JSON corrupto se renombra a `.corrupto-<fecha>` en vez de perderse.
- **Caché externa:** `_cache_get` devuelve una **copia profunda**. Sin esto, un `pop()` en la capa de rutas mutilaba la entrada y la segunda búsqueda del mismo término devolvía 500.

## Persistencia: JSON o Firestore

`store.load_users/save_users/load_anime/save_anime` no saben en qué modo están: `store.backend()` devuelve `(nombre, adaptador)` una sola vez y las rutas nunca eligen backend. `/api/health` lo expone como `storage`, que en Render es la forma rápida de ver si el sitio se quedó en `json` por una credencial mal puesta.

| Variable | Efecto |
|---|---|
| `ANIMELIST_USE_FIRESTORE=1` | commuta a Firestore. Sin esto, siempre JSON. |
| `GOOGLE_APPLICATION_CREDENTIALS` | ruta al JSON de la cuenta de servicio |
| `FIREBASE_CREDENTIALS` | el mismo JSON en línea (lo que se usa en Render) |
| `FIREBASE_PROJECT_ID` | evita depender del `project_id` del JSON |
| `FIREBASE_DATABASE_ID` | base con nombre; **obligatoria** si el proyecto no usa `(default)` (los de Firebase Studio no) |

- **Solo backend, nunca cliente.** El navegador no habla con Firestore: todo pasa por el Admin SDK, que ignora las reglas de seguridad. Se pueden cerrar a cualquier cliente.
- **Esquema:** `users/{usuario}` con el perfil entero (incluido `password_hash` y los blobs base64) y `anime/{id}` con un documento por anime y `user` como propietario. Los nombres de usuario pasan `^[A-Za-z0-9_.-]+$`, así que son IDs de documento válidos.
- **Escritura por diferencias:** una lectura de la colección y luego upsert de lo cambiado + borrado de lo sobrante, en lotes de 400. Sin el diff, marcar un anime reescribiría la lista entera.
- **Si Firestore falla al arrancar, se cae al JSON** con un aviso por log. Es preferible responder en `/api/health` con datos vacíos a dejar el sitio entero caído.
- **Migración:** `Backend/migrate_to_firestore.py` solo informa; hace falta `--apply` para escribir, y `--replace` para sobrescribir lo que ya exista. Termina releyendo para comprobar que el `password_hash` coincide.

## Despliegue (Render)

- `render.yaml` (Blueprint), `wsgi.py` (`gunicorn wsgi:app`) y `requirements.txt` en la raíz del repo.
- **El disco de Render es efímero:** en cada despliegue se borra, así que en producción los JSON locales no sirven como almacén. Firestore es obligatorio; `ANIMELIST_USE_FIRESTORE=1` lo fuerza.
- **`ANIMELIST_SECRET_KEY` es obligatoria:** sin ella, `secret.key` se regenera en cada arranque en frío y todos los tokens dejan de valer.
- Plan `free`: el servicio duerme a los 15 min sin uso. La primera petición tras dormir tarda unos segundos.
- El JSON de la cuenta de servicio se pega en `FIREBASE_CREDENTIALS` desde la consola de Render (se cifra); no se sube como fichero. `.gitignore` cubre `*service-account*.json` por si acaso.

## APIs externas

- **AniList** (principal, GraphQL, sin clave, 90 req/min) y **Kitsu** (respaldo, JSON:API, sin clave).
- Un resultado vacío **no** activa el respaldo: cero resultados es una respuesta legítima.
- Timeout de 6 s, 3 reintentos con espera creciente ante 403/429/5xx de Cloudflare, y caché en memoria de 10 min (200 entradas).
- Kitsu no acepta `sort=averageScore` (devuelve 400); su nota se calcula a partir de `ratingFrequencies`.
- La sinopsis llega con HTML: se limpia con `Markup(...).striptags()` antes de guardarse.

## Endpoints

| Método | Ruta | Auth |
|---|---|---|
| POST | `/api/register` | — |
| POST | `/api/login` | — |
| GET | `/api/health` | — |
| GET | `/api/me` | token |
| PUT | `/api/profile` | token |
| PUT | `/api/profile/image` | token |
| GET | `/api/profile/image/<kind>` | token |
| POST | `/api/password` | token |
| GET | `/api/anime` | token |
| POST | `/api/anime` | token |
| GET | `/api/anime/search` | token |
| GET/PUT/DELETE | `/api/anime/<id>` | token + propietario |
| GET | `/api/anime/<id>/external` | token + propietario |
| GET | `/api/stats` | token |

## Frontend

| Archivo | Responsabilidad |
|---|---|
| `api.js` | cliente HTTP: token, errores tipados, redirección al caducar |
| `storage.js` | ajustes, caché por usuario, cola offline, detección de conexión |
| `data_repository.js` | **fuente de verdad**: Flask → caché en localStorage (con cola offline) |
| `ui.js` | `el()`, `toast()`, `confirmDialog()`, formateadores |
| `theme.js` | tema claro/oscuro (se aplica en `<head>` para evitar parpadeo) |
| `search_modal.js` | diálogo de búsqueda con debounce + autocomplete del título |
| `profile.js` | diálogo de perfil: recorte en canvas y subida de avatar/banner |
| `dashboard.js` | render de tarjetas, edición, borrado con deshacer, filtros, stats |
| `app.js` | registro e inicio de sesión |

- **Firebase en el cliente está desactivado** (`Frontend/firebase-config.js`, `FIREBASE_ENABLED = false`). Ya no hace falta: el backend habla con Firestore por su cuenta, así que el navegador nunca lo ve. El SDK solo se descargaba si había config válida. Plantillas en `Backend/firestore.rules`, `storage.rules` y `firebase.json`.
- **Imágenes de perfil:** el cliente recorta a 256×256 (avatar) y 1500×400 (banner) en canvas y las sube como base64. El backend valida los magic bytes JPEG/PNG, guarda el blob en `avatar_blob`/`banner_blob` y lo sirve por `GET /api/profile/image/<kind>` (siempre con token). `/api/me` solo expone `has_avatar`/`has_banner`: los bytes no viajan nunca en el perfil, así que la cabecera los pide aparte como `Blob` y los pinta con object URLs.
- **Offline:** sin red, las escrituras se guardan en la caché y entran en una cola que se reintenta en orden al recuperar la conexión (`DataRepository.flushQueue`).
- Todo el contenido dinámico se inserta con `text`/`textContent`, nunca con `innerHTML`.

## Convenciones

- Interfaz en español
- Tema claro/oscuro con variables CSS en `:root` y `[data-theme='light']`
- Estados de anime: `Pendiente`, `Viendo`, `Completado`, `Abandonado`
- Notas de 1 a 10; `episodes` es entero o `'?'`
- `prefers-reduced-motion` desactiva transformaciones y animaciones

## Verificación

No hay suite de tests. Para comprobar cambios:

```powershell
# sintaxis del backend
Backend\env\Scripts\python.exe -m compileall -q Backend

# sintaxis de cada módulo ES (los .js son módulos, no scripts)
Get-ChildItem Frontend -Filter *.js | ForEach-Object {
    Get-Content -Raw $_.FullName | node --input-type=module --check -
}
```

Para las capas de red conviene una prueba con el cliente de pruebas de Flask
(`create_app().test_client()`): cubre 401/403/404, validación y búsqueda real.