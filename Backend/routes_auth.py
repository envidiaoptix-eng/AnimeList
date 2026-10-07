"""Rutas de cuenta: registro, inicio de sesión y perfil."""

import base64
import binascii
import re
from urllib.parse import urlparse

from flask import Blueprint, Response, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

from auth import make_token, require_auth
from config import (
    AVATAR_MAX_BYTES,
    BACKGROUND_MAX_BYTES,
    BANNER_MAX_BYTES,
    IMAGE_KINDS,
    PASSWORD_MAX,
    PASSWORD_MIN,
    TOKEN_TTL_SECONDS,
    USERNAME_MAX,
    USERNAME_MIN,
)
from store import load_anime, load_users, now_iso, public_profile, save_users

bp = Blueprint('auth', __name__, url_prefix='/api')

USERNAME_PATTERN = re.compile(r'^[A-Za-z0-9_.-]+$')

# Campo del perfil donde se guarda cada imagen subida, y su tope en bytes ya
# reescalado. Son campos aparte de `avatar_url`, que sigue siendo solo una URL
# externa: así `public_profile` puede decir `has_avatar` sin arrastrar 120 KB de
# base64 en cada llamada a /api/me.
IMAGE_FIELDS = {
    'avatar': ('avatar_blob', AVATAR_MAX_BYTES),
    'banner': ('banner_blob', BANNER_MAX_BYTES),
    'background': ('background_blob', BACKGROUND_MAX_BYTES),
}

# Campos del perfil que guardan la URL externa de una imagen. Solo avatar y
# fondo: el banner siempre se sube como fichero, asi que no hay `banner_url`
# ni en el perfil ni en `public_profile`.
URL_FIELDS = {'avatar_url': 'avatar', 'background_url': 'fondo de página'}

# Se valida la cabecera del archivo, no el nombre ni el `Content-Type` que
# declara el cliente: los dos los controla quien llama. Solo se aceptan JPEG y
# PNG, que es lo que produce el recorte del canvas del frontend.
IMAGE_SIGNATURES = (
    (b'\xff\xd8\xff', 'image/jpeg'),
    (b'\x89PNG\r\n\x1a\n', 'image/png'),
)


def _decode_image(raw, kind):
    """Valida y decodifica una imagen en base64. Devuelve (bytes, mime, error)."""
    max_bytes = IMAGE_FIELDS[kind][1]
    if not raw:
        return None, None, 'No se ha enviado ninguna imagen.'

    # Solo base64: `data:image/jpeg;base64,...` o el base64 pelado.
    payload = str(raw).split(',', 1)[-1].strip()
    if not payload:
        return None, None, 'La imagen viene vacía.'

    try:
        data = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        return None, None, 'La imagen no está codificada en base64 válido.'

    if len(data) > max_bytes:
        kb = round(max_bytes / 1024)
        return None, None, f'La imagen es demasiado grande (máximo {kb} KB).'

    mime = next((mime for magic, mime in IMAGE_SIGNATURES if data.startswith(magic)), None)
    if not mime:
        return None, None, 'Solo se admiten imágenes PNG o JPG.'

    return data, mime, None


def _credentials():
    data = request.get_json(silent=True) or {}
    return str(data.get('username') or '').strip(), str(data.get('password') or '')


def _username_error(username):
    if len(username) < USERNAME_MIN:
        return f'El usuario debe tener al menos {USERNAME_MIN} caracteres.'
    if len(username) > USERNAME_MAX:
        return f'El usuario no puede superar {USERNAME_MAX} caracteres.'
    if not USERNAME_PATTERN.match(username):
        return 'El usuario solo admite letras, números, punto, guion y guion bajo.'
    return None


def _password_error(password):
    if len(password) < PASSWORD_MIN:
        return f'La contraseña debe tener al menos {PASSWORD_MIN} caracteres.'
    if len(password) > PASSWORD_MAX:
        return 'La contraseña es demasiado larga.'
    return None


def _is_safe_url(value):
    """Solo http(s): evita guardar URLs javascript: que luego se renderizan."""
    if not value:
        return True
    parsed = urlparse(value)
    return parsed.scheme in ('http', 'https')


def _session_payload(username, profile):
    return {
        'username': username,
        'token': make_token(username),
        'expires_in': TOKEN_TTL_SECONDS,
        'profile': public_profile(username, profile),
    }


@bp.post('/register')
def register():
    username, password = _credentials()

    error = _username_error(username) or _password_error(password)
    if error:
        return jsonify({'error': error}), 400

    users = load_users()
    if username in users:
        return jsonify({'error': 'Ese nombre de usuario ya está en uso.'}), 409

    users[username] = {
        'password_hash': generate_password_hash(password),
        'display_name': username,
        'avatar_url': '',
        'created_at': now_iso(),
    }
    save_users(users)

    return jsonify(_session_payload(username, users[username])), 201


@bp.post('/login')
def login():
    username, password = _credentials()

    users = load_users()
    profile = users.get(username)
    if not profile or not check_password_hash(profile['password_hash'], password):
        return jsonify({'error': 'Usuario o contraseña incorrectos.'}), 401

    return jsonify(_session_payload(username, profile)), 200


@bp.get('/me')
@require_auth
def me(username):
    profile = load_users().get(username)
    if not profile:
        return jsonify({'error': 'La cuenta ya no existe.'}), 404

    animes = [a for a in load_anime() if a.get('user') == username]
    return jsonify({'profile': public_profile(username, profile), 'anime_count': len(animes)})


