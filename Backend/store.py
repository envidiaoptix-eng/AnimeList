"""Persistencia.

Por defecto en archivos JSON, con lectura tolerante a fallos y escritura atómica
(fichero temporal + os.replace) para que un cierre abrupto a mitad de guardado
no corrompa los datos.

Si hay credenciales de Firebase y `ANIMELIST_USE_FIRESTORE=1`, las mismas
funciones pasan a usar Firestore (ver `firestore_store`). Las rutas no saben en
que modo estan: `backend_name()` lo dice para el log y para `/api/health`.

Si Firestore se declara activo pero falla al arrancar, se vuelve a JSON y se
avisa: es preferible arrancar con datos locales_old a no arrancar.
"""

import json
import os
import tempfile
import uuid
from datetime import datetime, timezone

from config import ADMIN_USERNAMES, ANIME_FILE, COMMENTS_FILE, FRIENDS_FILE, USERS_FILE

_BACKEND = None
_BACKEND_NAME = 'json'
_BACKEND_RESOLVED = False


def _resolve_backend():
    """Elige el backend una sola vez y devuelve (nombre, adaptador o None)."""
    if os.environ.get('ANIMELIST_USE_FIRESTORE', '0') != '1':
        return 'json', None

    try:
        from firestore_store import FirestoreStore
        return 'firestore', FirestoreStore()
    except Exception as exc:
        # Es preferible arrancar con los datos locales a no arrancar. En Render
        # el JSON local estara vacio, pero al menos la API responde en vez de
        # dejar el sitio entero caido por una credencial mal puesta.
        print(f'[store] Firestore no disponible ({exc}); se usa el JSON local.')
        return 'json', None


def backend():
    """Devuelve (nombre, adaptador), resolviendolo en la primera llamada."""
    global _BACKEND, _BACKEND_NAME, _BACKEND_RESOLVED
    if not _BACKEND_RESOLVED:
        _BACKEND_RESOLVED = True
        _BACKEND_NAME, _BACKEND = _resolve_backend()
        if _BACKEND_NAME == 'firestore':
            print('[store] Usando Firestore.')
    return _BACKEND_NAME, _BACKEND


def backend_name():
    return backend()[0]



def _backup_corrupt(path):
    """Renombra un JSON ilegible para no perderlo silenciosamente."""
    try:
        stamp = datetime.now().strftime('%Y%m%d%H%M%S')
        os.replace(path, f'{path}.corrupto-{stamp}')
    except OSError:
        pass


def read_json(path, default):
    """Lee un JSON. Si no existe o está corrupto, devuelve el valor por defecto."""
    if not os.path.exists(path):
        return default
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, UnicodeDecodeError):
        _backup_corrupt(path)
        return default
    except OSError:
        return default


def write_json(path, data):
    """Escribe un JSON de forma atómica: tmp en el mismo disco y os.replace."""
    directory = os.path.dirname(path)
    handle, tmp_path = tempfile.mkstemp(dir=directory, prefix='.tmp-', suffix='.json')
    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------------
# Usuarios
# --------------------------------------------------------------------------

def _migrate_user_record(username, value):
    """Convierte el formato plano {"user": "hash"} al formato con perfil."""
    if isinstance(value, str):
        return {
            'password_hash': value,
            'display_name': username,
            'avatar_url': '',
            'created_at': now_iso(),
        }
    if isinstance(value, dict) and 'password_hash' in value:
        record = dict(value)
        record.setdefault('display_name', username)
        record.setdefault('avatar_url', '')
        record.setdefault('created_at', now_iso())
        return record
    # Un registro con formato antiguo o corrupto no debe descartarse en silencio:
    # podría perderse un usuario entero al reescribir. Se deja un aviso y NO se
    # migra: quien lo lea podrá decidir o, al menos, el log deja huella.
    try:
        import logging
        logging.warning('store._migrate_user_record: registro inválido para %s', username)
    except Exception:
        print(f'[store] registro inválido para {username}')
    return None


def load_users():
    """Devuelve {usuario: perfil}. Migra en memoria el formato antiguo."""
    name, adapter = backend()
    if name == 'firestore':
        return adapter.load_users()

    raw = read_json(USERS_FILE, {})
    if not isinstance(raw, dict):
        return {}

    users = {}
    for username, value in raw.items():
        record = _migrate_user_record(username, value)
        if record is not None:
            users[username] = record
    return users


def save_users(users):
    name, adapter = backend()
    if name == 'firestore':
        adapter.save_users(users)
        return
    write_json(USERS_FILE, users)


def is_admin(username, profile=None):
    """¿Tiene privilegios de administración?

    Vive aquí (y no en `auth`) porque `public_profile` lo necesita y `store` no
    importa a nadie: así no se monta un ciclo. El rol NO viaja en el token: se
    consulta en cada petición, así que promover o revocar un admin surte
    efecto al instante, sin esperar a que caduquen las sesiones.
    """
    if not username:
        return False
    if username.lower() in ADMIN_USERNAMES:
        return True
    profile = profile if profile is not None else load_users().get(username, {})
    return profile.get('role') == 'admin'


