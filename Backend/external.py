"""Clientes de APIs públicas de anime: AniList (principal) y Kitsu (respaldo).

Ambas son keyless. AniList va por GraphQL y Kitsu por JSON:API.
Se normalizan al mismo formato para que el frontend no distinga la fuente.
"""

import copy
import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from threading import Lock

from markupsafe import Markup

from config import (
    ANILIST_ENDPOINT,
    ANILIST_RANK_LABELS,
    ANILIST_RANK_ORDER,
    CACHE_MAX_ENTRIES,
    CACHE_TTL_SECONDS,
    HTTP_TIMEOUT,
    KITSU_ENDPOINT,
    RETRY_ATTEMPTS,
    RETRY_BACKOFF_SECONDS,
    SEARCH_PAGE_SIZE,
    SEARCHES_PER_MINUTE,
    SYNOPSIS_MAX,
    USER_AGENT,
)

SEARCH_FIELDS = """
    id
    siteUrl
    format
    status
    episodes
    seasonYear
    averageScore
    popularity
    rankings { rank allTime context }
    genres
    description(asHtml: false)
    title { romaji native english }
    coverImage { extraLarge large color }
    studios(isMain: true) { nodes { name } }
"""

SEARCH_QUERY = f"""
query BuscarAnime($search: String, $page: Int, $perPage: Int, $isAdult: Boolean) {{
  Page(page: $page, perPage: $perPage) {{
    pageInfo {{ total currentPage lastPage hasNextPage }}
    media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: $isAdult) {{
      {SEARCH_FIELDS}
    }}
  }}
}}
"""

DETAIL_QUERY = """
query DetalleAnime($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    siteUrl
    format
    status
    episodes
    seasonYear
    season
    averageScore
    popularity
    rankings { rank allTime context }
    genres
    countryOfOrigin
    description(asHtml: false)
    title { romaji native english }
    coverImage { extraLarge large color }
    studios(isMain: true) { nodes { name } }
    trailer { id site }
  }
}
"""


class UpstreamError(Exception):
    """Fallo al hablar con una API externa."""


class SearchRateLimited(Exception):
    """El usuario superó el máximo de búsquedas por minuto."""


ANILIST_STATUS = {
    'FINISHED': 'Completado',
    'RELEASING': 'Viendo',
    'NOT_YET_RELEASED': 'Pendiente',
    'HIATUS': 'Pendiente',
    'CANCELLED': 'Abandonado',
}

KITSU_STATUS = {
    'current': 'Viendo',
    'completed': 'Completado',
    'planned': 'Pendiente',
    'on_hold': 'Pendiente',
    'cancelled': 'Abandonado',
}

KITSU_FORMAT = {
    'TV': 'TV',
    'Movie': 'Movie',
    'OVA': 'OVA',
    'ONA': 'ONA',
    'Special': 'Special',
    'Music': 'Music',
}


# --------------------------------------------------------------------------
# Caché en memoria y límite de peticiones
# --------------------------------------------------------------------------

_cache = {}
_cache_lock = Lock()
_search_log = {}


def _cache_get(key):
    """Devuelve una COPIA de lo cacheado.

    Quien llama no debe poder mutar lo guardado: si el consumidor hace `pop()` o
    cambia una clave, la siguiente lectura devolvería un dict mutilado.
    """
    with _cache_lock:
        entry = _cache.get(key)
        if not entry:
            return None
        expires_at, value = entry
        if expires_at < time.time():
            _cache.pop(key, None)
            return None
        return copy.deepcopy(value)


def _cache_set(key, value):
    with _cache_lock:
        if len(_cache) >= CACHE_MAX_ENTRIES:
            oldest = min(_cache.items(), key=lambda item: item[1][0])[0]
            _cache.pop(oldest, None)
        _cache[key] = (time.time() + CACHE_TTL_SECONDS, value)


