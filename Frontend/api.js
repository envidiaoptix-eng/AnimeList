/**
 * Cliente HTTP del backend Flask.
 * Centraliza el token Bearer, los errores y la redirección cuando caduca la sesión.
 */

/**
 * Base de la API: relativa, porque Flask sirve tambien el frontend.
 *
 * Antes era `http://localhost:5000/api` fijo, y en Render eso hacia que cada
 * peticion del navegador fuera a `localhost:5000` del propio visitante, donde
 * no hay nada escuchando. El fallo se ve como un error de CORS, pero no lo es:
 * con rutas relativas todo es same-origin y la cabecera `Origin` ni se mira.
 * Esa restriction de `ALLOWED_ORIGINS` se queda, que protege los tokens Bearer.
 *
 * La excepcion es `file://`, que es el unico caso en el que no hay servidor que
 * sirva el HTML: ahi `/api/register` se resolveria a `file:///api/register` y
 * fallaria. El navegador tendria que hablar con el backend de la otra
 * maquina, y ahi si hace falta la URL explicita.
 */
const RELATIVE_API_BASE = '/api';
const FILE_API_BASE = 'http://localhost:5000/api';

const DEFAULT_API_BASE = location.protocol === 'file:' ? FILE_API_BASE : RELATIVE_API_BASE;

const API_BASE_KEY = 'animelist_api_base';
const SESSION_KEY = 'animelist_session';

export class ApiError extends Error {
    constructor(message, status = 0, payload = null) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.payload = payload;
        this.isNetworkError = status === 0;
    }
}

import { readJSON, writeJSON } from './storage.js';

function readSession() {
    const session = readJSON(SESSION_KEY, null);
    if (!session || !session.token || !session.username) return null;
    if (session.expiresAt && session.expiresAt < Date.now()) return null;
    return session;
}

/**
 * `fetch` con tope de tiempo.
 *
 * Sin esto, un servidor colgado dejaba al usuario mirando «Guardando…» para
 * siempre: `fetch` no tiene timeout y el botón solo se reactiva en el `finally`
 * del llamador. Un tiempo agotado se traduce en `ApiError` con status 0, que
 * es exactamente lo que la capa de datos interpreta como «sin conexión» y
 * encola.
 *
 * Si el llamador aborta su propia señal (la búsqueda con `AbortController`),
 * se respeta el `AbortError` original: para él sí hay un significado concreto.
 */
const REQUEST_TIMEOUT_MS = 15000;

async function timedFetch(url, { signal, ...options } = {}) {
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const relayAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', relayAbort, { once: true });
    }

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (timedOut) throw new ApiError('El servidor no responde.', 0);
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', relayAbort);
    }
}

