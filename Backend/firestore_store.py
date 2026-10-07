"""Persistencia en Firestore mediante el Admin SDK.

Solo se usa si hay credenciales y `ANIMELIST_USE_FIRESTORE=1`. El cliente nunca
habla con Firestore: el acceso va por aquí con el Admin SDK, que ignora las
reglas de seguridad, así que pueden cerrarse a cualquier cliente.

Esquema:
    users/{usuario}      perfil completo, incluido `password_hash` y los blobs
    anime/{id_del_anime} un documento por anime, con `user` como propietario
    friendships/{id}     amistades confirmadas (par ordenado, id uuid)
    friend_requests/{id} solicitudes pendientes (de `from` a `to`)
    comments/{id}        comentarios globales, con `user` como autor

Dos diferencias importantes frente a los ficheros JSON:

- `save_users` / `save_anime` reciben el estado completo, pero escriben la
  diferencia (upsert + borrado de lo que sobra) en un único lote. Reescribir la
  colección entera en cada cambio costaría escrituras y rompería nada, pero
  multiplicaría el gasto y el tráfico sin motivo.
- Los campos a `None` se guardan como `None`. Firestore los conserva, así que un
  `rating` vacío sigue siendo `None` y no desaparece del documento.
"""

import json
import os

from config import (
    FIREBASE_CREDENTIALS,
    FIREBASE_DATABASE_ID,
    FIREBASE_PROJECT_ID,
    FIRESTORE_COLLECTION_ANIME,
    FIRESTORE_COLLECTION_COMMENTS,
    FIRESTORE_COLLECTION_FRIENDSHIPS,
    FIRESTORE_COLLECTION_FRIEND_REQUESTS,
    FIRESTORE_COLLECTION_USERS,
    GOOGLE_APPLICATION_CREDENTIALS,
)


class FirestoreUnavailable(RuntimeError):
    """Faltan credenciales o la librería, o Firestore no responde."""


# Firestore admite 500 escrituras por lote; se corta antes para tener margen.
_BATCH_LIMIT = 400


def credentials_available():
    """¿Hay algo con lo que autenticarse contra Firestore?"""
    return bool(GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_CREDENTIALS)


