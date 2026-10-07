"""Configuración central de AnimeList.

Carga rutas, clave de firma y parámetros de las APIs externas.
La clave HMAC se genera una sola vez en `secret.key` (nunca en el repo).
"""

import os
import re
import secrets

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

SECRET_KEY_FILE = os.path.join(BASE_DIR, 'secret.key')
USERS_FILE = os.path.join(BASE_DIR, 'users.json')
ANIME_FILE = os.path.join(BASE_DIR, 'anime_list.json')


def _load_or_create_secret():
    """Devuelve la clave de firma, creándola si no existe o está vacía."""
    if os.path.exists(SECRET_KEY_FILE):
        with open(SECRET_KEY_FILE, 'r', encoding='utf-8') as f:
            existing = f.read().strip()
        if existing:
            return existing

    generated = secrets.token_hex(32)
    with open(SECRET_KEY_FILE, 'w', encoding='utf-8') as f:
        f.write(generated)
    try:
        os.chmod(SECRET_KEY_FILE, 0o600)
    except OSError:
        pass
    return generated


def _resolve_secret():
    """Prefiere la clave del entorno y, si no, la del fichero local.

    En un disco efímero (Render) `secret.key` se regenera en cada despliegue y
    en cada arranque en frío, lo que invalidaría todos los tokens emitidos. Por
    eso el entorno manda: allí se fija como variable secreta y es estable.
    """
    from_env = os.environ.get('ANIMELIST_SECRET_KEY', '').strip()
    return from_env or _load_or_create_secret()


SECRET_KEY = _resolve_secret()

# Duración de los tokens Bearer: 7 días
TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60

# Orígenes permitidos en CORS: file:// (Origin: null) y cualquier puerto de
# localhost. Lo justo para el modo sin servidor y para desarrollo.
#
# En producción NO hace falta abrir nada: el frontend lo sirve esta misma app, de
# modo que el navegador pide a rutas relativas y las peticiones son same-origin,
# donde CORS ni se aplica. Por eso el dominio de Render no se lista aqui y sigue
# sin hacer falta: añadirlo no arregla un error de CORS, y sin necesidad abriria
# la puerta a que otra web use los tokens de un visitante.
ALLOWED_ORIGINS = re.compile(r'^(null|https?://(localhost|127\.0\.0\.1)(:\d+)?)$')

# ---- APIs externas de anime ----
ANILIST_ENDPOINT = 'https://graphql.anilist.co'
KITSU_ENDPOINT = 'https://kitsu.io/api/edge'

# AniList y Kitsu reciben esto. Sin URL propia: la app se sirve desde el mismo
# origen que la API, asi que anunciar `localhost:5000` a un servicio externo
# solo servia para que la peticion pareciera coming de un servidor local.
USER_AGENT = 'AnimeList/1.0'
HTTP_TIMEOUT = 6
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 0.6
SEARCH_PAGE_SIZE = 20

# Caché en memoria para no agotar la cuota de AniList (90 req/min)
CACHE_TTL_SECONDS = 600
CACHE_MAX_ENTRIES = 200

# Techo de búsquedas por usuario y minuto (protege el proxy)
SEARCHES_PER_MINUTE = 30

# Límites de validación
USERNAME_MIN = 3
USERNAME_MAX = 24
PASSWORD_MIN = 6
PASSWORD_MAX = 128
TITLE_MAX = 200
SYNOPSIS_MAX = 2000
QUERY_MAX = 100

VALID_STATUSES = ('Pendiente', 'Viendo', 'Completado', 'Abandonado')
VALID_FORMATS = ('TV', 'Movie', 'OVA', 'ONA', 'Special', 'Music', 'Unknown')
MIN_RATING = 1
MAX_RATING = 10

# AniList expone dos rankings estables en `Media.rankings`, distinguidos por
# `allTime: true` y etiquetados con un literal en ingles dentro de `context`.
# Esta tabla es la unica fuente de verdad: la usa `external` para traducir y
# `routes_anime` para revalidar lo que llega del cliente.
ANILIST_RANK_LABELS = {
    'highest rated all time': 'Mejor puntuado de la historia',
    'most popular all time': 'Más popular de la historia',
}
ANILIST_RANK_ORDER = ('highest rated all time', 'most popular all time')

# Imagenes de perfil. El cliente las recorta a estos tamanos con canvas antes de
# subirlas; los topes son la red de seguridad del servidor.
AVATAR_MAX_BYTES = 120 * 1024
BANNER_MAX_BYTES = 400 * 1024
# El fondo ocupa la pantalla entera, asi que es bastante mas grande que un
# banner. Es el tope sobre los bytes YA decodificados: el base64 va aparte y lo
# cubre `MAX_UPLOAD_BYTES`.
BACKGROUND_MAX_BYTES = 1024 * 1024
# 3 MB y no 2: un fondo de 1 MB viaja en base64 (~1.37 MB) y con 2 MB el
# `MAX_CONTENT_LENGTH` de Flask cortaba la peticion con un 413 antes de que
# `_decode_image` pudiera dar un mensaje util.
MAX_UPLOAD_BYTES = 3 * 1024 * 1024
IMAGE_KINDS = {'avatar', 'banner', 'background'}

DEBUG = os.environ.get('ANIMELIST_DEBUG', '0') == '1'

# ---- Cuentas de administración ----
# Forma estable de designar al admin sin editar ficheros a mano: la misma
# variable sirve en local y en Render. Admite varios separados por comas y la
# comparación no distingue mayúsculas. Los promovidos desde la UI guardan
# `"role": "admin"` en su registro; admin efectivo = esta lista ∪ ese campo.
ADMIN_USERNAMES = {
    name.strip().lower()
    for name in os.environ.get('ANIMELIST_ADMIN', '').split(',')
    if name.strip()
}

# ---- Firebase Firestore (opcional) ----
# La app arranca siempre en modo JSON. Solo si hay credenciales de la cuenta de
# servicio y `ANIMELIST_USE_FIRESTORE=1` se commuta a Firestore; si algo falla
# al inicializar, `store` vuelve a JSON y avisa por log en vez de dejar la app
# sin persistencia.
#
# Dos formas de dar las credenciales, en este orden:
#   GOOGLE_APPLICATION_CREDENTIALS  ruta al JSON (lo normal en local y en Render)
#   FIREBASE_CREDENTIALS           el JSON en linea, util como variable secreta
#
# El cliente nunca habla con Firestore: todo pasa por el backend con el Admin
# SDK, asi que las reglas de seguridad pueden cerrar el acceso a clientes.
FIREBASE_PROJECT_ID = os.environ.get('FIREBASE_PROJECT_ID', '').strip()
# Los proyectos creados desde Firebase Studio no usan `(default)` sino una base
# de datos con nombre propio. Sin esto, `firestore.client()` apuntaria a
# `(default)` y escribiria en una base que el sitio no lee.
FIREBASE_DATABASE_ID = os.environ.get('FIREBASE_DATABASE_ID', '').strip()
GOOGLE_APPLICATION_CREDENTIALS = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS', '').strip()
FIREBASE_CREDENTIALS = os.environ.get('FIREBASE_CREDENTIALS', '').strip()

# Firestore impone 1 MiB por documento. El perfil con avatar y banner en base64
# ronda los 120 KB, asi que hay margen de sobra.
FIRESTORE_COLLECTION_USERS = 'users'
FIRESTORE_COLLECTION_ANIME = 'anime'