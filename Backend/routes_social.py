"""Rutas sociales: amistades y comentarios globales.

Viven aparte de `routes_auth` y `routes_anime` porque el grafo de amistad y el
muro de comentarios son datos propios, con su fichero, sus límites y sus
cascadas. Las funciones de borrado en cadena (`delete_comments_for_anime`,
`purge_user_social`) están aquí y las importan `routes_anime` y
`routes_admin`: así el criterio de qué se borra con qué está en un solo sitio
y no se duplica entre blueprints.

Los comentarios son globales: cualquier cuenta autenticada lee y escribe, con
límite por usuario. `anime_id` es opcional y solo enlaza la ficha; si se borra
el anime, el comentario se va con él.

Los límites se leen de `config` en cada llamada (`config.FRIENDS_...` en vez
de un import directo) para que los tests puedan rebajarlos sin reimportar el
módulo.
"""

import uuid

from flask import Blueprint, jsonify, request

import config
import ratelimit
from auth import require_auth
from store import (
    find_anime,
    is_admin,
    load_anime,
    load_comments,
    load_friends,
    load_users,
    now_iso,
    public_profile,
    save_comments,
    save_friends,
)

bp = Blueprint('social', __name__, url_prefix='/api')

HOUR_SECONDS = 60 * 60
DAY_SECONDS = 24 * 60 * 60
COMMENTS_PAGE = 50


def _target(data):
    return str((data or {}).get('username') or '').strip()


def friendship_index(friends):
    """(parejas de amistad, solicitudes) como conjuntos, para mirar de golpe."""
    pairs = {tuple(sorted((record['user'], record['friend'])))
             for record in friends['friendships']}
    pending = {(record['from'], record['to']) for record in friends['requests']}
    return pairs, pending


def friendship_state(friends, me, other, index=None):
    """Estado de `me` con `other`: `self`, `friend`, `incoming`, `outgoing` o `none`.

    `index` es lo que devuelve `friendship_index`; si no se pasa, se construye
    a partir de `friends`. Pasarlo ahorra recorrer todo el grafo por cada fila
    de un listado (con el índice puesto, `friends` no se llega a tocar).
    """
    pairs, pending = index if index is not None else friendship_index(friends)
    if me == other:
        return 'self'
    if tuple(sorted((me, other))) in pairs:
        return 'friend'
    if (other, me) in pending:
        return 'incoming'
    if (me, other) in pending:
        return 'outgoing'
    return 'none'


def delete_comments_for_anime(anime_id):
    """Cascada al borrar un anime. Devuelve cuántos comentarios se lleva."""
    if not anime_id:
        return 0
    comments = load_comments()
    left = [c for c in comments if c.get('anime_id') != anime_id]
    if len(left) == len(comments):
        return 0
    save_comments(left)
    return len(comments) - len(left)


def purge_user_social(username):
    """Cascada al borrar una cuenta: amistades, solicitudes y comentarios.

    Devuelve los recuentos para que el endpoint de borrado los incluya en su
    respuesta, igual que hace con `animes_deleted`.
    """
    social = load_friends()
    friendships = [r for r in social['friendships']
                   if username not in (r.get('user'), r.get('friend'))]
    requests = [r for r in social['requests']
                if username not in (r.get('from'), r.get('to'))]
    removed_friendships = len(social['friendships']) - len(friendships)
    removed_requests = len(social['requests']) - len(requests)
    if removed_friendships or removed_requests:
        save_friends({'friendships': friendships, 'requests': requests})

    comments = load_comments()
    left = [c for c in comments if c.get('user') != username]
    removed_comments = len(comments) - len(left)
    if removed_comments:
        save_comments(left)

    return {
        'friendships_deleted': removed_friendships,
        'requests_deleted': removed_requests,
        'comments_deleted': removed_comments,
    }


def _entry(users, other, since):
    """Perfil público con la fecha en la que empezó la relación, o None."""
    profile = users.get(other)
    if profile is None:
        return None
    payload = public_profile(other, profile)
    payload['since'] = since
    return payload