def public_profile(username, profile=None):
    """Vista del perfil sin el hash de contraseña.

    Deliberadamente NO incluye las imágenes en base64: solo dice si las hay
    (`has_avatar` / `has_banner`) para que el cliente pida los bytes solo cuando
    los va a pintar, en vez de arrastrar ~120 KB en cada respuesta.
    """
    profile = profile if profile is not None else load_users().get(username, {})
    return {
        'username': username,
        'display_name': profile.get('display_name') or username,
        'avatar_url': profile.get('avatar_url', ''),
        'background_url': profile.get('background_url', ''),
        'has_avatar': bool(profile.get('avatar_blob')),
        'has_banner': bool(profile.get('banner_blob')),
        'has_background': bool(profile.get('background_blob')),
        'created_at': profile.get('created_at'),
        'is_admin': is_admin(username, profile),
    }


# --------------------------------------------------------------------------
# Anime
# --------------------------------------------------------------------------

ANIME_FIELDS = (
    'title',
    'title_native',
    'title_english',
    'rating',
    'cover_url',
    'synopsis',
    'episodes',
    'status',
    'genres',
    'year',
    'format',
    'studios',
    'trailer',
    'score',
    'anilist_id',
    'mal_id',
    'kitsu_id',
    'source',
    'rankings',
    'lists',
)


def normalize_anime(anime):
    """Rellena campos ausentes de registros antiguos o incompletos."""
    record = dict(anime)
    record.setdefault('id', '')
    record.setdefault('user', '')
    record.setdefault('title', 'Sin título')
    record.setdefault('title_native', '')
    record.setdefault('title_english', '')
    record.setdefault('cover_url', '')
    record.setdefault('synopsis', '')
    record.setdefault('episodes', '?')
    record.setdefault('status', 'Pendiente')
    record.setdefault('genres', [])
    record.setdefault('year', None)
    record.setdefault('format', 'Unknown')
    record.setdefault('studios', [])
    record.setdefault('trailer', '')
    record.setdefault('score', None)
    record.setdefault('anilist_id', None)
    record.setdefault('mal_id', None)
    record.setdefault('kitsu_id', None)
    record.setdefault('source', 'manual')
    record.setdefault('rankings', [])
    record.setdefault('lists', None)
    record.setdefault('updatedAt', now_iso())
    return record


def load_anime():
    name, adapter = backend()
    if name == 'firestore':
        return adapter.load_anime()

    raw = read_json(ANIME_FILE, [])
    if not isinstance(raw, list):
        return []
    return [normalize_anime(item) for item in raw if isinstance(item, dict)]


def save_anime(animes):
    name, adapter = backend()
    if name == 'firestore':
        adapter.save_anime(animes)
        return
    write_json(ANIME_FILE, animes)


def find_anime(animes, anime_id):
    for anime in animes:
        if anime.get('id') == anime_id:
            return anime
    return None


# --------------------------------------------------------------------------
# Social: amistades y comentarios
# --------------------------------------------------------------------------

def _new_social_id():
    return str(uuid.uuid4())


def normalize_friendship(record):
    """Amistad: par ordenado de usuarios, guardada una sola vez."""
    out = dict(record)
    out.setdefault('id', _new_social_id())
    out.setdefault('user', '')
    out.setdefault('friend', '')
    out.setdefault('created_at', now_iso())
    return out


def normalize_request(record):
    """Solicitud de amistad pendiente, de `from` a `to`."""
    out = dict(record)
    out.setdefault('id', _new_social_id())
    out.setdefault('from', '')
    out.setdefault('to', '')
    out.setdefault('created_at', now_iso())
    return out


def normalize_comment(record):
    """Comentario dirigido a una cuenta. `anime_id` es opcional (enlace a una
    ficha) y `target` es la lista sobre la que se comenta (vacío = muro global)."""
    out = dict(record)
    out.setdefault('id', _new_social_id())
    out.setdefault('user', '')
    out.setdefault('text', '')
    out.setdefault('anime_id', None)
    out.setdefault('target', '')
    out.setdefault('created_at', now_iso())
    return out


def load_friends():
    """Devuelve {'friendships': [...], 'requests': [...]}."""
    name, adapter = backend()
    if name == 'firestore':
        return adapter.load_friends()

    raw = read_json(FRIENDS_FILE, {})
    if not isinstance(raw, dict):
        raw = {}
    friendships = raw.get('friendships')
    requests = raw.get('requests')
    return {
        'friendships': [normalize_friendship(item)
                        for item in friendships if isinstance(item, dict)]
        if isinstance(friendships, list) else [],
        'requests': [normalize_request(item)
                     for item in requests if isinstance(item, dict)]
        if isinstance(requests, list) else [],
    }


def save_friends(data):
    name, adapter = backend()
    if name == 'firestore':
        adapter.save_friends(data)
        return
    write_json(FRIENDS_FILE, data)


def load_comments():
    name, adapter = backend()
    if name == 'firestore':
        return adapter.load_comments()

    raw = read_json(COMMENTS_FILE, [])
    if not isinstance(raw, list):
        return []
    return [normalize_comment(item) for item in raw if isinstance(item, dict)]


def save_comments(comments):
    name, adapter = backend()
    if name == 'firestore':
        adapter.save_comments(comments)
        return
    write_json(COMMENTS_FILE, comments)