export const ApiClient = {
    baseUrl() {
        return localStorage.getItem(API_BASE_KEY) || DEFAULT_API_BASE;
    },

    setBaseUrl(url) {
        if (url) localStorage.setItem(API_BASE_KEY, url.replace(/\/+$/, ''));
        else localStorage.removeItem(API_BASE_KEY);
    },

    getSession: readSession,

    isAuthenticated() {
        return readSession() !== null;
    },

    saveSession({ username, token, expires_in: ttl, profile }) {
        const session = {
            username,
            token,
            profile: profile || null,
            expiresAt: Date.now() + (ttl || 0) * 1000,
        };
        writeJSON(SESSION_KEY, session);
        return session;
    },

    clearSession() {
        localStorage.removeItem(SESSION_KEY);
    },

    /**
     * `keepSessionOn401` desactiva el cierre de sesión ante un 401.
     * Existe para `changePassword`: allí un 401 significa «la contraseña
     * actual no es correcta», no «el token caducó». Sin esta bandera,
     * teclear mal la contraseña actual expulsaba al usuario del formulario
     * con una redirección a la pantalla de acceso.
     */
    async request(path, {
        method = 'GET',
        body = null,
        auth = true,
        signal = null,
        keepSessionOn401 = false,
    } = {}) {
        const headers = {};
        if (body !== null) headers['Content-Type'] = 'application/json';

        if (auth) {
            const session = readSession();
            if (!session) throw new ApiError('Sesión no válida.', 401);
            headers.Authorization = `Bearer ${session.token}`;
        }

        let response;
        try {
            response = await timedFetch(`${this.baseUrl()}${path}`, {
                method,
                headers,
                body: body === null ? undefined : JSON.stringify(body),
                signal,
            });
        } catch (error) {
            if (error instanceof ApiError) throw error;
            if (error.name === 'AbortError') throw error;
            throw new ApiError('No se pudo conectar con el servidor.', 0);
        }

        const text = await response.text();
        let payload = null;
        if (text) {
            try {
                payload = JSON.parse(text);
            } catch (error) {
                payload = { error: 'El servidor devolvió una respuesta ilegible.' };
            }
        }

        if (response.status === 401 && auth && !keepSessionOn401) {
            this.clearSession();
            // Al acceso, no al registro: una sesión caducada no es un motivo
            // para crear cuenta. `index.html` es la pantalla de alta.
            if (!location.pathname.endsWith('login.html')) {
                location.href = 'login.html';
            }
            throw new ApiError(payload?.error || 'Tu sesión ha caducado.', 401, payload);
        }

        if (!response.ok) {
            const message = payload?.error || `Error ${response.status}.`;
            throw new ApiError(message, response.status, payload);
        }

        return payload;
    },

    async register(username, password) {
        const data = await this.request('/register', { method: 'POST', body: { username, password }, auth: false });
        return this.saveSession(data);
    },

    async login(username, password) {
        const data = await this.request('/login', { method: 'POST', body: { username, password }, auth: false });
        return this.saveSession(data);
    },

    logout() {
        this.clearSession();
    },

    me() {
        return this.request('/me');
    },

    updateProfile(fields) {
        return this.request('/profile', { method: 'PUT', body: fields });
    },

    /** El perfil suelto, sin el contador de animes que también trae `/me`. */
    getProfile() {
        return this.me().then((data) => data.profile);
    },

    /** Sube el avatar o el banner ya recortados, en base64 pelado. */
    uploadProfileImage(kind, base64data) {
        return this.request('/profile/image', {
            method: 'PUT',
            body: { kind, data: base64data },
        });
    },

    removeProfileImage(kind) {
        return this.request('/profile/image', { method: 'PUT', body: { kind, remove: true } });
    },

    /**
     * Los bytes van aparte de `/api/me` para no arrastrar el base64 en cada
     * carga; por eso se piden como Blob y no como JSON.
     *
     * Con `username` pide la imagen de otra cuenta (lista ajena); sin él, la
     * propia, que es el comportamiento de siempre.
     */
    async fetchProfileImage(kind, username = null) {
        const session = readSession();
        const query = username ? `?user=${encodeURIComponent(username)}` : '';
        const response = await fetch(`${this.baseUrl()}/profile/image/${encodeURIComponent(kind)}${query}`, {
            headers: session?.token ? { Authorization: `Bearer ${session.token}` } : {},
        });
        if (!response.ok) {
            throw new ApiError('No se ha podido cargar la imagen.', response.status, null);
        }
        return response.blob();
    },

    changePassword(currentPassword, newPassword) {
        return this.request('/password', {
            method: 'POST',
            body: { current_password: currentPassword, new_password: newPassword },
            keepSessionOn401: true,
        });
    },

    /** Buscador de cuentas del menú de usuario (para saltar a su lista). */
    searchUsers(term, { signal = null } = {}) {
        const params = new URLSearchParams();
        if (term) params.set('q', term);
        return this.request(`/users?${params}`, { signal });
    },

    /** Perfil público de otra cuenta, para pintar la cabecera de su lista. */
    getUser(username) {
        return this.request(`/users/${encodeURIComponent(username)}`);
    },

    getAnimes(username) {
        return this.request(`/anime?user=${encodeURIComponent(username)}`);
    },

    addAnime(anime) {
        return this.request('/anime', { method: 'POST', body: anime }).then((data) => data.anime);
    },

    updateAnime(animeId, fields) {
        return this.request(`/anime/${encodeURIComponent(animeId)}`, { method: 'PUT', body: fields })
            .then((data) => data.anime);
    },

    deleteAnime(animeId) {
        return this.request(`/anime/${encodeURIComponent(animeId)}`, { method: 'DELETE' });
    },

    refreshAnime(animeId) {
        return this.request(`/anime/${encodeURIComponent(animeId)}/external`).then((data) => data.anime);
    },

    searchAnime(term, { page = 1, adult = false, autocomplete = false, signal = null } = {}) {
        const params = new URLSearchParams({
            q: term,
            page: String(page),
            adulto: adult ? '1' : '0',
        });
        if (autocomplete) params.set('autocomplete', '1');
        return this.request(`/anime/search?${params}`, { signal });
    },

    getStats() {
        return this.request('/stats');
    },

    /* ---- Administración (solo con rol admin; el backend vuelve a comprobar) ---- */

    adminListUsers() {
        return this.request('/admin/users');
    },

    adminDeleteUser(username) {
        return this.request(`/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    },

    adminResetPassword(username, password) {
        return this.request(`/admin/users/${encodeURIComponent(username)}/password`, {
            method: 'POST',
            body: { password },
        });
    },

    adminSetRole(username, role) {
        return this.request(`/admin/users/${encodeURIComponent(username)}/role`, {
            method: 'PUT',
            body: { role },
        });
    },

    /* ---- Social: amistades y comentarios (el backend vuelve a comprobar) ---- */

    listFriends() {
        return this.request('/friends');
    },

    sendFriendRequest(username) {
        return this.request('/friends/request', { method: 'POST', body: { username } });
    },

    acceptFriendRequest(username) {
        return this.request('/friends/accept', { method: 'POST', body: { username } });
    },

    rejectFriendRequest(username) {
        return this.request('/friends/reject', { method: 'POST', body: { username } });
    },

    removeFriend(username) {
        return this.request(`/friends/${encodeURIComponent(username)}`, { method: 'DELETE' });
    },

    /** Muro de una lista: `target` es la cuenta comentada; sin filtros, el global. */
    listComments({ target = null, user = null, anime = null } = {}) {
        const params = new URLSearchParams();
        if (target) params.set('target', target);
        if (user) params.set('user', user);
        if (anime) params.set('anime', anime);
        const query = params.toString();
        return this.request(`/comments${query ? `?${query}` : ''}`);
    },

    addComment({ text, target = null, animeId = null } = {}) {
        const body = { text };
        if (target) body.target = target;
        if (animeId) body.anime_id = animeId;
        return this.request('/comments', { method: 'POST', body });
    },

    deleteComment(commentId) {
        return this.request(`/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
    },
};