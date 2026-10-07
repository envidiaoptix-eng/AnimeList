"""Smoke de amigos y comentarios contra la app real de Flask.

Mismo truco que `smoke_admin.py`: `USERS_FILE`, `ANIME_FILE`, `FRIENDS_FILE`
y `COMMENTS_FILE` se redirigen a un temporal ANTES de importar la app, asi
los JSON reales del repo no se tocan.

Cubre el ciclo completo de amistad (solicitar, aceptar, rechazar, eliminar),
el muro de comentarios con su `target`, los limites por usuario (429) y las
cascadas de borrado de anime y de cuenta.

    python Backend/tests/smoke_social.py
"""

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(Path(__file__).resolve().parent))

_TMP = Path(tempfile.mkdtemp(prefix='animelist-social-tests-'))
os.environ['ANIMELIST_SECRET_KEY'] = 'clave-fija-de-pruebas'
os.environ.pop('ANIMELIST_USE_FIRESTORE', None)
os.environ.pop('ANIMELIST_ADMIN', None)

import config  # noqa: E402

config.USERS_FILE = str(_TMP / 'users.json')
config.ANIME_FILE = str(_TMP / 'anime_list.json')
config.FRIENDS_FILE = str(_TMP / 'friends.json')
config.COMMENTS_FILE = str(_TMP / 'comments.json')

import ratelimit  # noqa: E402
from app import create_app  # noqa: E402

FALLOS = []
CORTESIA = ('Contrasena1',)


def check(nombre, ok, extra=''):
    print(('  OK    ' if ok else '  FALLO ') + nombre + (('  -> ' + str(extra)[:220]) if not ok else ''))
    if not ok:
        FALLOS.append(nombre)


def token(client, usuario, password=CORTESIA[0]):
    r = client.post('/api/login', json={'username': usuario, 'password': password})
    return {'Authorization': 'Bearer ' + r.get_json()['token']}


