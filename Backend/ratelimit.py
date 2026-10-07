"""Límite de peticiones por ventana deslizante, en memoria.

Solo cuenta: no persiste, así que un reinicio del proceso pone los contadores
a cero y cada proceso de gunicorn lleva los suyos. Para lo que protege aquí
(un usuario despistado o un script contra los endpoints sociales) basta y
sobra; una ventana de verdad en Firestore costaría escrituras por cada clic.

Cada clave guarda sus marcas de tiempo en una deque y las que se salen de la
ventana se descartan al mirar, así que no hace falta ningún temporizador.
`reset()` existe para los tests, que no pueden esperar a que caduque una
ventana real.
"""

import time
from collections import deque
from threading import Lock


class RateLimited(Exception):
    """La clave ya agotó su ventana; las rutas la convierten en un 429."""

    def __init__(self, message='Demasiadas peticiones. Espera un poco.', retry_after=60):
        super().__init__(message)
        self.retry_after = max(1, int(retry_after))


_LOGS = {}
_LOCK = Lock()
# Techo de claves para que un atacante que varie el usuario no llene la
# memoria: al llegar al tope se limpian las ventanas ya caducadas.
_MAX_KEYS = 5000


def hit(key, limit, window):
    """Registra una petición y lanza `RateLimited` si la ventana está llena.

    `limit` es lo máximo que se permite dentro de `window` segundos.
    """
    now = time.time()
    with _LOCK:
        if key not in _LOGS and len(_LOGS) >= _MAX_KEYS:
            _prune(now)
        marks = _LOGS.setdefault(key, deque())
        while marks and marks[0] <= now - window:
            marks.popleft()

        if len(marks) >= limit:
            retry = int(marks[0] + window - now) + 1 if marks else int(window)
            raise RateLimited(retry_after=retry)
        marks.append(now)


def _prune(now):
    """Vacía las claves que ya no tienen marcas vigentes."""
    expired = [key for key, marks in _LOGS.items()
               if not marks or marks[-1] <= now]
    for key in expired:
        _LOGS.pop(key, None)
    # Si aun así seguimos llenos, se empieza de cero: perder los contadores es
    # preferible a dejar la tabla crecer sin límite.
    if len(_LOGS) >= _MAX_KEYS:
        _LOGS.clear()


def reset(key=None):
    """Vacia una clave (o todas). Solo para tests."""
    with _LOCK:
        if key is None:
            _LOGS.clear()
        else:
            _LOGS.pop(key, None)
