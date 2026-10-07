"""Rutas de la lista de anime y consulta de APIs externas."""

import uuid
from urllib.parse import urlparse

from flask import Blueprint, jsonify, request

import external
from auth import require_auth
from config import (
    ANILIST_RANK_LABELS as RANK_CONTEXT_LABELS,
    MAX_RATING,
    MIN_RATING,
    QUERY_MAX,
    SYNOPSIS_MAX,
    TITLE_MAX,
    VALID_STATUSES,
)
from store import (
    ANIME_FIELDS,
    find_anime,
    is_admin,
    load_anime,
    load_users,
    normalize_anime,
    now_iso,
    save_anime,
)

bp = Blueprint('anime', __name__, url_prefix='/api')

MAX_GENRES = 12
MAX_STUDIOS = 8


def _is_safe_url(value):
    if not value:
        return True
    return urlparse(value).scheme in ('http', 'https')


def _as_text_list(value, limit, item_limit):
    if not isinstance(value, list):
        return None
    items = []
    for entry in value[:limit]:
        text = str(entry).strip()[:item_limit]
        if text and text not in items:
            items.append(text)
    return items


def _clean_payload(data):
    """Valida y normaliza los campos escribibles. Devuelve (datos, errores)."""
    cleaned = {}
    errors = []

    if 'title' in data:
        title = str(data['title']).strip()
        if not title:
            errors.append('El título no puede estar vacío.')
        elif len(title) > TITLE_MAX:
            errors.append(f'El título no puede superar {TITLE_MAX} caracteres.')
        else:
            cleaned['title'] = title

    if 'rating' in data:
        try:
            rating = int(str(data['rating']).strip())
        except (TypeError, ValueError):
            rating = None
        if rating is None or not MIN_RATING <= rating <= MAX_RATING:
            errors.append(f'La nota debe ser un número entre {MIN_RATING} y {MAX_RATING}.')
        else:
            cleaned['rating'] = rating

    if 'status' in data:
        status = str(data['status']).strip()
        if status not in VALID_STATUSES:
            errors.append('El estado debe ser Pendiente, Viendo, Completado o Abandonado.')
        else:
            cleaned['status'] = status

    if 'synopsis' in data:
        synopsis = str(data['synopsis']).strip()
        if len(synopsis) > SYNOPSIS_MAX:
            errors.append(f'La sinopsis no puede superar {SYNOPSIS_MAX} caracteres.')
        else:
            cleaned['synopsis'] = synopsis

    if 'episodes' in data:
        raw = str(data['episodes']).strip()
        if raw in ('', '?'):
            cleaned['episodes'] = '?'
        elif raw.isdigit() and int(raw) >= 0:
            cleaned['episodes'] = int(raw)
        else:
            errors.append('Los episodios deben ser un número entero o "?".')

    for field in ('title_native', 'title_english', 'cover_url', 'trailer', 'format'):
        if field in data:
            value = str(data[field] or '').strip()
            if field in ('cover_url', 'trailer') and not _is_safe_url(value):
                errors.append(f'La URL de {field} debe empezar por http o https.')
                continue
            cleaned[field] = value[:TITLE_MAX]

    if 'genres' in data:
        genres = _as_text_list(data['genres'], MAX_GENRES, 30)
        if genres is None:
            errors.append('Los géneros deben ser una lista.')
        else:
            cleaned['genres'] = genres

    if 'studios' in data:
        studios = _as_text_list(data['studios'], MAX_STUDIOS, 60)
        if studios is None:
            errors.append('Los estudios deben ser una lista.')
        else:
            cleaned['studios'] = studios

    if 'year' in data:
        raw = data['year']
        if raw in (None, ''):
            cleaned['year'] = None
        else:
            try:
                year = int(raw)
            except (TypeError, ValueError):
                year = None
            if year is None or not 1900 <= year <= 2100:
                errors.append('El año debe estar entre 1900 y 2100.')
            else:
                cleaned['year'] = year

    if 'score' in data:
        raw = data['score']
        if raw in (None, ''):
            cleaned['score'] = None
        else:
            try:
                score = int(float(raw))
            except (TypeError, ValueError):
                score = None
            if score is None or not 0 <= score <= 100:
                errors.append('La puntuación debe estar entre 0 y 100.')
            else:
                cleaned['score'] = score

    for field in ('anilist_id', 'mal_id', 'kitsu_id'):
        if field in data:
            raw = data[field]
            if raw in (None, '', 'null'):
                cleaned[field] = None
            else:
                try:
                    cleaned[field] = int(raw)
                except (TypeError, ValueError):
                    errors.append(f'El campo {field} debe ser un número entero.')

    if 'source' in data:
        source = str(data['source']).strip()
        if source not in ('manual', 'anilist', 'kitsu'):
            errors.append('La fuente debe ser manual, anilist o kitsu.')
        else:
            cleaned['source'] = source

    if 'lists' in data:
        raw = data['lists']
        if raw in (None, ''):
            cleaned['lists'] = None
        else:
            try:
                lists = int(raw)
            except (TypeError, ValueError):
                lists = None
            if lists is None or not 0 <= lists <= 50_000_000:
                errors.append('El número de listas debe ser un entero razonable.')
            else:
                cleaned['lists'] = lists

    # Las insignias de ranking llegan desde el cliente (venían en la ficha de
    # búsqueda), así que se revalidan aquí en vez de copiarse tal cual. Solo se
    # aceptan los dos contextos conocidos de AniList.
    if 'rankings' in data:
        raw = data['rankings']
        if not isinstance(raw, list):
            errors.append('Las posiciones del ranking no tienen el formato correcto.')
            cleaned['rankings'] = []
        else:
            valid = []
            for entry in raw[:4]:
                if not isinstance(entry, dict):
                    continue
                context = str(entry.get('context') or '').strip().lower()
                label = str(entry.get('label') or '').strip()
                try:
                    rank = int(entry.get('rank'))
                except (TypeError, ValueError):
                    continue
                if context not in RANK_CONTEXT_LABELS or not 1 <= rank <= 1_000_000:
                    continue
                valid.append({
                    'context': context,
                    'label': label[:60] or RANK_CONTEXT_LABELS[context],
                    'rank': rank,
                })
            cleaned['rankings'] = valid[:2]

    return cleaned, errors


