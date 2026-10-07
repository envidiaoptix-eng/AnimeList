# AGENTS.md

## Stack

- **Backend:** Flask 3.1.3 + flask-cors, Python 3.14. Las APIs externas se llaman con `urllib` de la stdlib. En producción se añaden `gunicorn` y `firebase-admin` (ver `requirements.txt`).
- **Frontend:** HTML/JS/CSS estático con módulos ES nativos. Sin build, sin gestor de paquetes.
- **Datos:** JSON planos en `Backend/` (`users.json`, `anime_list.json`, `friends.json`, `comments.json`) escritos de forma atómica, o **Firestore** si se activa (ver «Persistencia»).
- **Venv:** `Backend/env/` — recrear con `pip install flask flask-cors`, y `pip install firebase-admin` solo si se va a usar Firestore.

## Running

- **Todo en uno:** `Backend/env/Scripts/python.exe Backend/app.py` → `http://localhost:5000`
  Flask sirve la API **y** el frontend, así que no hace falta ningún servidor aparte.
- **Sin servidor:** también se puede abrir `Frontend/index.html` directamente (CORS permite `Origin: null`). Es el **único** caso en el que `api.js` usa la URL absoluta `http://localhost:5000/api`: en `file://` una ruta relativa se resolvería a `file:///api/...` y fallaría. En cuanto el HTML lo sirve Flask, la base es `/api` relativa.
- Sin comandos de build, lint ni typecheck

## Arquitectura del backend

Un módulo por responsabilidad, todos importándose entre sí por ruta de módulo:

| Archivo | Responsabilidad |
|---|---|
| `app.py` | fábrica de la app, CORS restringido, blueprints, servido del frontend, arranque |
| `config.py` | rutas, clave de firma, timeouts, límites de validación, variables de Firebase, `ADMIN_USERNAMES` |
| `store.py` | conmutación JSON/Firestore + escritura JSON atómica y migración del formato de usuarios + `is_admin` |
| `firestore_store.py` | adaptador de Firestore (Admin SDK), import perezoso, escritura por diferencias |
| `migrate_to_firestore.py` | migración JSON → Firestore, con simulación por defecto |
| `auth.py` | tokens Bearer HMAC-SHA256, `require_auth`, `require_admin` |
| `external.py` | clientes de AniList y Kitsu, caché, reintentos, normalización |
| `routes_auth.py` | registro, login, perfil, contraseña, búsqueda y perfil público de usuarios |
| `routes_anime.py` | CRUD de anime, búsqueda, estadísticas |
| `routes_admin.py` | censo de cuentas, borrar cuenta, resetear contraseña, cambiar rol |
| `routes_social.py` | amistades (solicitudes, aceptar, retirar, eliminar) y comentarios con `target`; de aquí salen `delete_comments_for_anime` y `purge_user_social`, que importan `routes_anime` y `routes_admin` |
| `ratelimit.py` | ventanas deslizantes en memoria para las rutas sociales; `reset()` existe solo para tests |

