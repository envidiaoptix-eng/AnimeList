"""Rutas de administración: moderación de cuentas y de listas.

Todo el blueprint exige `require_admin`, que ya valida el token y el rol en
cada llamada. Las escrituras sobre animes ajenos no pasan por aquí: se abren
dentro de `routes_anime._load_owned`, que es donde vive la comprobación de
propiedad, para no duplicar la lógica del CRUD.
"""

from flask import Blueprint, jsonify, request
from werkzeug.security import generate_password_hash

from auth import require_admin
from config import ADMIN_USERNAMES
from routes_auth import _password_error
from store import (
    find_anime,
    is_admin,
    load_anime,
    load_users,
    public_profile,
    save_anime,
    save_users,
)

bp = Blueprint('admin', __name__, url_prefix='/api/admin')


def _admin_count(users):
    """Administradores efectivos (env ∪ role) entre los registros dados."""
    return sum(1 for name, profile in users.items() if is_admin(name, profile))


def _target_or_404(users, target):
    profile = users.get(target)
    if profile is None:
        return None, (jsonify({'error': 'Ese usuario no existe.'}), 404)
    return profile, None


@bp.get('/users')
@require_admin
def list_users(username):
    """Censo de cuentas: perfil público + nº de animes. Sin hashes ni blobs."""
    users = load_users()
    counts = {}
    for anime in load_anime():
        owner = anime.get('user')
        counts[owner] = counts.get(owner, 0) + 1

    listing = []
    for name in sorted(users, key=str.lower):
        profile = public_profile(name, users[name])
        profile['anime_count'] = counts.get(name, 0)
        listing.append(profile)

    return jsonify({'users': listing, 'admins': _admin_count(users)})


@bp.delete('/users/<target>')
@require_admin
def delete_user(username, target):
    """Borra la cuenta y toda su lista.

    Guardas: no puedes borrarte a ti mismo, y nunca se elimina el último
    administrador (se quedaría la app sin nadie capaz de moderarla).
    """
    users = load_users()
    profile, error = _target_or_404(users, target)
    if error:
        return error

    if target == username:
        return jsonify({'error': 'No puedes borrar tu propia cuenta desde aquí.'}), 400
    if is_admin(target, profile) and _admin_count(users) <= 1:
        return jsonify({'error': 'No se puede eliminar el último administrador.'}), 400

    del users[target]
    save_users(users)

    animes = load_anime()
    removed = sum(1 for anime in animes if anime.get('user') == target)
    if removed:
        save_anime([a for a in animes if a.get('user') != target])

    return jsonify({'message': f'Cuenta {target} eliminada.', 'animes_deleted': removed})


@bp.post('/users/<target>/password')
@require_admin
def reset_password(username, target):
    """Resetea la contraseña de una cuenta sin conocer la anterior."""
    users = load_users()
    _, error = _target_or_404(users, target)
    if error:
        return error

    new_password = str((request.get_json(silent=True) or {}).get('password') or '')
    error = _password_error(new_password)
    if error:
        return jsonify({'error': error}), 400

    users[target]['password_hash'] = generate_password_hash(new_password)
    save_users(users)
    return jsonify({'message': f'Contraseña de {target} actualizada.'})


@bp.put('/users/<target>/role')
@require_admin
def set_role(username, target):
    """Promueve a admin o retira el rol (solo los de `role`, no los del env)."""
    users = load_users()
    profile, error = _target_or_404(users, target)
    if error:
        return error

    role = str((request.get_json(silent=True) or {}).get('role') or '').strip()
    if role not in ('admin', 'user'):
        return jsonify({'error': 'El rol debe ser "admin" o "user".'}), 400

    if role == 'user':
        if target.lower() in ADMIN_USERNAMES:
            return jsonify({'error': 'Esa cuenta es admin por ANIMELIST_ADMIN: quítalo desde el entorno.'}), 400
        if is_admin(target, profile) and _admin_count(users) <= 1:
            return jsonify({'error': 'No se puede retirar el rol del último administrador.'}), 400
        profile.pop('role', None)
    else:
        profile['role'] = 'admin'

    save_users(users)
    return jsonify({'message': f'Rol de {target} actualizado.', 'profile': public_profile(target, profile)})