def _load_owned(anime_id, username):
    """Devuelve (anime, animes, error). El error ya viene con su código HTTP.

    El admin pasa la comprobación de propiedad: puede ver, editar y borrar
    cualquier lista. Es la única puerta del CRUD, así que no hace falta
    replicar el rol en cada ruta.
    """
    animes = load_anime()
    anime = find_anime(animes, anime_id)
    if not anime:
        return None, None, (jsonify({'error': 'Ese anime no existe.'}), 404)
    if anime.get('user') != username and not is_admin(username):
        return None, None, (jsonify({'error': 'Ese anime no está en tu lista.'}), 403)
    return anime, animes, None


@bp.get('/anime')
@require_auth
def list_anime(username):
    """Devuelve la lista del usuario del token o la de `?user=` (solo lectura).

    Cualquier usuario autenticado puede mirar la lista de cualquier otro: la app
    es para un grupo cerrado de amigos y no hay datos privados en la ficha. Las
    escrituras siguen pasando por `_load_owned`, que es donde está la puerta.
    """
    requested = (request.args.get('user') or '').strip() or username
    if requested not in load_users():
        return jsonify({'error': 'Ese usuario no existe.'}), 404

    animes = [a for a in load_anime() if a.get('user') == requested]
    return jsonify(animes)


@bp.post('/anime')
@require_auth
def add_anime(username):
    data = request.get_json(silent=True) or {}
    cleaned, errors = _clean_payload(data)
    if errors:
        return jsonify({'error': errors[0], 'errors': errors}), 400
    if 'title' not in cleaned or 'rating' not in cleaned:
        return jsonify({'error': 'El título y la nota son obligatorios.'}), 400

    anime = normalize_anime({
        'id': str(uuid.uuid4()),
        'user': username,
        **cleaned,
        'updatedAt': now_iso(),
    })

    animes = load_anime()
    animes.append(anime)
    save_anime(animes)
    return jsonify({'message': 'Anime añadido.', 'anime': anime}), 201


@bp.get('/anime/search')
@require_auth
def search_anime(username):
    term = (request.args.get('q') or '').strip()
    if not term:
        return jsonify({'error': 'Escribe algo para buscar.'}), 400
    if len(term) > QUERY_MAX:
        return jsonify({'error': f'La búsqueda no puede superar {QUERY_MAX} caracteres.'}), 400

    try:
        page = max(1, int(request.args.get('page', 1)))
    except (TypeError, ValueError):
        page = 1

    include_adult = request.args.get('adulto') in ('1', 'true', 'True')
    autocomplete = request.args.get('autocomplete') in ('1', 'true', 'True')

    try:
        external.check_rate_limit(username)
    except external.SearchRateLimited:
        return jsonify({'error': 'Demasiadas búsquedas seguidas. Espera un minuto.'}), 429

    try:
        payload = external.search(term, page=page, include_adult=include_adult)
    except external.UpstreamError as error:
        return jsonify({'error': str(error)}), 502

    # Sin `pop`: el payload viene de la caché y no debe modificarse.
    results = payload.get('results') or []
    if autocomplete:
        results = [
            {
                'title': item['title'],
                'year': item['year'],
                'cover_url': item['cover_url'],
            }
            for item in results[:8]
        ]

    return jsonify({**payload, 'results': results})