def check_rate_limit(username):
    """Protege la cuota de AniList limitando búsquedas por usuario."""
    now = time.time()
    with _cache_lock:
        log = _search_logs_for(username)
        while log and now - log[0] > 60:
            log.popleft()
        if len(log) >= SEARCHES_PER_MINUTE:
            raise SearchRateLimited()
        log.append(now)


def _search_logs_for(username):
    log = _search_log.get(username)
    if log is None:
        log = deque()
        _search_log[username] = log
    return log


# --------------------------------------------------------------------------
# Utilidades
# --------------------------------------------------------------------------

def clean_text(value, limit=None):
    """Quita etiquetas HTML y colapsa espacios (las sinopsis traen HTML)."""
    if not value:
        return ''
    text = Markup(str(value)).striptags()
    text = ' '.join(text.split())
    if limit and len(text) > limit:
        text = text[:limit].rstrip() + '…'
    return text


def _open(request):
    """Abre una petición reintentando ante fallos transitorios.

    Cloudflare delante de AniList devuelve 403 de forma intermitente y un 429
    indica cuota agotada: ambos se reintentan con espera creciente antes de
    llevar el fallo al respaldo. Un 4xx definitivo no se reintenta.
    """
    last_error = None
    for attempt in range(RETRY_ATTEMPTS):
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
                return response.read().decode('utf-8')
        except urllib.error.HTTPError as exc:
            last_error = UpstreamError(f'HTTP {exc.code}')
            if exc.code < 500 and exc.code != 429:
                raise last_error from exc
        except (urllib.error.URLError, socket.timeout, TimeoutError, OSError) as exc:
            last_error = UpstreamError(f'error de red: {exc}')
        if attempt < RETRY_ATTEMPTS - 1:
            time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
    raise last_error


def _http_get(url, accept='application/json'):
    request = urllib.request.Request(
        url,
        headers={'User-Agent': USER_AGENT, 'Accept': accept},
        method='GET',
    )
    return _open(request)


def _post_json(url, payload):
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        method='POST',
    )
    raw = _open(request)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise UpstreamError('respuesta no válida del proveedor') from exc


def _pick_title(titles):
    """Elige el mejor título disponible según preferencia de idioma."""
    for key in ('english', 'romaji', 'native'):
        value = titles.get(key)
        if value:
            return value
    return 'Sin título'


def _clean_genres(genres):
    if not isinstance(genres, list):
        return []
    return [clean_text(genre, 30) for genre in genres if genre]


# AniList devuelve cuatro entradas en `rankings`: dos de "la historia"
# (`allTime: true`) y dos del año/temporada en curso (`allTime: false`).
# El `context` llega como literal en ingles y es justo la etiqueta que se busca.
# Solo interesan las dos de toda la historia, que llevan numeracion estable.
# Las etiquetas estan en config.ANILIST_RANK_LABELS para no duplicarlas aqui.


def _clean_rankings(rankings):
    """Traduce `rankings` de AniList a las dos insignias de toda la historia."""
    if not isinstance(rankings, list):
        return []

    found = {}
    for entry in rankings:
        if not isinstance(entry, dict) or not entry.get('allTime'):
            continue
        context = str(entry.get('context') or '').strip().lower()
        label = ANILIST_RANK_LABELS.get(context)
        rank = entry.get('rank')
        if not label or not isinstance(rank, int) or rank < 1:
            continue
        # Un allTime por contexto: el primero que llegue es el bueno.
        found.setdefault(context, {'context': context, 'label': label, 'rank': rank})

    return [found[key] for key in ANILIST_RANK_ORDER if key in found]


# --------------------------------------------------------------------------
# AniList
# --------------------------------------------------------------------------