@bp.get('/friends')
@require_auth
def list_friends(username):
    """Amistades confirmadas y solicitudes en ambos sentidos."""
    friends = load_friends()
    users = load_users()
    listing = {'friends': [], 'incoming': [], 'outgoing': []}

    for record in friends['friendships']:
        if record['user'] == username:
            entry = _entry(users, record['friend'], record['created_at'])
        elif record['friend'] == username:
            entry = _entry(users, record['user'], record['created_at'])
        else:
            continue
        if entry:
            listing['friends'].append(entry)

    for record in friends['requests']:
        if record['to'] == username:
            entry = _entry(users, record['from'], record['created_at'])
            if entry:
                listing['incoming'].append(entry)
        elif record['from'] == username:
            entry = _entry(users, record['to'], record['created_at'])
            if entry:
                listing['outgoing'].append(entry)

    for bucket in listing.values():
        bucket.sort(key=lambda p: p['display_name'].lower())
    return jsonify(listing)


@bp.post('/friends/request')
@require_auth
def send_request(username):
    target = _target(request.get_json(silent=True))
    if not target:
        return jsonify({'error': 'Indica a qué cuenta quieres enviar la solicitud.'}), 400
    if target == username:
        return jsonify({'error': 'No puedes enviarte una solicitud a ti mismo.'}), 400

    users = load_users()
    if target not in users:
        return jsonify({'error': 'Ese usuario no existe.'}), 404

    social = load_friends()
    state = friendship_state(social, username, target)
    if state == 'friend':
        return jsonify({'error': 'Ya sois amigos.'}), 409
    if state == 'incoming':
        return jsonify({'error': 'Esa cuenta ya te ha enviado una solicitud: acéptala.'}), 409
    if state == 'outgoing':
        return jsonify({'error': 'Ya le enviaste una solicitud; espera a que responda.'}), 409

    outgoing = sum(1 for r in social['requests'] if r.get('from') == username)
    if outgoing >= config.MAX_OUTGOING_REQUESTS:
        return jsonify({'error': f'Tienes {config.MAX_OUTGOING_REQUESTS} solicitudes '
                                 'pendientes; retira alguna antes de enviar otra.'}), 400

    try:
        ratelimit.hit(f'friend-request:{username}', config.FRIEND_REQUESTS_PER_HOUR,
                      HOUR_SECONDS)
    except ratelimit.RateLimited as exc:
        return jsonify({'error': str(exc), 'retry_after': exc.retry_after}), 429

    record = {
        'id': str(uuid.uuid4()),
        'from': username,
        'to': target,
        'created_at': now_iso(),
    }
    social['requests'].append(record)
    save_friends(social)
    return jsonify({'message': f'Solicitud enviada a {target}.',
                    'request': record,
                    'state': 'outgoing'}), 201


@bp.post('/friends/accept')
@require_auth
def accept_request(username):
    target = _target(request.get_json(silent=True))
    if not target:
        return jsonify({'error': 'Indica qué solicitud quieres aceptar.'}), 400
    if target == username:
        return jsonify({'error': 'No puedes aceptarte a ti mismo.'}), 400

    users = load_users()
    if target not in users:
        return jsonify({'error': 'Ese usuario no existe.'}), 404

    social = load_friends()
    match = next((r for r in social['requests']
                  if r.get('from') == target and r.get('to') == username), None)
    if match is None:
        return jsonify({'error': 'No hay ninguna solicitud de esa cuenta.'}), 404

    social['requests'].remove(match)
    # La amistad se guarda una sola vez (par ordenado), así el diff de
    # Firestore y el chequeo de duplicados no dependen de quién aceptó a quién.
    if friendship_state(social, username, target) != 'friend':
        first, second = sorted((username, target))
        social['friendships'].append({
            'id': str(uuid.uuid4()),
            'user': first,
            'friend': second,
            'created_at': now_iso(),
        })
    save_friends(social)
    return jsonify({'message': f'Ahora sois amigos, {target}.',
                    'friend': public_profile(target, users[target]),
                    'state': 'friend'})


@bp.post('/friends/reject')
@require_auth
def reject_request(username):
    """Retira una solicitud pendiente, enviada o recibida."""
    target = _target(request.get_json(silent=True))
    if not target:
        return jsonify({'error': 'Indica qué solicitud quieres retirar.'}), 400

    social = load_friends()
    match = next((r for r in social['requests']
                  if {r.get('from'), r.get('to')} == {username, target}), None)
    if match is None:
        return jsonify({'error': 'No hay ninguna solicitud con esa cuenta.'}), 404

    social['requests'].remove(match)
    save_friends(social)
    return jsonify({'message': 'Solicitud retirada.',
                    'state': friendship_state(social, username, target)})


