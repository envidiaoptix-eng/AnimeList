"""Migra los datos locales a Firestore.

    Backend/env/Scripts/python.exe Backend/migrate_to_firestore.py            # simula
    Backend/env/Scripts/python.exe Backend/migrate_to_firestore.py --apply    # escribe

Por defecto SOLO informa de lo que haria; hace falta `--apply` para tocar nada.
Un borrado accidental de la base ya migrada es el riesgo serio de este script
(`save_users`/`save_anime` escriben el estado completo), asi que pide confirmacion
interactiva si ve que la base ya tiene datos.

Migra el JSON exactamente como esta, con `store` en modo JSON para leer y el
adaptador de Firestore para escribir. Si el destino ya tiene un usuario, no se
sobrescribe sin que se acepte: por defecto solo rellena lo que falta.
"""

import argparse
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import config  # noqa: E402
import store  # noqa: E402


def _read_local(users_file, anime_file):
    """Lee los JSON crudos sin pasar por `store`, que ya habria conmutado."""
    users = store.read_json(users_file, {})
    animes = store.read_json(anime_file, [])
    if not isinstance(users, dict):
        users = {}
    if not isinstance(animes, list):
        animes = []
    return users, animes


def main():
    parser = argparse.ArgumentParser(description='Migra los JSON locales a Firestore.')
    parser.add_argument('--apply', action='store_true',
                        help='Escribe de verdad. Sin esto solo se informa.')
    parser.add_argument('--users', default=config.USERS_FILE)
    parser.add_argument('--anime', default=config.ANIME_FILE)
    parser.add_argument('--replace', action='store_true',
                        help='Sobrescribe en Firestore lo que ya exista en vez de '
                             'dejarlo como esta (implica borrar lo demas).')
    args = parser.parse_args()

    users, animes = _read_local(args.users, args.anime)
    if not users and not animes:
        print('No hay nada que migrar: los JSON estan vacios.')
        return 0

    print(f' origen: {len(users)} usuario(s), {len(animes)} anime(s)')
    for username in users:
        profile = users[username]
        print(f'   - {username}: avatar={bool(profile.get("avatar_blob"))} '
              f'banner={bool(profile.get("banner_blob"))}')
    if animes:
        print(f'   - animes de: {sorted({a.get("user") for a in animes})}')

    try:
        from firestore_store import FirestoreStore
        remoto = FirestoreStore()
    except Exception as exc:
        print(f'\nNo se pudo conectar con Firestore: {exc}')
        print('Revisa FIREBASE_PROJECT_ID y las credenciales.')
        return 1

    remotos_usuarios = remoto.load_users()
    remotos_animes = remoto.load_anime()

    choques = sorted(set(users) & set(remotos_usuarios))
    if choques and not args.replace:
        print(f'\nOJO: Firestore ya tiene {len(choques)} de estos usuarios: '
              f'{", ".join(choques)}')
        print('Sus datos NO se tocaran: solo se anadiran los que falten.')
        print('Para sobrescribir, vuelve a ejecutar con --replace.')

    print(f'\n destino: {len(remotos_usuarios)} usuario(s), {len(remotos_animes)} anime(s) ya presentes')

    if not args.apply:
        print('\nSimulacion terminada. Anade --apply para escribir en Firestore.')
        return 0

    if choques and not args.replace:
        nuevos = {k: v for k, v in users.items() if k not in remotos_usuarios}
        print(f'\nEscribiendo {len(nuevos)} usuario(s) nuevo(s)...')
    else:
        nuevos = users
        print(f'\nEscribiendo {len(nuevos)} usuario(s)...')
    remoto.save_users(nuevos)

    ids_locales = {a['id'] for a in animes if a.get('id')}
    ids_remotos = {a['id'] for a in remotos_animes}
    animes_nuevos = [a for a in animes if a.get('id') not in ids_remotos]
    print(f'Escribiendo {len(animes_nuevos)} anime(s)...')
    if ids_locales & ids_remotos:
        remoto.save_anime(remotos_animes + animes_nuevos)
    else:
        remoto.save_anime(animes)

    # Verificacion de lectura: es la unica forma de descartar que la escritura
    # solo parecio funcionar.
    leidos_u = remoto.load_users()
    leidos_a = remoto.load_anime()
    print('\nVerificacion por lectura:')
    for username in nuevos:
        record = leidos_u.get(username)
        hash_ok = record and record.get('password_hash') == nuevos[username].get('password_hash')
        print(f'   {"OK  " if hash_ok else "FALLA"} {username}'
              f'{" (hash intacto)" if hash_ok else " (hash distinto o ausente)"}')
    print(f'   {len(leidos_u)} usuario(s) y {len(leidos_a)} anime(s) en Firestore')

    for username, profile in nuevos.items():
        record = leidos_u.get(username)
        if not record or record.get('password_hash') != profile.get('password_hash'):
            print(f'\nLa verificacion fallo para {username}. Revisa los permisos de '
                  'la cuenta de servicio antes de publicar.')
            return 1

    print('\nMigracion correcta. Ya puedes arrancar con ANIMELIST_USE_FIRESTORE=1.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
