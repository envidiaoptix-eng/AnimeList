/**
 * Tests de la cola offline (storage.js + data_repository.js).
 *
 * La cola es la parte con más riesgo de regresión del frontend: si falla,
 * se pierden operaciones del usuario o se atascan para siempre. Estos tests
 * la prueban con localStorage y fetch simulados, sin navegador:
 *
 *     node --test Backend/tests/offline_queue.test.mjs
 *
 * No necesita el venv de Python, solo Node.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* --------------------------------------------------------------- shims */

const backing = new Map();

globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => { backing.set(key, String(value)); },
    removeItem: (key) => { backing.delete(key); },
    clear: () => backing.clear(),
};

// api.js lee `location.protocol` al importarse para elegir la base de la API.
globalThis.location = { protocol: 'http:', pathname: '/dashboard.html', href: 'http://localhost/dashboard.html' };

// Ojo con `navigator`: en Node 22 ya existe y no tiene `onLine`. Los dos
// usos del código (`navigator.onLine === false` / `!== false`) tratan
// `undefined` como «en línea», que es el comportamiento que queremos aquí.

const FRONTEND = new URL('../../Frontend/', import.meta.url);
const { OfflineQueue, AnimeCache } = await import(new URL('storage.js', FRONTEND).href);
const { DataRepository } = await import(new URL('data_repository.js', FRONTEND).href);
const { ApiClient, ApiError } = await import(new URL('api.js', FRONTEND).href);

/* ------------------------------------------------------------- ayudas */

function clearUser(username) {
    for (const key of [...backing.keys()]) {
        if (key.includes(username)) backing.delete(key);
    }
    ApiClient.clearSession();
}

const jsonResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
});

const anEntry = (animeId, extra = {}) => ({
    method: 'POST',
    path: '/anime',
    body: { title: 'X', rating: 5 },
    animeId,
    ...extra,
});

/* ---------------------------------------------------------------- tests */

test('un segundo flush mientras hay uno en vuelo reutiliza el mismo promise', async () => {
    const user = 't_concurrente';
    clearUser(user);
    OfflineQueue.push(user, anEntry('a'));

    let calls = 0;
    const slowSend = async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
    };

    const [first, second] = await Promise.all([
        OfflineQueue.flush(user, slowSend),
        OfflineQueue.flush(user, slowSend),
    ]);

    assert.equal(calls, 1, 'la operación se envió dos veces: los POST salían duplicados');
    assert.equal(first.synced, 1);
    assert.equal(second.synced, 1);
    assert.equal(OfflineQueue.size(user), 0);
});

test('una operación encolada mientras se sincroniza no se pierde', async () => {
    const user = 't_push_durante';
    clearUser(user);
    OfflineQueue.push(user, anEntry('a'));

    let pushed = false;
    const send = async () => {
        if (!pushed) {
            pushed = true;
            OfflineQueue.push(user, anEntry('b', { method: 'PUT', path: '/anime/b' }));
        }
    };

    const result = await OfflineQueue.flush(user, send);

    assert.equal(result.synced, 1);
    assert.equal(result.remaining, 1, 'la entrada nueva debe seguir en la cola');
    assert.equal(OfflineQueue.read(user)[0].animeId, 'b');
});

test('un 400 se manda a la dead-letter y el resto sigue; una red caída para y conserva', async () => {
    const user = 't_politica';
    clearUser(user);
    OfflineQueue.push(user, anEntry('a'));
    OfflineQueue.push(user, anEntry('b'));
    OfflineQueue.push(user, anEntry('c'));

    const send = async (entry) => {
        if (entry.animeId === 'a') throw new ApiError('El título y la nota son obligatorios.', 400);
    };

    const result = await OfflineQueue.flush(user, send);

    assert.equal(result.synced, 2, 'la entrada fallida no debe bloquear las siguientes');
    assert.equal(result.failed, 1);
    assert.equal(OfflineQueue.size(user), 0);

    const dead = OfflineQueue.readDead(user);
    assert.equal(dead.length, 1);
    assert.equal(dead[0].animeId, 'a');
    assert.equal(dead[0].failureStatus, 400);

    // Ahora un fallo reintentable: se queda todo para la próxima.
    OfflineQueue.push(user, anEntry('d'));
    OfflineQueue.push(user, anEntry('e'));
    const retryable = await OfflineQueue.flush(user, async (entry) => {
        if (entry.animeId === 'd') throw new ApiError('No se pudo conectar con el servidor.', 0);
    });

    assert.equal(retryable.synced, 0);
    assert.equal(retryable.failed, 0);
    assert.equal(retryable.remaining, 2);
    assert.deepEqual(OfflineQueue.read(user).map((entry) => entry.animeId), ['d', 'e'],
        'las operaciones deben conservar el orden para la siguiente ronda');
});

