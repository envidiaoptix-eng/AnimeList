"""Cruza los ids, selectores y data-icon que pide el JS con lo que hay en el HTML.

Sin dependencias: `python Backend/tests/check_ids.py`. Sale con codigo 1 si algo
no cuadra, para poder engancharlo a un hook o a CI.
"""

import io
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / 'Backend'
FRONTEND = REPO / 'Frontend'
CSS = FRONTEND / 'css'

FALLOS = []


def check(nombre, ok, extra=''):
    print(('  OK    ' if ok else '  FALLO ') + nombre + (('  -> ' + str(extra)) if not ok else ''))
    if not ok:
        FALLOS.append(nombre)


def leer(path):
    return io.open(path, encoding='utf-8').read()


def ids_de_js(nombre):
    return set(re.findall(r"getElementById\('([^']+)'\)", leer(nombre)))


# ---------------------------------------------------------------- dashboard.html

html = leer(FRONTEND / 'dashboard.html')
ids_html = set(re.findall(r'\bid="([^"]+)"', html))
iconos_html = set(re.findall(r'\bdata-icon="([^"]+)"', html))
clases_html = set()
for bloque in re.findall(r'\bclass="([^"]+)"', html):
    clases_html.update(bloque.split())

css_completo = '\n'.join(
    leer(p) for p in (
        CSS / 'tokens.css', CSS / 'base.css', CSS / 'components.css',
        CSS / 'dashboard.css', CSS / 'auth.css', CSS / 'landing.css',
    ) if p.exists()
)
dash_css = leer(CSS / 'dashboard.css')

print('ids que pide el JS y no existen en dashboard.html')
for nombre in ('profile.js', 'dashboard.js', 'search_modal.js'):
    pedidos = ids_de_js(FRONTEND / nombre)
    faltan = sorted(pedidos - ids_html)
    check('%s: %d ids, faltan %s' % (nombre, len(pedidos), faltan or 'ninguno'), not faltan, faltan)

print('querySelector del JS contra el HTML y el CSS')
for nombre in ('profile.js', 'dashboard.js', 'search_modal.js', 'landing.js', 'app.js'):
    selectores = set(re.findall(r"querySelector(?:All)?\('([^']+)'\)", leer(FRONTEND / nombre)))
    faltan = []
    for sel in selectores:
        # Solo los id o clase simples; los compuestos se saltan por no ser
        # comprobables con una regex.
        clase = re.fullmatch(r'\.([A-Za-z0-9_-]+)', sel)
        if clase and clase.group(1) not in clases_html and clase.group(1) not in css_completo:
            faltan.append(sel)
        id_ = re.fullmatch(r'#([A-Za-z0-9_-]+)', sel)
        if id_ and id_.group(1) not in ids_html:
            faltan.append(sel)
    check('%s: faltan %s' % (nombre, faltan or 'ninguno'), not faltan, faltan)

print('data-icon del HTML contra el catalogo de icons.js')
catalogo = set(re.findall(r"^\s*'?([a-z][a-z0-9-]*)'?\s*:", leer(FRONTEND / 'icons.js'), re.M))
faltan = sorted(iconos_html - catalogo)
check('%d iconos en el HTML, faltan en el catalogo: %s' % (len(iconos_html), faltan or 'ninguno'),
      not faltan, faltan)

print('el fondo: nodos y reglas CSS')
for cid in ('profile-background', 'profile-background-empty', 'profile-background-label',
            'profile-background-file', 'profile-background-note', 'profile-background-remove',
            'profile-background-url'):
    check('dashboard.html tiene #' + cid, cid in ids_html)
check('dashboard.css define .profile-row__preview--background', '.profile-row__preview--background' in dash_css)
check('dashboard.css define body.has-page-bg', 'body.has-page-bg' in dash_css)
check('el velo se tiñe con --bg y no con negro', 'color-mix(in srgb, var(--bg)' in dash_css)