@bp.put('/profile')
@require_auth
def update_profile(username):
    data = request.get_json(silent=True) or {}
    users = load_users()
    profile = users.get(username)
    if not profile:
        return jsonify({'error': 'La cuenta ya no existe.'}), 404

    if 'display_name' in data:
        display_name = str(data['display_name']).strip()
        if not 1 <= len(display_name) <= 50:
            return jsonify({'error': 'El nombre visible debe tener entre 1 y 50 caracteres.'}), 400
        profile['display_name'] = display_name

    for field, label in URL_FIELDS.items():
        if field not in data:
            continue
        value = str(data[field]).strip()
        if not _is_safe_url(value):
            return jsonify({'error': f'La URL del {label} debe empezar por http o https.'}), 400
        profile[field] = value

    save_users(users)
    return jsonify({'profile': public_profile(username, profile)})


@bp.put('/profile/image')
@require_auth
def update_profile_image(username):
    """Sube el avatar o el banner, ya recortados por el cliente con canvas.

    Se guarda como data URL dentro del perfil, no como archivo en disco: así el
    dato viaja con el usuario a Firestore en el paso 4 y no depende del sistema
    de archivos, que en un hosting gratuito es efímero.
    """
    data = request.get_json(silent=True) or {}
    kind = str(data.get('kind') or '').strip()
    if kind not in IMAGE_KINDS:
        return jsonify({'error': 'Indica qué imagen es: avatar, banner o fondo.'}), 400

    users = load_users()
    profile = users.get(username)
    if not profile:
        return jsonify({'error': 'La cuenta ya no existe.'}), 404

    if data.get('remove'):
        profile[IMAGE_FIELDS[kind][0]] = ''
        save_users(users)
        return jsonify({'message': 'Imagen eliminada.', 'profile': public_profile(username, profile)})

    payload, mime, error = _decode_image(data.get('data'), kind)
    if error:
        return jsonify({'error': error}), 400

    field = IMAGE_FIELDS[kind][0]
    profile[field] = f'data:{mime};base64,{base64.b64encode(payload).decode("ascii")}'
    save_users(users)

    return jsonify({
        'message': 'Imagen guardada.',
        'kind': kind,
        'bytes': len(payload),
        'profile': public_profile(username, profile),
    })


@bp.get('/users')
@require_auth
def list_users(username):
    """Buscador de cuentas para ver listas ajenas.

    Solo sale el perfil público (nunca `password_hash` ni los blobs): es lo
    necesario para pintar una fila de resultados y saltar a su lista.
    """
    term = (request.args.get('q') or '').strip().lower()
    users = load_users()
    counts = {}
    for anime in load_anime():
        owner = anime.get('user')
        counts[owner] = counts.get(owner, 0) + 1

    matches = [
        public_profile(name, profile)
        for name, profile in users.items()
        if not term or term in name.lower() or term in (profile.get('display_name') or '').lower()
    ]
    matches.sort(key=lambda p: p['username'].lower())
    for profile in matches:
        profile['anime_count'] = counts.get(profile['username'], 0)

    return jsonify({'users': matches[:50], 'total': len(matches)})


@bp.get('/users/<target>')
@require_auth
def get_user(username, target):
    """Perfil público de una cuenta ajena, para la cabecera de su lista."""
    profile = load_users().get(target)
    if not profile:
        return jsonify({'error': 'Ese usuario no existe.'}), 404

    payload = public_profile(target, profile)
    payload['anime_count'] = sum(1 for a in load_anime() if a.get('user') == target)
    return jsonify({'profile': payload})


@bp.get('/profile/image/<kind>')
@require_auth
def get_profile_image(username, kind):
    """Devuelve los bytes de la imagen para que el frontend los pinte.

    Las imágenes no van dentro de `/api/me`: un banner son ~120 KB en base64 que
    se descargarían en cada carga y ocuparían la caché de localStorage. Aquí se
    piden solo cuando hacen falta, y el cliente crea un object URL.

    `?user=` permite pedir la de otra cuenta (avatar/banner/fondo de la lista
    ajena). Sigue exigiendo token: no hay nada público en la app.
    """
    if kind not in IMAGE_KINDS:
        return jsonify({'error': 'Esa imagen no existe.'}), 404

    target = (request.args.get('user') or '').strip() or username
    profile = load_users().get(target)
    if not profile:
        return jsonify({'error': 'La cuenta ya no existe.'}), 404

    stored = profile.get(IMAGE_FIELDS[kind][0]) or ''
    if not stored.startswith('data:'):
        return jsonify({'error': 'No hay ninguna imagen guardada.'}), 404

    header, _, payload = stored.partition(',')
    mime = header[5:].split(';')[0] or 'application/octet-stream'
    try:
        data = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        return jsonify({'error': 'La imagen almacenada está corrupta.'}), 500

    # `no-store` y no `max-age`: la imagen cambia cada vez que el usuario la
    # sustituye, y con cache el navegador devolvia la copia de ayer sin preguntar
    # al servidor, asi que subir un avatar nuevo no se veia hasta recargar. Quitar
    # si funcionaba porque no pasa por aqui. El `Map` de `profile.js` ya evita
    # repetir la descarga dentro de una sesion, que es la unica cache que interesa.
    return Response(
        data,
        mimetype=mime,
        headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'},
    )


@bp.post('/password')
@require_auth
def change_password(username):
    data = request.get_json(silent=True) or {}
    users = load_users()
    profile = users.get(username)
    if not profile:
        return jsonify({'error': 'La cuenta ya no existe.'}), 404

    if not check_password_hash(profile['password_hash'], str(data.get('current_password') or '')):
        return jsonify({'error': 'La contraseña actual no es correcta.'}), 401

    new_password = str(data.get('new_password') or '')
    error = _password_error(new_password)
    if error:
        return jsonify({'error': error}), 400

    profile['password_hash'] = generate_password_hash(new_password)
    save_users(users)
    return jsonify({'message': 'Contraseña actualizada.'})