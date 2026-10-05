"""Smoke del perfil (imagenes y URLs) contra la app real de Flask.

Corre contra un almacenamiento temporal: los `USERS_FILE` y `ANIME_FILE` de
`config` se redirigen a un directorio de usar y tirar ANTES de importar la app,
así que `users.json` y `anime_list.json` de verdad no se tocan. Todo lo que se
escribe va a un tempfile que se borra al salir.

    python Backend/tests/smoke_profile.py
"""

import base64
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Importar `config` dispara la creacion de `secret.key`, asi que se ahi el
# entorno se prepara con un temporal que se limpia al terminar.
_TMP = Path(tempfile.mkdtemp(prefix='animelist-tests-'))
_SECRET = _TMP / 'secret.key'
_SECRET.write_text('clave-fija-de-pruebas', encoding='utf-8')
os.environ['ANIMELIST_SECRET_KEY'] = 'clave-fija-de-pruebas'
os.environ.pop('ANIMELIST_USE_FIRESTORE', None)

import config  # noqa: E402

config.USERS_FILE = str(_TMP / 'users.json')
config.ANIME_FILE = str(_TMP / 'anime_list.json')
config.SECRET_KEY_FILE = str(_SECRET)

from app import create_app  # noqa: E402

FALLOS = []

# JPEG minimo valido (magic bytes FF D8 FF E0 + cola). Al backend solo le
# importa que los magic bytes sean de JPEG o PNG.
JPEG_B64 = (
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy'
    'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAgACADASIA'
    'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA'
    'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3'
    'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm'
    'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEB'
    'AAA/APn+iiiv/9k='
)
PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

CORTESIA = ('Contrasena1',)


def check(nombre, ok, extra=''):
    print(('  OK    ' if ok else '  FALLO ') + nombre + (('  -> ' + str(extra)[:220]) if not ok else ''))
    if not ok:
        FALLOS.append(nombre)


def token(client, usuario):
    r = client.post('/api/login', json={'username': usuario, 'password': CORTESIA[0]})
    return {'Authorization': 'Bearer ' + r.get_json()['token']}


def perfil(client, headers):
    """`/api/me` envuelve el perfil en `profile`, no lo devuelve plano."""
    return client.get('/api/me', headers=headers).get_json()['profile']