class FirestoreStore:
    """Adaptador con la misma interfaz que usa `store` para los JSON."""

    def __init__(self, client=None):
        # Cliente ya construido: se respeta tal cual y no hace falta ni el SDK
        # ni las credenciales. Es lo que permite probar el diff y el troceado de
        # lotes con un doble en local.
        if client is not None:
            self._db = client
            return

        try:
            import firebase_admin
            from firebase_admin import credentials, firestore
        except ImportError as exc:
            raise FirestoreUnavailable(
                'Falta la dependencia firebase-admin (pip install firebase-admin).'
            ) from exc

        if not credentials_available():
            raise FirestoreUnavailable(
                'Faltan credenciales: define GOOGLE_APPLICATION_CREDENTIALS '
                '(ruta al JSON) o FIREBASE_CREDENTIALS (el JSON en linea).'
            )

        # En Render el disco es efímero y no hay ADC de GCE ni de Cloud Run, así
        # que la inicialización se apoya siempre en la clave privada.
        try:
            if FIREBASE_CREDENTIALS:
                info = json.loads(FIREBASE_CREDENTIALS)
                cred = credentials.Certificate(info)
            else:
                if not os.path.exists(GOOGLE_APPLICATION_CREDENTIALS):
                    raise FirestoreUnavailable(
                        f'No existe el fichero de credenciales: {GOOGLE_APPLICATION_CREDENTIALS}'
                    )
                cred = credentials.Certificate(GOOGLE_APPLICATION_CREDENTIALS)
        except FirestoreUnavailable:
            raise
        except (ValueError, json.JSONDecodeError) as exc:
            raise FirestoreUnavailable(f'Credenciales invalidas: {exc}') from exc

        project = FIREBASE_PROJECT_ID or getattr(cred, 'project_id', None)
        try:
            if not firebase_admin._apps:
                firebase_admin.initialize_app(cred, {'projectId': project})
            # Los proyectos de Firebase Studio usan una base con nombre en lugar
            # de `(default)`; sin `database_id` se escribiria en otra.
            self._db = (firestore.client(database_id=FIREBASE_DATABASE_ID)
                        if FIREBASE_DATABASE_ID else firestore.client())
        except Exception as exc:  # pragma: no cover - depende del entorno
            raise FirestoreUnavailable(f'No se pudo inicializar Firebase: {exc}') from exc

    # ------------------------------------------------------------------
    # Usuarios
    # ------------------------------------------------------------------

    def load_users(self):
        from store import _migrate_user_record

        users = {}
        for snap in self._db.collection(FIRESTORE_COLLECTION_USERS).stream():
            data = snap.to_dict() or {}
            record = _migrate_user_record(snap.id, data)
            if record is not None:
                users[snap.id] = record
        return users

    def save_users(self, users):
        col = self._db.collection(FIRESTORE_COLLECTION_USERS)
        # Una sola lectura para saber que hay: luego solo se escribe lo que de
        # verdad cambia. Sin esto, marcar un anime como visto reescribiria todos
        # los perfiles del sitio.
        existentes = {snap.id: (snap.to_dict() or {}) for snap in col.stream()}

        batch = self._db.batch()
        pending = 0

        for doc_id in set(existentes) - set(users):
            batch.delete(col.document(doc_id))
            pending += 1
            if pending >= _BATCH_LIMIT:
                batch.commit()
                batch = self._db.batch()
                pending = 0

        for username, record in users.items():
            limpio = _clean_for_firestore(record)
            if existentes.get(username) == limpio:
                continue
            batch.set(col.document(username), limpio)
            pending += 1
            if pending >= _BATCH_LIMIT:
                batch.commit()
                batch = self._db.batch()
                pending = 0

        if pending:
            batch.commit()

    # ------------------------------------------------------------------
    # Anime
    # ------------------------------------------------------------------

    def load_anime(self):
        from store import normalize_anime

        animes = []
        for snap in self._db.collection(FIRESTORE_COLLECTION_ANIME).stream():
            data = snap.to_dict()
            if not isinstance(data, dict):
                continue
            data.setdefault('id', snap.id)
            animes.append(normalize_anime(data))
        return animes

    def save_anime(self, animes):
        col = self._db.collection(FIRESTORE_COLLECTION_ANIME)
        existentes = {snap.id: (snap.to_dict() or {}) for snap in col.stream()}
        batch = self._db.batch()
        wanted = {}
        for anime in animes:
            anime_id = anime.get('id')
            if anime_id:
                wanted[str(anime_id)] = anime
        pending = 0

        for doc_id in set(existentes) - set(wanted):
            batch.delete(col.document(doc_id))
            pending += 1
            if pending >= _BATCH_LIMIT:
                batch.commit()
                batch = self._db.batch()
                pending = 0

        for anime_id, anime in wanted.items():
            limpio = _clean_for_firestore(anime)
            if existentes.get(anime_id) == limpio:
                continue
            batch.set(col.document(anime_id), limpio)
            pending += 1
            if pending >= _BATCH_LIMIT:
                batch.commit()
                batch = self._db.batch()
                pending = 0

        if pending:
            batch.commit()

    # ------------------------------------------------------------------
    # Social: amistades y comentarios
    # ------------------------------------------------------------------

    def load_friends(self):
        from store import normalize_friendship, normalize_request

        def collect(collection_name, normalize):
            records = []
            for snap in self._db.collection(collection_name).stream():
                data = snap.to_dict()
                if not isinstance(data, dict):
                    continue
                data.setdefault('id', snap.id)
                records.append(normalize(data))
            return records

        return {
            'friendships': collect(FIRESTORE_COLLECTION_FRIENDSHIPS,
                                   normalize_friendship),
            'requests': collect(FIRESTORE_COLLECTION_FRIEND_REQUESTS,
                                normalize_request),
        }

    def save_friends(self, data):
        self._save_records(FIRESTORE_COLLECTION_FRIENDSHIPS,
                           data.get('friendships') or [])
        self._save_records(FIRESTORE_COLLECTION_FRIEND_REQUESTS,
                           data.get('requests') or [])

    def load_comments(self):
        from store import normalize_comment

        comments = []
        for snap in self._db.collection(FIRESTORE_COLLECTION_COMMENTS).stream():
            data = snap.to_dict()
            if not isinstance(data, dict):
                continue
            data.setdefault('id', snap.id)
            comments.append(normalize_comment(data))
        return comments

    def save_comments(self, comments):
        self._save_records(FIRESTORE_COLLECTION_COMMENTS, comments)

    def _save_records(self, collection_name, records):
        """Diferencia por id: upsert de lo cambiado, borrado de lo sobrante.

        Mismo patrón que `save_anime`, con los ids como documento. Un registro
        sin id no se escribe: lo genera `load_*` al leer, así que solo puede
        faltar si alguien escribe a mano por la API.
        """
        col = self._db.collection(collection_name)
        existentes = {snap.id: (snap.to_dict() or {}) for snap in col.stream()}
        wanted = {}
        for record in records:
            record_id = record.get('id')
            if record_id:
                wanted[str(record_id)] = record

        batch = self._db.batch()
        pending = 0

        for doc_id in set(existentes) - set(wanted):
            batch.delete(col.document(doc_id))
            pending += 1
            if pending >= _BATCH_LIMIT:
                batch.commit()
                batch = self._db.batch()
                pending = 0

        for record_id, record in wanted.items():
            limpio = _clean_for_firestore(record)
            if existentes.get(record_id) == limpio:
                continue
            batch.set(col.document(record_id), limpio)
            pending += 1
            if pending >= _BATCH_LIMIT:
                batch.commit()
                batch = self._db.batch()
                pending = 0

        if pending:
            batch.commit()


def _clean_for_firestore(record):
    """Quita lo que Firestore no admite como campo.

    El Admin SDK rechaza `None` en algunos contextos de nested y no acepta
    claves con punto. Aquí solo se eliminan claves inválidas; los `None` se
    conservan porque son datos válidos (nota vacía, año desconocido) y porque
    `load_anime` los rellena igual.
    """
    return {k: v for k, v in record.items() if isinstance(k, str) and '.' not in k}