def _normalize_anilist(media, detail=False):
    titles = media.get('title') or {}
    cover = media.get('coverImage') or {}
    studios = ((media.get('studios') or {}).get('nodes')) or []
    status_raw = media.get('status')

    record = {
        'source': 'anilist',
        'source_id': media.get('id'),
        'title': _pick_title(titles),
        'title_native': clean_text(titles.get('native'), 200),
        'title_english': clean_text(titles.get('english'), 200),
        'cover_url': cover.get('extraLarge') or cover.get('large') or '',
        'cover_color': cover.get('color') or '',
        'synopsis': clean_text(media.get('description'), SYNOPSIS_MAX),
        'episodes': media.get('episodes') or '?',
        'status': ANILIST_STATUS.get(status_raw, 'Pendiente'),
        'status_raw': status_raw or '',
        'genres': _clean_genres(media.get('genres')),
        'year': media.get('seasonYear'),
        'format': media.get('format') or 'Unknown',
        'studios': [s['name'] for s in studios if s.get('name')],
        'score': media.get('averageScore'),
        'rankings': _clean_rankings(media.get('rankings')),
        'lists': media.get('popularity') if isinstance(media.get('popularity'), int) else None,
        'url': media.get('siteUrl') or f"https://anilist.co/anime/{media.get('id')}",
        'trailer': '',
        'anilist_id': media.get('id'),
        'kitsu_id': None,
        'mal_id': None,
    }

    if detail:
        trailer = media.get('trailer') or {}
        if trailer.get('site') == 'youtube' and trailer.get('id'):
            record['trailer'] = f"https://www.youtube.com/watch?v={trailer['id']}"
        if media.get('season'):
            record['season'] = media['season'].capitalize()

    return record


def _anilist_request(query, variables):
    payload = _post_json(ANILIST_ENDPOINT, {'query': query, 'variables': variables})
    if payload.get('errors'):
        raise UpstreamError(str(payload['errors'][0].get('message', 'error GraphQL')))
    return payload.get('data') or {}


def _search_anilist(term, page, per_page, include_adult):
    data = _anilist_request(
        SEARCH_QUERY,
        {'search': term, 'page': page, 'perPage': per_page, 'isAdult': include_adult},
    )
    block = data.get('Page') or {}
    page_info = block.get('pageInfo') or {}
    results = [_normalize_anilist(item) for item in (block.get('media') or [])]
    return {
        'results': results,
        'total': page_info.get('total', 0) or 0,
        'page': page_info.get('currentPage', page) or page,
        'per_page': per_page,
        'has_next': bool(page_info.get('hasNextPage')),
    }


def _detail_anilist(anilist_id):
    data = _anilist_request(DETAIL_QUERY, {'id': int(anilist_id)})
    media = data.get('Media')
    if not media:
        raise UpstreamError('AniList no devolvió ese anime')
    return _normalize_anilist(media, detail=True)


# --------------------------------------------------------------------------
# Kitsu (respaldo)
# --------------------------------------------------------------------------

def _kitsu_score(attributes):
    """Kitsu no expone averageScore por defecto, pero sí el histograma de
    votaciones. Se calcula la media ponderada sobre 20 y se escala a 0-100
    para que sea comparable con el averageScore de AniList."""
    frequencies = attributes.get('ratingFrequencies') or {}
    try:
        pairs = [(int(key), int(value)) for key, value in frequencies.items()]
    except (TypeError, ValueError):
        return None
    total = sum(value for _, value in pairs)
    if not total:
        return None
    weighted = sum(key * value for key, value in pairs)
    return round(weighted / total / 20 * 100)


