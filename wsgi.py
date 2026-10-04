"""Punto de entrada WSGI para gunicorn en Render.

    gunicorn wsgi:app

No se usa `app.run` a proposito: el servidor de desarrollo de Flask es de un
solo proceso y sin timeouts, asi que seeria el cuello de botella nada mas
llegase trafico (o un arranque en frio de los 15 minutos de Render).
"""

import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR / 'Backend'))

from app import app  # noqa: E402  (la ruta debe estar puesta antes del import)

__all__ = ['app']