- **Frontend estático:** `GET /` entrega `landing.html` (portada pública) y `GET /<path>` sirve el resto de `Frontend/` con `send_from_directory`, que bloquea el path traversal; `api/*` no pasa por ahí y cae en el 404 JSON. El registro sigue en `index.html` y el panel en `dashboard.html`.
- **Tokens:** `base64url(payload).base64url(hmac)` con `{"u": usuario, "exp": ts}`, 7 días de validez. La clave vive en `Backend/secret.key` (generada sola, gitignored), salvo que exista `ANIMELIST_SECRET_KEY`, que siempre manda.
- **Propiedad:** todo el CRUD exige `@require_auth`, y cada anime se valida contra `anime['user']` contra el usuario del token. 401 sin token, 403 si el recurso es de otro. El admin lo salta: `_load_owned` deja pasar a `store.is_admin`, que es quien hace posible moderar listas ajenas sin duplicar la lógica del CRUD.
- **Listas ajenas:** `GET /api/anime?user=X` devuelve la lista de cualquier cuenta (404 si no existe) y `GET /api/profile/image/<kind>?user=X` su imagen; las dos siguen exigiendo token. Ver una lista no da poderes sobre ella: el PUT/DELETE del dueño siguen cerrados para el visitante.
- **Roles:** no viajan en el token. `store.is_admin(usuario)` = campo `"role": "admin"` en el perfil **∪** la variable `ANIMELIST_ADMIN` (coma-separada, case-insensitive, vive en `config.ADMIN_USERNAMES`). `auth.require_admin` lo comprueba por request (401 sin token, 403 sin rol) y `/api/me` lo expone como `is_admin` para que la UI sepa qué botones enseñar. Un admin de entorno no se puede revocar desde la app (400): solo quitándolo del entorno.
- **Guardas del admin:** no borrarse a sí mismo, no quedarse sin ningún admin (borrar ni rebajar al último) y rol con valores `admin`/`user`. Siempre 400 con el motivo, que la UI enseña tal cual.
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
| GET | `/api/users?q=` | token |
| GET | `/api/users/<target>` | token |
| GET | `/api/anime` | token |
| GET | `/api/anime?user=` | token |
| POST | `/api/anime` | token |
| GET | `/api/anime/search` | token |
| GET/PUT/DELETE | `/api/anime/<id>` | token + propietario |
| GET | `/api/anime/<id>/external` | token + propietario |
| GET | `/api/stats` | token |
| GET | `/api/admin/users` | token + admin |
| DELETE | `/api/admin/users/<target>` | token + admin |
| POST | `/api/admin/users/<target>/password` | token + admin |
| PUT | `/api/admin/users/<target>/role` | token + admin |
| GET | `/api/friends` | token |
| POST | `/api/friends/request` | token |
| POST | `/api/friends/accept` | token |
| POST | `/api/friends/reject` | token |
| DELETE | `/api/friends/<target>` | token |
| GET | `/api/comments?target=&user=&anime=` | token |
| POST | `/api/comments` | token |
| DELETE | `/api/comments/<id>` | token + autor o admin |

## Frontend

| Archivo | Responsabilidad |
|---|---|
| `api.js` | cliente HTTP: token, errores tipados, redirección al caducar |
| `storage.js` | ajustes, caché por usuario, cola offline, detección de conexión |
| `data_repository.js` | **fuente de verdad**: Flask → caché en localStorage (con cola offline) |
| `icons.js` | catálogo SVG (`icon()`, `hydrateIcons()`) que sustituye a los emojis |
| `ui.js` | `el()`, `toast()`, `confirmDialog()`, formateadores |
| `theme.js` | tema claro/oscuro (se aplica en `<head>` para evitar parpadeo) |
| `search_modal.js` | diálogo de búsqueda con debounce + autocomplete del título |
| `profile.js` | diálogo de perfil: recorte en canvas y subida de avatar/banner |
| `dashboard.js` | render de tarjetas, edición, borrado con deshacer, filtros, stats, modo lista ajena, muro de comentarios, diálogo de amigos y panel de administración |
| `app.js` | registro e inicio de sesión |
| `landing.js` | portada: iconos y salto al panel si ya hay sesión |