test('remapId cambia el id local en la cola menos en la entrada que se acaba de enviar', () => {
    const user = 't_remap';
    clearUser(user);
    const sent = OfflineQueue.push(user, anEntry('local_1_abc'));
    OfflineQueue.push(user, anEntry('local_1_abc', { method: 'PUT', path: '/anime/local_1_abc' }));
    OfflineQueue.push(user, anEntry('otro_local', { method: 'DELETE', path: '/anime/otro_local' }));

    OfflineQueue.remapId(user, 'local_1_abc', 'srv_9', sent.opId);

    const queue = OfflineQueue.read(user);
    assert.equal(queue[0].animeId, 'local_1_abc', 'la enviada no se toca (se borra justo después)');
    assert.equal(queue[1].animeId, 'srv_9');
    assert.equal(queue[1].path, '/anime/srv_9');
    assert.equal(queue[2].path, '/anime/otro_local', 'otras entradas quedan como estaban');
});

test('añadir y editar sin conexión: al reconectar el PUT va al id del servidor', async () => {
    const user = 't_e2e_remap';
    clearUser(user);

    const added = await DataRepository.addAnime({ title: 'Frieren', rating: 9, status: 'Viendo' }, user);
    assert.equal(added.queued, true);
    assert.match(added.anime.id, /^local_/);

    const updated = await DataRepository.updateAnime(added.anime.id, { title: 'Frieren!', rating: 10 }, user);
    assert.equal(updated.queued, true);

    // Vuelve la sesión y la red.
    ApiClient.saveSession({ username: user, token: 'tok', expires_in: 3600, profile: null });

    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        const method = options.method || 'GET';
        requests.push(`${method} ${url}`);
        if (method === 'POST') {
            return jsonResponse({ message: 'Anime añadido.', anime: { id: 'srv_1', title: 'Frieren', rating: 9, user } }, 201);
        }
        if (method === 'PUT') {
            return jsonResponse({ message: 'Anime actualizado.', anime: { id: 'srv_1', title: 'Frieren!', rating: 10, user } });
        }
        return jsonResponse([{ id: 'srv_1', title: 'Frieren!', rating: 10, user }]);
    };

    const result = await DataRepository.flushQueue(user);

    assert.equal(result.failed, 0);
    assert.equal(result.synced, 2);
    assert.ok(requests.includes('PUT /api/anime/srv_1'),
        `el PUT apuntaba al id local y devolvía 404; peticiones: ${requests.join(', ')}`);
    assert.equal(OfflineQueue.size(user), 0, 'la cola debe quedar vacía');
    assert.equal(OfflineQueue.readDead(user).length, 0);

    const cache = AnimeCache.read(user);
    assert.equal(cache.length, 1);
    assert.equal(cache[0].id, 'srv_1', 'la caché debe quedarse con el id del servidor');
});

test('getAnimes no pisa con el servidor los cambios que siguen en la cola', async () => {
    const user = 't_overlay';
    clearUser(user);

    const added = await DataRepository.addAnime({ title: 'Bleach', rating: 8 }, user);
    assert.equal(added.queued, true);

    ApiClient.saveSession({ username: user, token: 'tok', expires_in: 3600, profile: null });
    // El servidor aún no tiene el anime: lo sigue sin él.
    globalThis.fetch = async () => jsonResponse([]);

    const list = await DataRepository.getAnimes(user);

    assert.equal(list.length, 1, 'el cambio pendiente desaparecía de la vista');
    assert.equal(list[0].title, 'Bleach');
    assert.equal(AnimeCache.read(user).length, 1);
});

test('sin sesión, addAnime y updateAnime encolan de verdad (queued no miente)', async () => {
    const user = 't_sin_sesion';
    clearUser(user);

    const added = await DataRepository.addAnime({ title: 'Hunter', rating: 9 }, user);
    assert.equal(added.queued, true);
    assert.equal(OfflineQueue.size(user), 1, 'addAnime devolvía queued sin encolar nada');

    const updated = await DataRepository.updateAnime(added.anime.id, { rating: 10 }, user);
    assert.equal(updated.queued, true);
    assert.equal(OfflineQueue.size(user), 2, 'updateAnime devolvía queued sin encolar nada');

    const methods = OfflineQueue.read(user).map((entry) => entry.method);
    assert.deepEqual(methods, ['POST', 'PUT']);
});

test('restoreAnime encola el POST con body (sin él, el backend respondía 400 para siempre)', async () => {
    const user = 't_restore';
    clearUser(user);

    AnimeCache.write(user, [{ id: 'srv_7', title: 'HxH', rating: 10, status: 'Completado', genres: [], episodes: '?' }]);
    const result = await DataRepository.restoreAnime(user, AnimeCache.read(user)[0]);

    assert.equal(result.queued, true);
    const entry = OfflineQueue.read(user).find((item) => item.method === 'POST');
    assert.ok(entry, 'restore sin red debe encolar el POST');
    assert.ok(entry.body && entry.body.title === 'HxH', 'al POST le falta el body');
});