def main():
    app = create_app()
    c = app.test_client()

    # Nombres fijos: el almacenamiento es temporal, asi que no hay colisiones
    # entre ejecuciones ni con los usuarios reales del repo. `USERNAME_MIN` es 3,
    # asi que ninguno puede ser mas corto.
    yo, otro = 'yosoy', 'otro'

    print('registro y perfil en blanco')
    for usuario in (yo, otro):
        r = c.post('/api/register', json={'username': usuario, 'password': CORTESIA[0],
                                          'display_name': 'Prueba'})
        check('registro %s' % usuario, r.status_code in (200, 201), (r.status_code, r.get_json()))
    h, h2 = token(c, yo), token(c, otro)

    me = perfil(c, h)
    check('has_background false al empezar', me.get('has_background') is False, me)
    check('background_url vacio al empezar', me.get('background_url') == '', me)
    check('el perfil no lleva base64', 'background_blob' not in json.dumps(me), list(me))

    print('auth: sin token')
    check('GET /api/me sin token -> 401', c.get('/api/me').status_code == 401)
    check('GET /api/anime sin token -> 401', c.get('/api/anime').status_code == 401)
    check('GET /api/profile/image/avatar sin token -> 401',
          c.get('/api/profile/image/avatar').status_code == 401)
    check('GET /api/health sin token -> 200', c.get('/api/health').status_code == 200)

    print('subir una imagen como fichero (PUT /profile/image con kind en el cuerpo)')
    for kind in ('avatar', 'banner', 'background'):
        r = c.put('/api/profile/image', headers=h, json={'kind': kind, 'data': JPEG_B64})
        check('PUT /profile/image %s 200' % kind, r.status_code == 200, (r.status_code, r.get_json()))
        me = perfil(c, h)
        check('has_%s true tras subir' % kind, me.get('has_%s' % kind) is True, me)
        check('el perfil sigue sin base64 (%s)' % kind,
              '%s_blob' % kind not in json.dumps(me), list(me))

    print('recuperar la imagen con token')
    r = c.get('/api/profile/image/background', headers=h)
    check('GET /profile/image/background 200', r.status_code == 200, r.status_code)
    check('devuelve bytes JPEG', r.data[:2] == b'\xff\xd8', r.data[:8])
    check('content-type image/jpeg', r.headers.get('Content-Type', '').startswith('image/jpeg'),
          r.headers.get('Content-Type'))
    check('usuario sin imagen -> 404', c.get('/api/profile/image/background', headers=h2).status_code == 404)
    check('kind inventado -> 404', c.get('/api/profile/image/casco', headers=h).status_code == 404)

    r = c.put('/api/profile/image', headers=h, json={'kind': 'avatar', 'data': PNG_B64})
    check('PNG tambien se acepta', r.status_code == 200, (r.status_code, r.get_json()))
    check('y sale como image/png',
          c.get('/api/profile/image/avatar', headers=h).headers.get('Content-Type', '')
          .startswith('image/png'))

    print('el blob no se cachea (el bug de "no se ve hasta recargar")')
    # Con `max-age` el navegador devolvia la copia anterior al pedir el blob otra
    # vez, y subir un avatar nuevo no se veia en la cabecera hasta recargar.
    r = c.get('/api/profile/image/avatar', headers=h)
    check('Cache-Control: no-store', r.headers.get('Cache-Control') == 'no-store',
          r.headers.get('Cache-Control'))
    check('nosniff sigue puesto', r.headers.get('X-Content-Type-Options') == 'nosniff',
          r.headers.get('X-Content-Type-Options'))
    check('ninguna respuesta del perfil lleva max-age',
          all('max-age' not in (c.get(p, headers=h).headers.get('Cache-Control') or '')
              for p in ('/profile/image/avatar', '/profile/image/banner',
                        '/profile/image/background')))

    print('aislamiento entre usuarios')
    # Se voltean bytes del JPEG para que los dos usuarios tengan imagenes
    # distintas pero del mismo tamano: comparar solo el largo no serviria.
    otro_raw = bytearray(base64.b64decode(JPEG_B64))
    otro_raw[-20] ^= 0xFF
    r = c.put('/api/profile/image', headers=h2,
              json={'kind': 'background', 'data': base64.b64encode(bytes(otro_raw)).decode()})
    check('el segundo usuario sube su fondo', r.status_code == 200, (r.status_code, r.get_json()))
    mio = c.get('/api/profile/image/background', headers=h).data
    suyo = c.get('/api/profile/image/background', headers=h2).data
    check('cada uno recibe la suya, no la del otro',
          len(mio) == len(suyo) and mio != suyo, (len(mio), len(suyo)))

    print('URL externa')
    r = c.put('/api/profile', headers=h, json={'display_name': 'Prueba',
                                               'background_url': 'https://e.com/f.jpg'})
    check('PUT /profile con background_url 200', r.status_code == 200, (r.status_code, r.get_json()))
    check('background_url guardada', perfil(c, h).get('background_url') == 'https://e.com/f.jpg',
          perfil(c, h))
    r = c.put('/api/profile', headers=h, json={'background_url': ''})
    check('background_url vacia se acepta', r.status_code == 200, r.status_code)

    print('las URLs peligrosas se rechazan')
    # Solo avatar y fondo tienen URL externa; el banner va siempre como fichero,
    # asi que `banner_url` no es un campo del perfil y se ignora.
    for campo in ('avatar_url', 'background_url'):
        for valor in ('javascript:alert(1)', 'ftp://e.com/f.jpg', 'data:text/html,<script>'):
            r = c.put('/api/profile', headers=h, json={campo: valor})
            check('%s = %s -> 400' % (campo, valor[:24]), r.status_code == 400, r.status_code)
    r = c.put('/api/profile', headers=h, json={'banner_url': 'javascript:alert(1)'})
    check('banner_url se ignora (no existe el campo)', r.status_code == 200, r.status_code)
    check('y no se guarda', 'banner_url' not in perfil(c, h), list(perfil(c, h)))

    print('validaciones de la imagen')
    casos = [
        ('GIF rechazado', {'kind': 'background', 'data': base64.b64encode(b'GIF89a' + b'x' * 50).decode()}),
        ('base64 roto', {'kind': 'background', 'data': 'no-es-base64!!'}),
        ('sin data', {'kind': 'background'}),
        ('kind inventado', {'kind': 'casco', 'data': JPEG_B64}),
        ('fondo de 1 MB + 10', {'kind': 'background',
                                'data': base64.b64encode(b'\xff\xd8\xff\xe0' + b'0' * (1024 * 1024 + 10)).decode()}),
    ]
    for nombre, payload in casos:
        r = c.put('/api/profile/image', headers=h, json=payload)
        check(nombre + ' -> 400', r.status_code == 400, (r.status_code, r.get_json()))
        if nombre == 'kind inventado':
            # Solo el error de `kind` enumera los tipos; los demas hablan de la
            # imagen (magic bytes, base64, tamano) y no tienen por que nombrarlos.
            check('el error de kind enumera los tres tipos',
                  'fondo' in (r.get_json().get('error') or '').lower(), r.get_json())

    r = c.put('/api/profile/image', headers=h,
              json={'kind': 'background',
                    'data': base64.b64encode(b'\xff\xd8\xff\xe0' + b'0' * (1024 * 1024 + 10)).decode()})
    check('el mensaje del tope dice 1024 KB', '1024' in (r.get_json().get('error') or ''), r.get_json())

    print('el avatar tiene un tope mas bajo que el fondo')
    r = c.put('/api/profile/image', headers=h, json={
        'kind': 'avatar',
        'data': base64.b64encode(b'\xff\xd8\xff\xe0' + b'0' * (120 * 1024 + 10)).decode()})
    check('avatar de 120 KB + 10 -> 400', r.status_code == 400, (r.status_code, r.get_json()))
    check('el mensaje del avatar dice 120 KB', '120' in (r.get_json().get('error') or ''), r.get_json())

    print('quitar una imagen')
    for kind in ('avatar', 'banner', 'background'):
        r = c.put('/api/profile/image', headers=h, json={'kind': kind, 'remove': True})
        check('remove %s 200' % kind, r.status_code == 200, (r.status_code, r.get_json()))
        check('has_%s false tras quitar' % kind, perfil(c, h).get('has_%s' % kind) is False,
              perfil(c, h))
        check('GET %s tras quitar -> 404' % kind,
              c.get('/api/profile/image/' + kind, headers=h).status_code == 404)

    print('resto del perfil')
    r = c.put('/api/profile', headers=h, json={'display_name': 'Otro nombre'})
    check('PUT /profile display_name 200', r.status_code == 200, r.status_code)
    check('display_name guardado', perfil(c, h).get('display_name') == 'Otro nombre', perfil(c, h))
    r = c.put('/api/profile', headers=h, json={'display_name': 'x' * 500})
    check('display_name exagerado -> 400', r.status_code == 400, r.status_code)
    check('GET /api/anime 200', c.get('/api/anime', headers=h).status_code == 200)
    check('GET /api/health 200', c.get('/api/health').status_code == 200)
    check('los JSON reales no se han tocado',
          json.loads(open(config.USERS_FILE, encoding='utf-8').read()).get('yosoy') is not None)


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