- **CSS en `Frontend/css/`**, cargado por orden: `tokens.css` (paleta, escala, movimiento) → `base.css` (reset y elementos) → `components.css` (marca, paneles, botones, modales) → una hoja por pantalla (`auth.css`, `dashboard.css`, `landing.css`). Los componentes compartidos van en `components.css`, nunca en la hoja de una pantalla: `.brand` por ejemplo se usa en las cuatro páginas.
- **Iconos:** el HTML estático declara `<i data-icon="nombre">` y `hydrateIcons()` lo cambia por el SVG de `icons.js`. El nombre de la clave **debe coincidir** con el atributo; un fallo se avisa por consola y deja el marcador, no rompe el render. Nada de emojis: se dibujan con la fuente del sistema y cambian de forma y color entre sistemas operativos.
- **Portada:** `landing.html` no pide nada al backend. La maqueta del hero es estática y con `landing.js` se salta al panel si hay sesión.
- **El cliente no habla con Firestore ni lo habla nunca más.** No hay ningún Firebase en `Frontend/`: ni SDK, ni config, ni `window.FirebaseService`. Todo pasa por el backend con el Admin SDK, así que las reglas pueden cerrar el acceso a cualquier cliente. Los ficheros `Frontend/firebase.js` y `firebase-config.js` se borraron porque nadie los importaba y sus ramas en `data_repository.js` eran no-ops silenciosos; las plantillas que sí sirven siguen en `Backend/firestore.rules`, `storage.rules` y `firebase.json`. **No reintroducirlas en el cliente**: para algo de Firestore, va en `Backend/firestore_store.py`.
- **Imágenes de perfil:** el cliente recorta a 256×256 (avatar), 1500×400 (banner) y 1920×1080 (fondo de página) en canvas y las sube como base64. El fondo baja la calidad a 0.72 porque a 0.82 se pasa de `BACKGROUND_MAX_BYTES`. El backend valida los magic bytes JPEG/PNG, guarda el blob en `avatar_blob`/`banner_blob`/`background_blob` y lo sirve por `GET /api/profile/image/<kind>` (siempre con token). `/api/me` solo expone `has_avatar`/`has_banner`/`has_background`: los bytes no viajan nunca en el perfil, así que la cabecera los pide aparte como `Blob` y los pinta con object URLs. Solo avatar y fondo aceptan URL externa (`URL_FIELDS`); el banner va siempre como fichero, así que `banner_url` no existe como campo.
- **Caché de object URLs:** `profile.js` guarda un `Map` por tipo para no volver a pedir el blob, y `releaseUrl()` lo suelta en dos casos: cuando la imagen ya no existe y **después de subir una nueva**. Ese segundo caso es obligatorio: al guardar, el bucle limpia `staged[kind]` pero no la caché, así que sin el `releaseUrl` el `paint` posterior devolvía la URL de la imagen anterior y la cabecera se quedaba con la foto vieja hasta recargar.
- **El blob de perfil se sirve con `Cache-Control: no-store`** (`routes_auth.py`), y no con un `max-age`. Este fue el bug de verdad detrás de «subo un avatar y no se ve hasta recargar»: con `max-age` el navegador guardaba la imagen 24 horas y devolvía la copia anterior al pedirla otra vez, así que el `releaseUrl` de arriba no bastaba — liberaba la URL en memoria, pero la respuesta siguiente venía de la caché HTTP. Recargar lo arreglaba porque al recargar sí se pide. El `no-store` no cuesta nada: la caché que importa es el `Map` de memoria. **No volver a poner un `max-age` aquí**; `check_ids.py` lo vigila.
- **Los inputs de fichero se vacían dentro de `pick()`**, no solo al abrir el diálogo. Si no, elegir dos veces el mismo archivo en la misma sesión no dispara `change` (el `value` no cambia) y el botón parece muerto. El `File` llega como argumento a `pick`, así que vaciar el input no lo invalida.
- **Avatar de la cabecera:** `#user-avatar` y `#avatar-fallback` son los dos nodos del botón y **solo puede verse uno**. `renderUser()` alterna `dom.avatarFallback.hidden = Boolean(url)`. Antes no se ocultaba nunca, y como `.avatar-btn` es un `grid` de 38px sin `grid-template`, los dos caían en dos filas implícitas de 34px y desbordaban el círculo; la regla `.avatar-btn > .avatar { grid-area: 1 / 1 }` hace de red de seguridad. Con `hidden` no se ve porque `[hidden] { display: none !important; }` gana al grid.
- **Fondo de página:** `background` es el tercer `IMAGE_KIND` y reutiliza el pipeline entero, así que `IMAGE_FIELDS` es lo único que hubo que extender. `dashboard.js` lo pinta como `--page-bg` en `:root` más una clase `has-page-bg`; la regla del velo vive en `dashboard.css` y **no** en `base.css` a propósito, porque la portada, el acceso y el login comparten `base.css` y no deben heredarlo. En `background-image` la primera capa es la de encima, así que el velo va primero y la foto al fondo del todo. El velo se tiñe con `var(--bg)`, no con negro: en el tema oscuro sale un oscurecido y en el claro un aclarado, que es lo que mantiene el texto legible sobre cualquier foto.
- **Offline:** sin red, las escrituras se guardan en la caché y entran en una cola que se reintenta en orden al recuperar la conexión (`DataRepository.flushQueue`).
- **Lista ajena (`dashboard.html?user=X`):** `dashboard.js` deriva `viewUser`/`isOwnList` de la URL. En modo ajeno se ocultan el panel de alta, exportar, buscar y los botones de cada tarjeta (`actionButtons` devuelve `[]`), cambian los textos de estado y vacío, y la cola offline no se toca (`syncQueue` solo con `isOwnList`). Banner y fondo se pintan con el perfil de la cuenta visitada, que llega de `GET /api/users/<target>` en paralelo a la lista; sus imágenes usan `viewImageUrl` con un `Map` propio (`viewImageUrls`), **no** la caché de `profile.js`, que está indexada solo por `kind` y mezclaría fotos de dos cuentas. Un 404 de usuario hace toast + `location.replace('dashboard.html')`: `data_repository.js` relanza el 404 igual que el 401 para no servir la caché propia como si fuera la lista ajena. El buscador de cuentas vive en el menú de usuario (`#view-user-form`, con `datalist` y `ApiClient.searchUsers`); basta con el nombre y Enter.
- **Administración:** el botón `#btn-admin` del menú solo se muestra si `session.profile.is_admin` (lo decide `renderUser`; el rol viene de `/api/me`, no del token) y abre `#admin-dialog` (`initAdminDialog`): censo de `GET /api/admin/users` filtrado en cliente, con «Ver lista», resetear contraseña —formulario bajo la fila, nunca un segundo modal apilado—, promover/revocar y borrar. Toda operación pasa por `confirmDialog` y sus errores (400 de guardas, 403 de rol caducado) salen como toast con el mensaje del backend. Las filas se construyen con `el()` y se hidratan con `hydrateIcons(list)`.
- **Amigos:** el botón `#btn-friends` del menú (visible para cualquier sesión) abre `#friends-dialog` (`initFriendsDialog`, mismo patrón que el censo): tres secciones —solicitudes recibidas (Aceptar/Rechazar), enviadas (Retirar) y amigos (Ver lista / Dejar de ser amigo con `confirmDialog`)— más un formulario de envío con `datalist` de `ApiClient.searchUsers`. Tras cada acción se vuelve a pedir `GET /api/friends` y se repinta. Las filas reutilizan las clases `.admin-row`, así que el scroll del diálogo ya está resuelto en CSS.
- **Banda de lista ajena:** `#view-banner` incluye `#view-friend-actions`, que `renderFriendActions()` pinta según `profile.friendship` (lo trae `GET /api/users/<target>`): `none` → «Añadir amigo», `outgoing` → retirar, `incoming` → aceptar/rechazar, `friend` → eliminar con `confirmDialog`. El backend devuelve el estado nuevo en `response.state`, que se refleja sin volver a pedir el perfil; sin perfil todavía no se pinta nada (el botón nunca adivina).
- **Muro (`#wall`):** exclusivo de `dashboard.html?user=X`; en lista propia ni se muestra. Publica con `target` = la cuenta visitada (`ApiClient.addComment({ text, target: viewUser })`), se pide con `listComments({ target: viewUser })` y cada fila deja borrar si el comentario es propio o la sesión es admin (el backend vuelve a comprobarlo). Errores 400/404/429 como aviso en `#wall-status`. Un comentario no puede apuntar a la propia cuenta (400 del backend): el muro es de listas ajenas.
- Todo el contenido dinámico se inserta con `text`/`textContent`, nunca con `innerHTML`. `el()` no ofrece ninguna rama de HTML: `attrs` admite `class`, `text`, `dataset` y `on*`, y nada más. La rama existió y sobraba —no la usaba ni un `callSite`—, pero contradecía esta regla y era un agujero esperando a que alguien lo empujara.

