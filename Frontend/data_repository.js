/**
 * Repositorio de datos.
 *
 * Orden de prioridad real:
 *   1. Flask REST API  -> fuente de verdad
 *   2. Firebase        -> copia opcional, solo si hay configuración válida
 *   3. localStorage    -> caché de lectura y cola de operaciones pendientes
 *
 * Si Flask no responde por red, las escrituras se guardan localmente y entran
 * en la cola; al recuperar la conexión se reintentan en orden.
 */

import { ApiClient, ApiError } from './api.js';
import { AnimeCache, OfflineQueue } from './storage.js';

export function normalizeAnime(anime = {}) {
    return {
        id: anime.id || `local_${Date.now()}`,
        user: anime.user || '',
        title: anime.title || 'Sin título',
        title_native: anime.title_native || '',
        title_english: anime.title_english || '',
        rating: Number(anime.rating) || 5,
        cover_url: anime.cover_url || '',
        cover_color: anime.cover_color || '',
        synopsis: anime.synopsis || '',
        episodes: anime.episodes ?? '?',
        status: anime.status || 'Pendiente',
        genres: Array.isArray(anime.genres) ? anime.genres : [],
        year: anime.year ?? null,
        format: anime.format || 'Unknown',
        studios: Array.isArray(anime.studios) ? anime.studios : [],
        trailer: anime.trailer || '',
        score: anime.score ?? null,
        rankings: Array.isArray(anime.rankings) ? anime.rankings : [],
        lists: anime.lists ?? null,
        anilist_id: anime.anilist_id ?? null,
        mal_id: anime.mal_id ?? null,
        kitsu_id: anime.kitsu_id ?? null,
        source: anime.source || 'manual',
        updatedAt: anime.updatedAt || new Date().toISOString(),
        pending: Boolean(anime.pending),
    };
}

/** Campos que la API acepta al crear o actualizar. */
function writableFields(anime) {
    return {
        title: anime.title,
        title_native: anime.title_native,
        title_english: anime.title_english,
        rating: anime.rating,
        cover_url: anime.cover_url,
        synopsis: anime.synopsis,
        episodes: anime.episodes,
        status: anime.status,
        genres: anime.genres,
        year: anime.year,
        format: anime.format,
        studios: anime.studios,
        trailer: anime.trailer,
        score: anime.score,
        rankings: anime.rankings,
        lists: anime.lists,
        anilist_id: anime.anilist_id,
        mal_id: anime.mal_id,
        kitsu_id: anime.kitsu_id,
        source: anime.source,
    };
}

function firebase() {
    const service = window.FirebaseService;
    return service?.isInitialized?.() ? service : null;
}