print('dashboard.js engancha el fondo')
dash = leer(FRONTEND / 'dashboard.js')
# En lista ajena el perfil pintado es el de la cuenta visitada, así que la
# llamada es con `pageProfile`; con `profile` (la sesion) se pintaria el fondo
# propio encima del banner ajeno.
check('renderUser llama a paintPageBackground(pageProfile)',
      'await paintPageBackground(pageProfile);' in dash)
check('quita la clase cuando no hay url', "classList.remove('has-page-bg')" in dash)
check('quita la variable cuando no hay url', "removeProperty('--page-bg')" in dash)
check('escapa comillas en la url del css', "replace(/[\\\\\"]/g" in dash)
check('el avatar y la inicial nunca se quedan los dos a la vez',
      'dom.avatarFallback.hidden = Boolean(url);' in dash)

print('profile.js: imagenes')
prof = leer(FRONTEND / 'profile.js')
check('staged.background se limpia al abrir', prof.count('staged.background = null;') >= 1)
check('la URL del fondo se carga al abrir', "dom.backgroundUrl.value = profile?.background_url || '';" in prof)
check('la preview del fondo se pide al abrir', "preview('background')" in prof)
check('background_url se envia si cambia', 'fields.background_url = backgroundUrl' in prof)
check("imageUrl usa `${kind}_url`", 'profile[`${kind}_url`]' in prof)
check('no queda el external hardcodeado', "kind === 'avatar' ? profile.avatar_url" not in prof)
check('el bucle de guardado suelta la cache del object URL antes de repintar',
      'releaseUrl(kind);' in prof.split('async function')[0] or
      'releaseUrl(kind);\n                staged[kind] = null;' in prof)
# Sin esto, elegir dos veces el mismo archivo en la misma sesion no dispara
# `change` porque `value` no cambia, y el boton parece muerto.
cuerpo_pick = prof.split('const pick = async')[1].split('const removeImage')[0]
check('pick vacia el input para poder re-elegir el mismo archivo',
      re.search(r'(?:avatarInput|bannerInput|backgroundInput)[\s\S]{0,80}?\.value\s*=\s*\'\'', cuerpo_pick)
      is not None, 'pick no vacia ningun input: elegir dos veces el mismo archivo no dispara change')

# El blob se sirve con `no-store`: con `max-age` el navegador devolvia la copia
# anterior y subir un avatar nuevo no se veia hasta recargar. Ya rompio una vez.
# Se busca en las lineas que NO son comentario: el comentario que explica por que
# esta asi nombra `max-age` a proposito, y el test no debe ensuinguirlo.
codigo_auth = '\n'.join(
    linea for linea in leer(BACKEND / 'routes_auth.py').splitlines()
    if not linea.lstrip().startswith('#')
)
check('el blob de perfil no se cachea en el navegador',
      "'Cache-Control': 'no-store'" in codigo_auth and 'max-age' not in codigo_auth,
      'vuelve max-age' if 'max-age' in codigo_auth else 'falta no-store')

print('lista ajena: modo solo lectura')
# `dashboard.html?user=X` pinta la lista de otra cuenta. Cualquiera de estos
# cabos sueltos deja botones de edicion en lista ajena, datos del visitante en
# la cola offline o el banner sin anclar.
check('dashboard.html tiene la banda #view-banner', 'view-banner' in ids_html)
check('dashboard.html tiene el buscador en el menu', 'view-user-form' in ids_html)
check('dashboard.html tiene el datalist de sugerencias', 'view-user-suggestions' in ids_html)
check('dashboard.js deriva viewUser de la URL', 'const viewUser = queryUser || username;' in dash)
check('dashboard.js comprueba isOwnList', 'const isOwnList = viewUser === username;' in dash)
check('la lista se pide al usuario visitado, no siempre al de sesion',
      'DataRepository.getAnimes(viewUser)' in dash)
check('un 404 de cuenta ajena vuelve a la lista propia',
      "error?.status === 404" in dash and "location.replace('dashboard.html')" in dash)
