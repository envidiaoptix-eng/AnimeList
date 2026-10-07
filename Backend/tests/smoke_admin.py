"""Smoke de listas ajenas y de administración contra la app real de Flask.

Mismo truco que `smoke_profile.py`: `USERS_FILE` y `ANIME_FILE` se redirigen a
un temporal ANTES de importar la app, asi que los JSON reales no se tocan.

El rol de admin se prueba por las dos vias reales:
  * `role: admin` escrito a mano en el registro (como queda tras una promotion
    desde la UI).
  * `config.ADMIN_USERNAMES`, que es el conjunto que alimenta `ANIMELIST_ADMIN`;
    se muta el propio objeto para simular la variable de entorno sin tener que
    reiniciar el proceso. `store` y `routes_admin` importan esa misma lista.

    python Backend/tests/smoke_admin.py
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

_TMP = Path(tempfile.mkdtemp(prefix='animelist-admin-tests-'))
os.environ['ANIMELIST_SECRET_KEY'] = 'clave-fija-de-pruebas'
os.environ.pop('ANIMELIST_USE_FIRESTORE', None)
# Sin admins de entorno al arrancar: el primero se promueve editando el fichero,
# igual que si lo hubiera hecho la UI en una sesion anterior.
os.environ.pop('ANIMELIST_ADMIN', None)

import config  # noqa: E402

config.USERS_FILE = str(_TMP / 'users.json')
config.ANIME_FILE = str(_TMP / 'anime_list.json')

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


def promote_in_file(username):
    """Escribe `role: admin` directamente en el JSON, como haria la UI."""
    with open(config.USERS_FILE, encoding='utf-8') as f:
        users = json.load(f)
    users[username]['role'] = 'admin'
    with open(config.USERS_FILE, 'w', encoding='utf-8') as f:
        json.dump(users, f, ensure_ascii=False)


def add_anime(client, headers, titulo):
    r = client.post('/api/anime', headers=headers, json={'title': titulo, 'rating': 7})
    return r.get_json()['anime']


def main():
    app = create_app()
    c = app.test_client()

    jefe, normal, elboss = 'jefe', 'normal', 'elboss'

    print('registro')
    for usuario in (jefe, normal, elboss):
        r = c.post('/api/register', json={'username': usuario, 'password': CORTESIA[0]})
        check('registro %s' % usuario, r.status_code in (200, 201), (r.status_code, r.get_json()))
    promote_in_file(jefe)

    hj, hn, he = token(c, jefe), token(c, normal), token(c, elboss)

    print('sin token: todo el area privada cierra')
    check('GET /api/users sin token -> 401', c.get('/api/users').status_code == 401)
    check('GET /api/admin/users sin token -> 401', c.get('/api/admin/users').status_code == 401)
    check('DELETE /api/admin/users/x sin token -> 401',
          c.delete('/api/admin/users/x').status_code == 401)

    print('listas ajenas: cualquier usuario autenticado puede mirar')
    animes_jefe = [add_anime(c, hj, 'Anime del jefe'), add_anime(c, hj, 'Otro del jefe')]
    animes_normal = [add_anime(c, hn, 'Anime de normal')]

    r = c.get('/api/anime?user=%s' % jefe, headers=hn)
    check('GET /anime?user=jefe con token de normal -> 200', r.status_code == 200, r.status_code)
    check('y son los suyos', len(r.get_json()) == len(animes_jefe), len(r.get_json()))
    check('cuyo user es el dueno',
          all(a['user'] == jefe for a in r.get_json()), [a.get('user') for a in r.get_json()])
    check('GET /anime?user=inexistente -> 404',
          c.get('/api/anime?user=inexistente', headers=hn).status_code == 404)
    check('GET /anime sin ?user sigue devolviendo la lista propia',
          len(c.get('/api/anime', headers=hn).get_json()) == len(animes_normal))

    print('buscador de usuarios')
    r = c.get('/api/users?q=', headers=hn)
    check('GET /users 200', r.status_code == 200, r.status_code)
    check('no se cuela el password_hash', 'password_hash' not in r.text, r.text[:200])
    check('cuenta a jefe', any(u['username'] == jefe for u in r.get_json()['users']), r.get_json())
    check('anime_count del jefe', next(u for u in r.get_json()['users']
                                       if u['username'] == jefe)['anime_count'] == len(animes_jefe))
    r = c.get('/api/users?q=JEF', headers=hn)
    check('la busqueda no distingue mayusculas',
          [u['username'] for u in r.get_json()['users']] == [jefe], r.get_json())
    check('GET /users/jefe 200 con perfil', c.get('/api/users/%s' % jefe, headers=hn)
          .get_json()['profile']['username'] == jefe)
    check('GET /users/inexistente -> 404',
          c.get('/api/users/inexistente', headers=hn).status_code == 404)

    print('imagen de perfil de otra cuenta')
    r = c.put('/api/profile/image', headers=hj, json={
        'kind': 'avatar',
        'data': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='})
    check('jefe sube avatar', r.status_code == 200, (r.status_code, r.get_json()))
    r = c.get('/api/profile/image/avatar?user=%s' % jefe, headers=hn)
    check('normal ve el avatar del jefe -> 200', r.status_code == 200, r.status_code)
    check('y son bytes PNG', r.data[:4] == b'\x89PNG', r.data[:8])
    check('aun sin token -> 401', c.get('/api/profile/image/avatar?user=%s' % jefe).status_code == 401)
    check('imagen de nadie -> 404',
          c.get('/api/profile/image/avatar?user=%s' % normal, headers=hj).status_code == 404)

    print('propiedad: el CRUD sigue cerrado entre usuarios')
    id_jefe = animes_jefe[0]['id']
    check('normal no ve el detalle ajeno -> 403',
          c.get('/api/anime/%s' % id_jefe, headers=hn).status_code == 403)
    check('normal no edita el ajeno -> 403',
          c.put('/api/anime/%s' % id_jefe, headers=hn, json={'rating': 1}).status_code == 403)
    check('normal no borra el ajeno -> 403',
          c.delete('/api/anime/%s' % id_jefe, headers=hn).status_code == 403)

    print('rol admin: /api/me lo revela')
    check('/me de jefe lleva is_admin true',
          c.get('/api/me', headers=hj).get_json()['profile']['is_admin'] is True)
    check('/me de normal lleva is_admin false',
          c.get('/api/me', headers=hn).get_json()['profile']['is_admin'] is False)

    print('admin por role: poderes')
    r = c.get('/api/admin/users', headers=hj)
    check('jefe lista cuentas -> 200', r.status_code == 200, r.status_code)
    check('sin password_hash en el censo', 'password_hash' not in r.text, r.text[:200])
    check('aparecen las tres', {u['username'] for u in r.get_json()['users']}
          == {jefe, normal, elboss}, r.get_json())
    check('admins = 1 al empezar', r.get_json()['admins'] == 1, r.get_json())
    check('normal no entra en el censo -> 403',
          c.get('/api/admin/users', headers=hn).status_code == 403)
    check('PUT /admin role sin permisos -> 403',
          c.put('/api/admin/users/%s/role' % jefe, headers=hn, json={'role': 'user'}).status_code == 403)

    id_normal = animes_normal[0]['id']
    check('jefe lee el anime ajeno -> 200',
          c.get('/api/anime/%s' % id_normal, headers=hj).status_code == 200)
    check('jefe edita el anime ajeno -> 200',
          c.put('/api/anime/%s' % id_normal, headers=hj, json={'rating': 9}).status_code == 200)
    r = c.get('/api/anime/%s' % id_normal, headers=hj)
    check('y el cambio se guardo', r.get_json().get('rating') == 9, r.get_json())

    print('guardas del admin')
    check('no borrarse a si mismo -> 400',
          c.delete('/api/admin/users/%s' % jefe, headers=hj).status_code == 400)
    check('revocarse el rol como unico admin -> 400',
          c.put('/api/admin/users/%s/role' % jefe, headers=hj, json={'role': 'user'}).status_code == 400)
    check('rol inventado -> 400',
          c.put('/api/admin/users/%s/role' % normal, headers=hj, json={'role': 'diós'}).status_code == 400)
    check('borrar a nadie -> 404',
          c.delete('/api/admin/users/inexistente', headers=hj).status_code == 404)
    check('rol de nadie -> 404',
          c.put('/api/admin/users/inexistente/role', headers=hj, json={'role': 'admin'}).status_code == 404)
    check('contrasena de nadie -> 404',
          c.post('/api/admin/users/inexistente/password', headers=hj,
                 json={'password': 'larga123'}).status_code == 404)

    print('promover y revocar')
    r = c.put('/api/admin/users/%s/role' % normal, headers=hj, json={'role': 'admin'})
    check('jefe promueve a normal -> 200', r.status_code == 200, (r.status_code, r.get_json()))
    check('normal es admin en /me',
          c.get('/api/me', headers=hn).get_json()['profile']['is_admin'] is True)
    check('y ya entra en el censo', c.get('/api/admin/users', headers=hn).status_code == 200)
    r = c.put('/api/admin/users/%s/role' % jefe, headers=hn, json={'role': 'user'})
    check('ahora normal (admin) baja al jefe -> 200', r.status_code == 200, (r.status_code, r.get_json()))
    check('jefe ya no es admin',
          c.get('/api/me', headers=hj).get_json()['profile']['is_admin'] is False)
    check('y el censo le vuelve a cerrar -> 403',
          c.get('/api/admin/users', headers=hj).status_code == 403)

    print('admin por entorno (ANIMELIST_ADMIN)')
    config.ADMIN_USERNAMES.add(elboss)
    check('elboss entra por la lista del entorno',
          c.get('/api/admin/users', headers=he).status_code == 200)
    check('el censo cuenta 2 admins', c.get('/api/admin/users', headers=hn)
          .get_json()['admins'] == 2, c.get('/api/admin/users', headers=hn).get_json())
    r = c.put('/api/admin/users/%s/role' % elboss, headers=hn, json={'role': 'user'})
    check('no se puede bajar al admin del entorno -> 400', r.status_code == 400, (r.status_code, r.get_json()))
    config.ADMIN_USERNAMES.discard(elboss)
    check('al quitarlo del entorno pierde los poderes',
          c.get('/api/admin/users', headers=he).status_code == 403)

    print('resetear contrasena')
    check('contrasena corta -> 400',
          c.post('/api/admin/users/%s/password' % normal, headers=hn,
                 json={'password': 'abc'}).status_code == 400)
    r = c.post('/api/admin/users/%s/password' % normal, headers=hn, json={'password': 'NuevaClave9'})
    check('reset 200', r.status_code == 200, (r.status_code, r.get_json()))
    check('la vieja deja de servir',
          c.post('/api/login', json={'username': normal, 'password': CORTESIA[0]}).status_code == 401)
    check('la nueva entra', c.post('/api/login', json={'username': normal, 'password': 'NuevaClave9'})
          .status_code == 200)
    hn = token(c, normal, 'NuevaClave9')

    print('borrar una cuenta y su lista')
    r = c.post('/api/register', json={'username': 'borrable', 'password': CORTESIA[0]})
    check('registro borrable', r.status_code in (200, 201), (r.status_code, r.get_json()))
    hb = token(c, 'borrable')
    add_anime(c, hb, 'De un borrable')
    r = c.delete('/api/admin/users/borrable', headers=hn)
    check('admin borra la cuenta -> 200', r.status_code == 200, (r.status_code, r.get_json()))
    check('y sus animes tambien', r.get_json().get('animes_deleted') == 1, r.get_json())
    check('la cuenta ya no aparece',
          c.get('/api/users/borrable', headers=hn).status_code == 404)
    check('ni su lista',
          c.get('/api/anime?user=borrable', headers=hn).status_code == 404)
    check('y su token ya no encuentra la cuenta',
          c.get('/api/anime', headers=hb).status_code == 404)

    print('los JSON reales no se han tocado')
    reales = Path(BACKEND) / 'users.json'
    check('users.json del repo sin usuarios de prueba',
          not any(u in reales.read_text(encoding='utf-8') for u in ('jefe', 'borrable')))


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