## Convenciones

- Interfaz en español
- Tema claro/oscuro con variables CSS en `:root` y `[data-theme='light']`
- Estados de anime: `Pendiente`, `Viendo`, `Completado`, `Abandonado`
- Notas de 1 a 10; `episodes` es entero o `'?'`
- `prefers-reduced-motion` desactiva transformaciones y animaciones

## Verificación

Antes de tocar nada, y siempre al terminar, los cuatro tests de `Backend/tests/`.
Los cuatro salen con código 1 si algo falla, así que valen como paso de CI:

```powershell
# contratos entre JS y HTML: ids, selectores, iconos e invariantes
Backend\env\Scripts\python.exe Backend\tests\check_ids.py

# API de perfil contra la app real (create_app().test_client())
Backend\env\Scripts\python.exe Backend\tests\smoke_profile.py

# listas ajenas, buscador de cuentas y todo el área admin
Backend\env\Scripts\python.exe Backend\tests\smoke_admin.py

# amistades, muro de comentarios, limites sociales y cascadas
Backend\env\Scripts\python.exe Backend\tests\smoke_social.py
```

`check_ids.py` cruza cada `getElementById` y cada `querySelector` contra el
HTML y el CSS, cada `data-icon` contra el catálogo de `icons.js`, y comprueba
invariantes que ya han roto una vez (que el avatar y la inicial no se vean
juntos, que `imageUrl` use `${kind}_url`, que el fondo se cargue al abrir el
diálogo, que no quede Firebase en el cliente, que `el()` no asigne
`innerHTML`, que la lista ajena no deje botones de edición ni meta nada en la
cola offline). Merece la pena **añadir la línea cuando se toca algo de eso**: un
`check(...)` nuevo es más barato que el bug que evita.