check('el panel de alta se oculta en lista ajena', 'dom.addPanel.hidden = true;' in dash)
check('no hay boton de editar ni borrar en lista ajena', 'if (!isOwnList) return [];' in dash)
check('la cola offline no se volca ni se encola en lista ajena',
      'if (online && isOwnList) syncQueue();' in dash
      and 'if (isOwnList) await syncQueue();' in dash)
check('las imagenes de otra cuenta se revocan al salir', 'releaseViewImageUrls();' in dash)
check('dashboard.css define .view-banner', '.view-banner {' in dash_css)
comp = leer(CSS / 'components.css')
check('components.css define .dropdown__form', '.dropdown__form' in comp)
check('api.js pide la imagen de perfil de otra cuenta con ?user=',
      'username ? `?user=${encodeURIComponent(username)}`' in leer(FRONTEND / 'api.js'))

print('administracion: el censo')
check('dashboard.html tiene el dialogo #admin-dialog', 'admin-dialog' in ids_html)
check('el boton de admin solo se muestra con el rol de la sesion',
      'dom.adminButton.hidden = !Boolean(session.profile?.is_admin);' in dash)
check('el boton del menu abre el censo', 'dom.adminButton.addEventListener' in dash)
check('la contrasena respeta el minimo del backend', "minlength: '6'" in dash)
check('dashboard.css da scroll al censo', '.admin-users {' in dash_css)

print('codigo muerto y trampas conocidas')
todo_js = '\n'.join(leer(p) for p in FRONTEND.glob('*.js'))
todo_html = '\n'.join(leer(p) for p in FRONTEND.glob('*.html'))
check('no queda Firebase en el cliente',
      not re.search(r'Firebase|firebase|FIREBASE', todo_js + todo_html))
ui = leer(FRONTEND / 'ui.js')
# El comentario de cabecera nombra innerHTML para explicar por que no se usa,
# asi que solo se busca como asignacion real y no como texto de documentacion.
check('el() ya no ofrece la rama html', not re.search(r"key === 'html'", ui))
check('el() no asigna innerHTML', 'node.innerHTML' not in ui)

# La base de la API es relativa salvo en file://. Con `http://localhost:5000`
# fijo, en Render cada peticion iba al localhost:5000 del visitante. El sintoma
# sale como error de CORS, pero la causa es la URL, no el origen.
api = leer(FRONTEND / 'api.js')
# Se miran solo las lineas de codigo: los comentarios cuentan el bug de
# `localhost:5000` a proposito, y el test no debe ensuinguirlo.
codigo_api = '\n'.join(l for l in api.splitlines() if not l.lstrip().startswith(('*', '/', '//')))
check('la base por defecto de la API es relativa', "RELATIVE_API_BASE = '/api'" in api)
check('y localhost:5000 queda solo en la constante de file://',
      codigo_api.count('http://localhost:5000') == 1
      and 'localhost' not in '\n'.join(
          l for l in codigo_api.splitlines() if 'FILE_API_BASE' not in l)
      and "location.protocol === 'file:'" in api)
check('ninguna llamada fetch lleva una IP o puerto fijo',
      not re.search(r'fetch\(\s*[\'"]https?://', api))
ua = [l for l in leer(BACKEND / 'config.py').splitlines() if l.startswith('USER_AGENT')]
check('el User-Agent ya no anuncia localhost', len(ua) == 1 and 'localhost' not in ua[0], ua)
check('el backend de Firestore sigue en su sitio', (REPO / 'Backend' / 'firestore_store.py').exists())
check('las plantillas de reglas siguen en su sitio',
      all((REPO / 'Backend' / f).exists() for f in ('firebase.json', 'firestore.rules', 'storage.rules')))

print()
if FALLOS:
    print('FALLOS (%d): %s' % (len(FALLOS), ' | '.join(FALLOS)))
    sys.exit(1)
print('TODO CORRECTO')