def main():
    app = create_app()
    c = app.test_client()

    ana, bruno = 'ana', 'bruno'

    print('registro')
    for usuario in (ana, bruno):
        r = c.post('/api/register', json={'username': usuario, 'password': CORTESIA[0]})
        check('registro %s' % usuario, r.status_code in (200, 201), (r.status_code, r.get_json()))
    ha, hb = token(c, ana), token(c, bruno)

    print('sin token: toda la area social cierra')
    for metodo, ruta in (('get', '/api/friends'), ('post', '/api/friends/request'),
                         ('post', '/api/friends/accept'), ('post', '/api/friends/reject'),
                         ('delete', '/api/friends/bruno'), ('get', '/api/comments'),
                         ('post', '/api/comments'), ('delete', '/api/comments/x')):
        check('%s %s sin token -> 401' % (metodo.upper(), ruta),
              getattr(c, metodo)(ruta).status_code == 401)

    print('solicitudes de amistad')
    r = c.get('/api/friends', headers=ha)
    check('GET /friends vacio al empezar', r.status_code == 200
          and r.get_json() == {'friends': [], 'incoming': [], 'outgoing': []}, r.get_json())

    check('enviarse una a uno mismo -> 400',
          c.post('/api/friends/request', headers=ha, json={'username': ana}).status_code == 400)
    check('solicitud a inexistente -> 404',
          c.post('/api/friends/request', headers=ha, json={'username': 'nadie'}).status_code == 404)
    check('solicitud vacia -> 400',
          c.post('/api/friends/request', headers=ha, json={'username': '  '}).status_code == 400)

    r = c.post('/api/friends/request', headers=ha, json={'username': bruno})
    check('ana solicita a bruno -> 201', r.status_code == 201, (r.status_code, r.get_json()))
    check('y el estado queda outgoing', r.get_json().get('state') == 'outgoing', r.get_json())

    check('duplicada -> 409',
          c.post('/api/friends/request', headers=ha, json={'username': bruno}).status_code == 409)
    # En sentido inverso tampoco se acepta: hay que aceptar la que ya existe.
    check('bruno a ana (ya hay solicitud) -> 409',
          c.post('/api/friends/request', headers=hb, json={'username': ana}).status_code == 409)

    r = c.get('/api/friends', headers=hb)
    check('bruno ve la solicitud entrante',
          len(r.get_json()['incoming']) == 1 and r.get_json()['incoming'][0]['username'] == ana,
          r.get_json())
    r = c.get('/api/friends', headers=ha)
    check('ana ve la solicitud saliente',
          len(r.get_json()['outgoing']) == 1 and r.get_json()['outgoing'][0]['username'] == bruno,
          r.get_json())

    print('aceptar, eliminar y rechazar')
    check('aceptar de nadie -> 404',
          c.post('/api/friends/accept', headers=hb, json={'username': 'nadie'}).status_code == 404)
    r = c.post('/api/friends/accept', headers=hb, json={'username': ana})
    check('bruno acepta -> 200', r.status_code == 200, (r.status_code, r.get_json()))
    check('y el estado queda friend', r.get_json().get('state') == 'friend', r.get_json())

    r = c.get('/api/friends', headers=ha)
    check('ana ya tiene a bruno como amigo',
          [f['username'] for f in r.get_json()['friends']] == [bruno], r.get_json())
    check('sin solicitudes pendientes',
          not r.get_json()['incoming'] and not r.get_json()['outgoing'], r.get_json())

    # La amistad se guarda una sola vez: el par no se duplica al revés.
    import store
    social = store.load_friends()
    check('el par de amistad aparece una sola vez',
          sum(1 for f in social['friendships']
              if {f['user'], f['friend']} == {ana, bruno}) == 1, social)

    check('eliminar a nadie -> 404',
          c.delete('/api/friends/nadie', headers=ha).status_code == 404)
    r = c.delete('/api/friends/%s' % bruno, headers=ha)
    check('ana elimina a bruno -> 200', r.status_code == 200, (r.status_code, r.get_json()))
    check('y el estado vuelve a none', r.get_json().get('state') == 'none', r.get_json())
    check('eliminar otra vez -> 404',
          c.delete('/api/friends/%s' % bruno, headers=ha).status_code == 404)

    # Rechazar retira una solicitud en cualquier direccion.
    c.post('/api/friends/request', headers=hb, json={'username': ana})
    check('bruno retira la suya -> 200',
          c.post('/api/friends/reject', headers=hb, json={'username': ana}).status_code == 200)
    check('rechazar cuando no hay solicitud -> 404',
          c.post('/api/friends/reject', headers=hb, json={'username': ana}).status_code == 404)

    print('limite de solicitudes por hora')
    ratelimit.reset()
    original = config.FRIEND_REQUESTS_PER_HOUR
    config.FRIEND_REQUESTS_PER_HOUR = 2
    try:
        c.post('/api/friends/request', headers=ha, json={'username': bruno})
        c.post('/api/friends/reject', headers=ha, json={'username': bruno})
        c.post('/api/friends/request', headers=ha, json={'username': bruno})
        c.post('/api/friends/reject', headers=ha, json={'username': bruno})
        r = c.post('/api/friends/request', headers=ha, json={'username': bruno})
        check('la tercera solicitud en la hora -> 429', r.status_code == 429,
              (r.status_code, r.get_json()))
        check('el 429 trae retry_after', 'retry_after' in r.get_json(), r.get_json())
    finally:
        config.FRIEND_REQUESTS_PER_HOUR = original
        ratelimit.reset()
    # Limpieza para que el muro empiece sin amistades.
    c.post('/api/friends/reject', headers=ha, json={'username': bruno})

    print('comentarios: validacion')
    check('comentario vacio -> 400',
          c.post('/api/comments', headers=ha, json={'text': '   '}).status_code == 400)
    check('texto sobre el tope -> 400',
          c.post('/api/comments', headers=ha, json={'text': 'x' * (config.COMMENT_MAX + 1)})
          .status_code == 400)
    check('target inexistente -> 404',
          c.post('/api/comments', headers=ha, json={'text': 'hola', 'target': 'nadie'})
          .status_code == 404)
    check('target propio -> 400',
          c.post('/api/comments', headers=ha, json={'text': 'hola', 'target': ana})
          .status_code == 400)
    check('anime inexistente -> 404',
          c.post('/api/comments', headers=ha, json={'text': 'hola', 'anime_id': 'nope'})
          .status_code == 404)

    print('comentarios: publicar y leer el muro')
    r = c.post('/api/comments', headers=ha, json={'text': 'Buena lista!', 'target': bruno})
    check('ana comenta la lista de bruno -> 201', r.status_code == 201,
          (r.status_code, r.get_json()))
    primero = r.get_json()['comment']
    check('lleva el target y el autor', primero.get('target') == bruno
          and primero.get('user') == ana, primero)

    r = c.post('/api/comments', headers=hb, json={'text': 'Gracias :)'})
    check('comentario global sin target -> 201', r.status_code == 201, r.status_code)
    segundo = r.get_json()['comment']

    r = c.get('/api/comments?target=%s' % bruno, headers=ha)
    check('el muro de bruno solo ve lo suyo',
          [c_['id'] for c_ in r.get_json()['comments']] == [primero['id']], r.get_json())
    check('y el total cuadra', r.get_json()['total'] == 1, r.get_json())
    r = c.get('/api/comments?target=%s' % ana, headers=hb)
    check('el muro de ana esta vacio', r.get_json()['comments'] == [], r.get_json())
    r = c.get('/api/comments', headers=ha)
    check('sin filtro ve los dos', r.get_json()['total'] == 2, r.get_json())
    check('target de inexistente -> 404',
          c.get('/api/comments?target=nadie', headers=ha).status_code == 404)
    check('el listado trae el titulo del autor', r.get_json()['comments'][0]
          .get('display_name') == 'bruno', r.get_json()['comments'][0])

    print('comentarios: permisos de borrado')
    check('borrar el ajeno -> 403',
          c.delete('/api/comments/%s' % segundo['id'], headers=ha).status_code == 403)
    check('borrar uno que no existe -> 404',
          c.delete('/api/comments/nope', headers=ha).status_code == 404)
    r = c.delete('/api/comments/%s' % primero['id'], headers=hb)
    check('bruno no puede borrar el comentario de ana -> 403', r.status_code == 403,
          r.status_code)
    r = c.delete('/api/comments/%s' % primero['id'], headers=ha)
    check('ana borra el suyo -> 200', r.status_code == 200, (r.status_code, r.get_json()))

    print('limite de comentarios')
    ratelimit.reset()
    original_min = config.COMMENTS_PER_MINUTE
    config.COMMENTS_PER_MINUTE = 1
    try:
        c.post('/api/comments', headers=ha, json={'text': 'uno', 'target': bruno})
        r = c.post('/api/comments', headers=ha, json={'text': 'dos', 'target': bruno})
        check('el segundo comentario en el minuto -> 429', r.status_code == 429,
              (r.status_code, r.get_json()))
    finally:
        config.COMMENTS_PER_MINUTE = original_min
        ratelimit.reset()

    print('cascadas')
    # Amistad de nuevo, para ver que el borrado de cuenta la purga.
    c.post('/api/friends/request', headers=ha, json={'username': bruno})
    c.post('/api/friends/accept', headers=hb, json={'username': ana})

    r = c.post('/api/anime', headers=hb, json={'title': 'Anime de bruno', 'rating': 8})
    anime_bruno = r.get_json()['anime']
    c.post('/api/comments', headers=ha,
           json={'text': 'Sobre un anime', 'target': bruno, 'anime_id': anime_bruno['id']})

    # Promocion a ana para poder borrar la cuenta de bruno desde el admin.
    with open(config.USERS_FILE, encoding='utf-8') as f:
        users = json.load(f)
    users[ana]['role'] = 'admin'
    with open(config.USERS_FILE, 'w', encoding='utf-8') as f:
        json.dump(users, f, ensure_ascii=False)
    ha = token(c, ana)

    r = c.delete('/api/anime/%s' % anime_bruno['id'], headers=hb)
    check('bruno borra su anime -> 200', r.status_code == 200, (r.status_code, r.get_json()))
    check('y se lleva sus comentarios', r.get_json().get('comments_deleted') == 1, r.get_json())
    # En el muro sigue «uno» (del test de limites): solo se fue el del anime.
    check('el muro de bruno pierde solo el del anime',
          c.get('/api/comments?target=%s' % bruno, headers=ha).get_json()['total'] == 1,
          c.get('/api/comments?target=%s' % bruno, headers=ha).get_json())

    c.post('/api/comments', headers=ha, json={'text': 'Comment hacia bruno', 'target': bruno})
    r = c.delete('/api/admin/users/%s' % bruno, headers=ha)
    check('ana borra la cuenta de bruno -> 200', r.status_code == 200,
          (r.status_code, r.get_json()))
    check('purga amistades', r.get_json().get('friendships_deleted') == 1, r.get_json())
    check('purga solicitudes pendientes', r.get_json().get('requests_deleted') == 0, r.get_json())
    # Tres: el global que escribio bruno y los dos apuntados a su muro
    # («uno» del test de limites y «Comment hacia bruno»).
    check('purga comentarios (los suyos y los suyos como target)',
          r.get_json().get('comments_deleted') == 3, r.get_json())
    check('la lista de ana ya no tiene a bruno',
          all(f['username'] != bruno
              for f in c.get('/api/friends', headers=ha).get_json()['friends']))

    print('los JSON reales no se han tocado')
    reales = Path(BACKEND) / 'users.json'
    # La clave exacta entre comillas: «ana» suelto aparece como substring de
    # otros usuarios del fichero real.
    texto = reales.read_text(encoding='utf-8')
    check('users.json del repo sin usuarios de prueba',
          '"ana"' not in texto and '"bruno"' not in texto)


if __name__ == '__main__':
    try:
        main()
    finally:
        shutil.rmtree(_TMP, ignore_errors=True)
    print()
    if FALLOS:
        print('FALLOS (%d): %s' % (len(FALLOS), '; '.join(FALLOS)))
        sys.exit(1)
    print('TODO CORRECTO')