@bp.delete('/friends/<target>')
@require_auth
def remove_friend(username, target):
    social = load_friends()
    match = next((r for r in social['friendships']
                  if tuple(sorted((r.get('user'), r.get('friend'))))
                  == tuple(sorted((username, target)))), None)
    if match is None:
        return jsonify({'error': 'No sois amigos.'}), 404

    social['friendships'].remove(match)
    save_friends(social)
    return jsonify({'message': f'Ya no eres amigo de {target}.', 'state': 'none'})


def _decorate(comment, users, animes):
    """Perfil del autor y título del anime, sin volver a pedirlos por fila."""
    author = users.get(comment.get('user')) or {}
    anime = animes.get(comment.get('anime_id'))
    payload = dict(comment)
    payload['display_name'] = author.get('display_name') or comment.get('user') or ''
    payload['anime_title'] = anime.get('title') if anime else None
    return payload


@bp.get('/comments')
@require_auth
def list_comments(username):
    """Muro global, con filtros opcionales por autor (`user`) o ficha (`anime`)."""
    user_filter = (request.args.get('user') or '').strip()
    anime_filter = (request.args.get('anime') or '').strip()

    users = load_users()
    if user_filter and user_filter not in users:
        return jsonify({'error': 'Ese usuario no existe.'}), 404

    animes = {a.get('id'): a for a in load_anime()}
    matching = [
        c for c in load_comments()
        if (not user_filter or c.get('user') == user_filter)
        and (not anime_filter or c.get('anime_id') == anime_filter)
    ]
    # ISO en UTC: orden lexicográfico = orden cronológico, sin parsear fechas.
    matching.sort(key=lambda c: c.get('created_at') or '', reverse=True)

    page = [_decorate(c, users, animes) for c in matching[:COMMENTS_PAGE]]
    return jsonify({'comments': page, 'total': len(matching)})


@bp.post('/comments')
@require_auth
def add_comment(username):
    data = request.get_json(silent=True) or {}
    text = str(data.get('text') or '').strip()
    if not text:
        return jsonify({'error': 'El comentario no puede estar vacío.'}), 400
    if len(text) > config.COMMENT_MAX:
        return jsonify({'error': f'El comentario no puede superar '
                                 f'{config.COMMENT_MAX} caracteres.'}), 400

    anime_id = str(data.get('anime_id') or '').strip() or None
    animes = load_anime()
    if anime_id and not find_anime(animes, anime_id):
        return jsonify({'error': 'Ese anime ya no existe.'}), 404

    try:
        ratelimit.hit(f'comment-min:{username}', config.COMMENTS_PER_MINUTE,
                      config.SOCIAL_WINDOW_SECONDS)
        ratelimit.hit(f'comment-day:{username}', config.COMMENTS_PER_DAY, DAY_SECONDS)
    except ratelimit.RateLimited as exc:
        return jsonify({'error': str(exc), 'retry_after': exc.retry_after}), 429

    comment = {
        'id': str(uuid.uuid4()),
        'user': username,
        'text': text,
        'anime_id': anime_id,
        'created_at': now_iso(),
    }
    comments = load_comments()
    comments.append(comment)
    save_comments(comments)

    payload = _decorate(comment, load_users(), {a.get('id'): a for a in animes})
    return jsonify({'message': 'Comentario publicado.', 'comment': payload}), 201


@bp.delete('/comments/<comment_id>')
@require_auth
def delete_comment(username, comment_id):
    comments = load_comments()
    match = next((c for c in comments if c.get('id') == comment_id), None)
    if match is None:
        return jsonify({'error': 'Ese comentario ya no existe.'}), 404
    if match.get('user') != username and not is_admin(username):
        return jsonify({'error': 'Solo su autor puede borrar este comentario.'}), 403

    comments.remove(match)
    save_comments(comments)
    return jsonify({'message': 'Comentario eliminado.', 'comment': match})