def _normalize_kitsu(item):
    attributes = item.get('attributes') or {}
    titles = attributes.get('titles') or {}
    poster = attributes.get('posterImage') or {}
    start_date = attributes.get('startDate') or ''

    score = _kitsu_score(attributes)

    slug = attributes.get('slug') or item.get('id')

    return {
        'source': 'kitsu',
        'source_id': int(item['id']) if str(item.get('id', '')).isdigit() else None,
        'title': clean_text(attributes.get('canonicalTitle'), 200) or 'Sin título',
        'title_native': clean_text(titles.get('ja_jp') or titles.get('ja'), 200),
        'title_english': clean_text(titles.get('en') or titles.get('en_us'), 200),
        'cover_url': poster.get('large') or poster.get('medium') or poster.get('original') or '',
        'cover_color': '',
        'synopsis': clean_text(attributes.get('synopsis'), SYNOPSIS_MAX),
        'episodes': attributes.get('episodeCount') or '?',
        'status': KITSU_STATUS.get(attributes.get('status'), 'Pendiente'),
        'status_raw': attributes.get('status') or '',
        'genres': [],
        'year': int(start_date[:4]) if start_date[:4].isdigit() else None,
        'format': KITSU_FORMAT.get(attributes.get('subtype') or '', attributes.get('show') or 'Unknown'),
        'studios': [],
        'score': score,
        # Kitsu no publica posiciones de ranking, solo `userCount`. Se expone como
        # `lists` para que la interfaz pueda decir "N en listas" en vez de
        # inventarse una posicion que no existe.
        'lists': int(attributes['userCount']) if str(attributes.get('userCount', '')).isdigit() else None,
        'rankings': [],
        'url': f'https://kitsu.io/anime/{slug}',
        'trailer': clean_text(attributes.get('trailerUrl'), 300),
        'anilist_id': None,
        'kitsu_id': int(item['id']) if str(item.get('id', '')).isdigit() else None,
        'mal_id': None,
    }


def _kitsu_search(term, page, per_page):
    offset = (page - 1) * per_page
    # Kitsu no acepta `sort=averageScore` para anime (devuelve 400), así que se
    # deja el orden de relevancia que ya aplica filter[text].
    query = urllib.parse.urlencode({
        'filter[text]': term,
        'page[limit]': per_page,
        'page[offset]': offset,
    })
    raw = _http_get(f'{KITSU_ENDPOINT}/anime?{query}', accept='application/vnd.api+json')
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise UpstreamError('respuesta no válida de Kitsu') from exc
    results = [_normalize_kitsu(item) for item in (payload.get('data') or [])]
    total = ((payload.get('meta') or {}).get('count')) or len(results)
    return {
        'results': results,
        'total': total,
        'page': page,
        'per_page': per_page,
        'has_next': len(results) == per_page,
    }


# --------------------------------------------------------------------------
# API pública del módulo
# --------------------------------------------------------------------------

def search(term, page=1, include_adult=False):
    """Busca en AniList y, si falla, cae automáticamente a Kitsu.

    Un resultado vacío NO dispara el respaldo: cero resultados es una respuesta
    legítima de AniList, no un fallo.
    """
    term = (term or '').strip()
    page = max(1, int(page or 1))
    adult_flag = 'adult' if include_adult else 'sfw'
    cache_key = f'search:{term.lower()}:{page}:{adult_flag}'

    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    per_page = SEARCH_PAGE_SIZE
    try:
        payload = _search_anilist(term, page, per_page, include_adult)
        payload['source'] = 'anilist'
    except UpstreamError as error:
        try:
            payload = _kitsu_search(term, page, per_page)
            payload['source'] = 'kitsu'
            payload['fallback_reason'] = str(error)
        except UpstreamError as fallback_error:
            raise UpstreamError(
                'No se pudo contactar con AniList ni con Kitsu. Revisa tu conexión.'
            ) from fallback_error

    _cache_set(cache_key, payload)
    return payload


def detail(source, source_id):
    """Ficha completa de un anime externo, con la misma normalización."""
    cache_key = f'detail:{source}:{source_id}'
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    if source == 'kitsu':
        raw = _http_get(
            f'{KITSU_ENDPOINT}/anime/{urllib.parse.quote(str(source_id))}',
            accept='application/vnd.api+json',
        )
        record = _normalize_kitsu((json.loads(raw).get('data')) or {})
    else:
        record = _detail_anilist(source_id)

    _cache_set(cache_key, record)
    return record