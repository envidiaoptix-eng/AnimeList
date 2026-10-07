"""AnimeList - API Flask y frontend estático.

Arranque:  Backend/env/Scripts/python.exe Backend/app.py
           http://localhost:5000

En producción lo sirve gunicorn (ver `wsgi.py`) en el mismo origen que el
frontend, así que el navegador llama a rutas relativas y nunca hay CORS.
"""

from pathlib import Path

from flask import Flask, abort, jsonify, send_from_directory
from flask_cors import CORS

from config import ALLOWED_ORIGINS, DEBUG, MAX_UPLOAD_BYTES
from routes_admin import bp as admin_bp
from routes_anime import bp as anime_bp
from routes_auth import bp as auth_bp
from routes_social import bp as social_bp

FRONTEND_DIR = Path(__file__).resolve().parent.parent / 'Frontend'


def create_app():
    app = Flask(__name__)
    app.config['JSON_AS_ASCII'] = False
    # Red de seguridad general. El tope fino por tipo de imagen (avatar 120 KB,
    # banner 400 KB) lo revisa `routes_auth`; esto solo evita que una petición
    # enorme se coma la memoria antes de llegar ahí.
    app.config['MAX_CONTENT_LENGTH'] = MAX_UPLOAD_BYTES

    # Solo se admite file:// (Origin: null) y localhost; cualquier otro origen
    # queda bloqueado porque los tokens viajan en la cabecera Authorization.
    CORS(app, resources={r'/api/*': {'origins': ALLOWED_ORIGINS}})

    app.register_blueprint(auth_bp)
    app.register_blueprint(anime_bp)
    app.register_blueprint(social_bp)
    app.register_blueprint(admin_bp)

    # El frontend también se sirve desde aquí, así basta con arrancar el backend.
    # send_from_directory impide salir de Frontend/ (path traversal).
    @app.get('/')
    def landing():
        """Portada pública. `index.html` (registro) sigue en su propia ruta."""
        return send_from_directory(FRONTEND_DIR, 'landing.html')

    @app.get('/<path:filename>')
    def frontend(filename):
        if filename.startswith('api/'):
            abort(404)
        return send_from_directory(FRONTEND_DIR, filename)

    @app.errorhandler(404)
    def not_found(_error):
        return jsonify({'error': 'Ese endpoint no existe.'}), 404

    @app.errorhandler(405)
    def not_allowed(_error):
        return jsonify({'error': 'Método no permitido en ese endpoint.'}), 405

    @app.get('/api/health')
    def health():
        # `storage` se incluye porque en Render el disco es efímero: si el
        # proceso arranca sin credenciales y se queda en 'json', los datos de
        # cada arranque se pierden. Se ve en un solo vistazo desde el navegador.
        from store import backend_name

        return jsonify({'status': 'ok', 'storage': backend_name()})

    return app


app = create_app()

if __name__ == '__main__':
    app.run(debug=DEBUG, port=5000, host='127.0.0.1')