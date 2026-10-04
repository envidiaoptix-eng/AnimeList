"""Autenticación por token Bearer firmado con HMAC-SHA256.

Formato del token: base64url(payload_json).base64url(hmac_sha256)
No hay dependencias externas: el módulo `hmac` de la stdlib cubre el caso.
"""

import base64
import hashlib
import hmac
import json
import time
from functools import wraps

from flask import jsonify, request

from config import SECRET_KEY, TOKEN_TTL_SECONDS


class AuthError(Exception):
    def __init__(self, message, status):
        super().__init__(message)
        self.message = message
        self.status = status


def _b64encode(raw):
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _b64decode(value):
    padding = '=' * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def make_token(username):
    """Emite un token válido para `username`."""
    payload = {'u': username, 'exp': int(time.time()) + TOKEN_TTL_SECONDS}
    body = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    signature = hmac.new(SECRET_KEY.encode('utf-8'), body, hashlib.sha256).digest()
    return f'{_b64encode(body)}.{_b64encode(signature)}'


def verify_token(token):
    """Devuelve el usuario del token, o None si es inválido o ha caducado."""
    if not token or '.' not in token:
        return None

    body_part, signature_part = token.split('.', 1)
    try:
        body = _b64decode(body_part)
        signature = _b64decode(signature_part)
    except (ValueError, TypeError):
        return None

    expected = hmac.new(SECRET_KEY.encode('utf-8'), body, hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected):
        return None

    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None

    if not isinstance(payload, dict):
        return None
    if payload.get('exp', 0) < time.time():
        return None

    username = payload.get('u')
    return username if isinstance(username, str) and username else None


def extract_token():
    header = request.headers.get('Authorization', '')
    if header.startswith('Bearer '):
        return header[7:].strip()
    return None


def current_username():
    return verify_token(extract_token())


def require_auth(view):
    """Inyecta el usuario autenticado como primer argumento de la vista."""

    @wraps(view)
    def wrapper(*args, **kwargs):
        username = current_username()
        if not username:
            return jsonify({'error': 'No autenticado. Vuelve a iniciar sesión.'}), 401
        return view(username, *args, **kwargs)

    return wrapper