@bp.get('/anime/<anime_id>')
@require_auth
def get_anime(username, anime_id):
    anime, _, error = _load_owned(anime_id, username)
    if error:
        return error
    return jsonify(anime)


@bp.put('/anime/<anime_id>')
@require_auth
def update_anime(username, anime_id):
    anime, animes, error = _load_owned(anime_id, username)
    if error:
        return error

    data = request.get_json(silent=True) or {}
    cleaned, errors = _clean_payload(data)
    if errors:
        return jsonify({'error': errors[0], 'errors': errors}), 400
    if not cleaned:
        return jsonify({'error': 'No hay nada que actualizar.'}), 400

    anime.update(cleaned)
    anime['updatedAt'] = now_iso()
    save_anime(animes)
    return jsonify({'message': 'Anime actualizado.', 'anime': normalize_anime(anime)})


@bp.delete('/anime/<anime_id>')
@require_auth
def delete_anime(username, anime_id):
    anime, animes, error = _load_owned(anime_id, username)
    if error:
        return error

    animes.remove(anime)
    save_anime(animes)
    return jsonify({'message': 'Anime eliminado.', 'anime': anime})


@bp.get('/anime/<anime_id>/external')
@require_auth
def refresh_from_external(username, anime_id):
    """Vuelve a pedir la ficha a AniList o Kitsu para actualizar los metadatos."""
    anime, animes, error = _load_owned(anime_id, username)
    if error:
        return error

    source, source_id = anime.get('source'), None
    if source == 'anilist':
        source_id = anime.get('anilist_id')
    elif source == 'kitsu':
        source_id = anime.get('kitsu_id')
    if not source_id:
        source = 'anilist' if anime.get('anilist_id') else 'kitsu'
        source_id = anime.get('anilist_id') or anime.get('kitsu_id')
    if not source_id:
        return jsonify({'error': 'Este anime no está enlazado con AniList ni con Kitsu.'}), 400

    try:
        record = external.detail(source, source_id)
    except external.UpstreamError as err:
        return jsonify({'error': str(err)}), 502

    for field in ('cover_url', 'synopsis', 'episodes', 'genres', 'studios', 'score',
                  'trailer', 'format', 'year', 'lists'):
        if record.get(field):
            anime[field] = record[field]
    # `rankings` se asigna siempre, incluso vacio: si el anime pierde su puesto
    # en el ranking hay que retirar las insignias, no dejar las de antes.
    anime['rankings'] = record.get('rankings') or []
    anime['source'] = record['source']
    anime['anilist_id'] = record.get('anilist_id')
    anime['kitsu_id'] = record.get('kitsu_id')
    anime['updatedAt'] = now_iso()

    save_anime(animes)
    return jsonify({'message': 'Ficha actualizada.', 'anime': normalize_anime(anime)})


@bp.get('/stats')
@require_auth
def stats(username):
    animes = [a for a in load_anime() if a.get('user') == username]

    by_status = {status: 0 for status in VALID_STATUSES}
    genre_count = {}
    rating_total = 0
    episodes_total = 0

    for anime in animes:
        by_status[anime.get('status', 'Pendiente')] = by_status.get(anime.get('status'), 0) + 1
        rating = anime.get('rating')
        if isinstance(rating, int):
            rating_total += rating
        if isinstance(anime.get('episodes'), int):
            episodes_total += anime['episodes']
        for genre in anime.get('genres') or []:
            genre_count[genre] = genre_count.get(genre, 0) + 1

    top_genres = [
        {'name': name, 'count': count}
        for name, count in sorted(genre_count.items(), key=lambda item: (-item[1], item[0]))[:5]
    ]

    return jsonify({
        'total': len(animes),
        'average_rating': round(rating_total / len(animes), 1) if animes else None,
        'total_episodes': episodes_total,
        'by_status': by_status,
        'top_genres': top_genres,
        'fields': list(ANIME_FIELDS),
    })