export const DataRepository = {
    /** Indica si la última escritura quedó pendiente de enviar. */
    isPending(username, animeId) {
        return OfflineQueue.read(username).some((entry) => entry.animeId === animeId);
    },

    queueSize(username) {
        return OfflineQueue.size(username);
    },

    async getAnimes(username) {
        if (!username) return [];

        if (ApiClient.isAuthenticated()) {
            try {
                const list = await ApiClient.getAnimes(username);
                const normalized = list.map(normalizeAnime);
                AnimeCache.write(username, normalized);
                return normalized;
            } catch (error) {
                if (error instanceof ApiError && error.status === 401) throw error;
                console.warn('Backend no disponible; se usa la copia local.', error.message);
            }
        }

        return AnimeCache.read(username).map(normalizeAnime);
    },

    async addAnime(anime, username) {
        const payload = normalizeAnime({ ...writableFields(anime), user: username });

        if (!ApiClient.isAuthenticated()) {
            return this._storeLocally(payload, username, null);
        }

        try {
            const saved = normalizeAnime(await ApiClient.addAnime(payload));
            AnimeCache.update(username, saved, 'add');
            await this._mirror(username, saved);
            return { anime: saved, queued: false };
        } catch (error) {
            if (error instanceof ApiError && error.status === 0) {
                return this._storeLocally(payload, username, { method: 'POST', path: '/anime' });
            }
            throw error;
        }
    },

    async updateAnime(animeId, fields, username) {
        const current = AnimeCache.read(username).find((entry) => entry.id === animeId);

        if (!ApiClient.isAuthenticated()) {
            const merged = normalizeAnime({ ...current, ...fields, id: animeId, pending: true });
            AnimeCache.update(username, merged, 'update');
            return { anime: merged, queued: true };
        }

        try {
            const saved = normalizeAnime(await ApiClient.updateAnime(animeId, fields));
            AnimeCache.update(username, saved, 'update');
            await this._mirror(username, saved);
            return { anime: saved, queued: false };
        } catch (error) {
            if (error instanceof ApiError && error.status === 0) {
                const merged = normalizeAnime({ ...current, ...fields, id: animeId, pending: true });
                AnimeCache.update(username, merged, 'update');
                OfflineQueue.push(username, {
                    method: 'PUT',
                    path: `/anime/${animeId}`,
                    body: fields,
                    animeId,
                });
                return { anime: merged, queued: true };
            }
            throw error;
        }
    },

    /** Borra en el servidor y en la caché; devuelve lo necesario para deshacer. */
    async deleteAnime(animeId, username) {
        const previous = AnimeCache.read(username).find((entry) => entry.id === animeId) || null;
        AnimeCache.update(username, { id: animeId }, 'delete');

        if (!ApiClient.isAuthenticated()) {
            OfflineQueue.push(username, { method: 'DELETE', path: `/anime/${animeId}`, animeId });
            return { deleted: true, queued: true, previous };
        }

        try {
            await ApiClient.deleteAnime(animeId);
            firebase()?.deleteAnime(username, animeId)?.catch(() => {});
            return { deleted: true, queued: false, previous };
        } catch (error) {
            if (error instanceof ApiError && error.status === 0) {
                OfflineQueue.push(username, { method: 'DELETE', path: `/anime/${animeId}`, animeId });
                return { deleted: true, queued: true, previous };
            }
            AnimeCache.update(username, previous, 'add');
            throw error;
        }
    },

    /** Deshace un borrado: si estaba en cola, cancela la operación. */
    async restoreAnime(username, previous) {
        if (!previous) return { restored: false };

        if (OfflineQueue.read(username).some((entry) => entry.method === 'DELETE' && entry.animeId === previous.id)) {
            OfflineQueue.removeMatching(
                username,
                (entry) => entry.method === 'DELETE' && entry.animeId === previous.id,
            );
            AnimeCache.update(username, previous, 'add');
            return { restored: true, queued: true };
        }

        // `navigator.onLine === false` en vez de `!navigator.onLine`: si el navegador
        // no expone la propiedad, se asume conexión en vez de bloquear la cola.
        if (ApiClient.isAuthenticated() && navigator.onLine !== false) {
            const { id, user, updatedAt, pending, ...fields } = previous;
            const saved = normalizeAnime(await ApiClient.addAnime(fields));
            AnimeCache.update(username, saved, 'add');
            return { restored: true, queued: false, anime: saved };
        }

        AnimeCache.update(username, previous, 'add');
        OfflineQueue.push(username, { method: 'POST', path: '/anime', animeId: previous.id });
        return { restored: true, queued: true };
    },

    async refreshAnime(animeId, username) {
        const saved = normalizeAnime(await ApiClient.refreshAnime(animeId));
        AnimeCache.update(username, saved, 'update');
        return saved;
    },

    /** Reintenta la cola offline. Devuelve cuántas operaciones se sincronizaron. */
    async flushQueue(username) {
        if (!ApiClient.isAuthenticated() || navigator.onLine === false) {
            return { synced: 0, remaining: this.queueSize(username) };
        }

        const { synced, remaining } = await OfflineQueue.flush(username, async (entry) => {
            await ApiClient.request(entry.path, {
                method: entry.method,
                body: entry.body,
            });
        });

        if (synced > 0) await this.getAnimes(username);
        return { synced, remaining };
    },

    _storeLocally(payload, username, queueEntry) {
        const local = { ...payload, id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, pending: true };
        AnimeCache.update(username, local, 'add');
        if (queueEntry) {
            OfflineQueue.push(username, { ...queueEntry, body: writableFields(local), animeId: local.id });
        }
        return { anime: local, queued: true };
    },

    async _mirror(username, anime) {
        const service = firebase();
        if (!service) return;
        try {
            await service.addAnime(username, anime);
        } catch (error) {
            console.warn('Copia en Firebase fallida (no afecta a Flask):', error.message);
        }
    },
};