`smoke_profile.py` cubre 401 sin token, los tres tipos de imagen, magic bytes
JPEG y PNG, topes por tipo, URLs externas peligrosas, aislamiento entre
usuarios, quitar imagen y que el perfil nunca devuelva base64.

`smoke_admin.py` cubre las listas ajenas (`?user=`), el buscador de cuentas,
la imagen de perfil de otra cuenta, el rol admin (por `role` y por
`ANIMELIST_ADMIN`), sus guardas, el reseteo de contraseñas y el borrado de
cuenta con su lista.

`smoke_social.py` cubre el ciclo de amistad completo (solicitar, aceptar,
retirar, eliminar, con sus 409 y su límite horario), el muro con `target`
(publicar, leer filtrado, permisos de borrado) y las cascadas: borrar anime
se lleva sus comentarios y borrar cuenta purga amistades, solicitudes y
comentarios. Rebaja los límites de `config` y limpia `ratelimit` a mano.

Ojo: `smoke_profile.py` **redirige `config.USERS_FILE` y `config.ANIME_FILE` a
un temporal antes de importar la app**, así que no toca `users.json` ni
`anime_list.json`. `smoke_social.py` redirige además `FRIENDS_FILE` y
`COMMENTS_FILE`. Si alguna vez se prueba contra los ficheros de verdad, se
contaminan con usuarios de prueba.

Y la sintaxis, que no cubre ningún test:

```powershell
# sintaxis del backend
Backend\env\Scripts\python.exe -m compileall -q Backend

# sintaxis de cada módulo ES (los .js son módulos, no scripts)
Get-ChildItem Frontend -Filter *.js | ForEach-Object {
    Get-Content -Raw $_.FullName | node --input-type=module --check -
}
```

Lo que **no** cubren los tests: el aspecto. El velo del fondo, el recorte del
avatar y el alto del diálogo hay que mirarlos en el navegador.