/**
 * Capa de Web Storage: ajustes, caché local y cola de operaciones offline.
 *
 * El backend Flask sigue siendo la fuente de verdad. localStorage guarda la
 * copia de lectura y las mutaciones que no pudieron enviarse por red.
 */

const PREFIX = 'animelist_';
const SETTINGS_KEY = `${PREFIX}settings`;
const DEFAULT_SETTINGS = {
    theme: null,
    statusFilter: 'Todos',
    sortBy: 'updated',
    showAdult: false,
    /* Estado del panel de alta, del conmutador de vista y del filtro de texto.
       Se guardan para que recargar no devuelva la página a su estado de
       fábrica: el filtro en particular se perdía en cada recarga. */
    addPanelOpen: false,
    viewMode: 'grid',
    textFilter: '',
};

function readJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
    } catch (error) {
        return fallback;
    }
}

function writeJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        console.warn('No se pudo escribir en localStorage:', error);
        return false;
    }
    return true;
}

export { readJSON, writeJSON };

export const Settings = {
    all() {
        return { ...DEFAULT_SETTINGS, ...readJSON(SETTINGS_KEY, {}) };
    },

    get(key) {
        const settings = this.all();
        return settings[key] ?? DEFAULT_SETTINGS[key];
    },

    set(key, value) {
        const settings = this.all();
        settings[key] = value;
        writeJSON(SETTINGS_KEY, settings);
        return value;
    },
};

const animeKey = (username) => `${PREFIX}cache_${username}`;

export const AnimeCache = {
    read(username) {
        const list = readJSON(animeKey(username), []);
        return Array.isArray(list) ? list : [];
    },

    write(username, list) {
        writeJSON(animeKey(username), list);
    },

    /** Aplica add/update/delete sobre la caché sin tocar la red. */
    update(username, item, action) {
        const list = this.read(username);
        let next;

        if (action === 'add') {
            next = [item, ...list.filter((entry) => entry.id !== item.id)];
        } else if (action === 'update') {
            next = list.map((entry) => (entry.id === item.id ? { ...entry, ...item } : entry));
        } else if (action === 'delete') {
            next = list.filter((entry) => entry.id !== item.id);
        } else {
            next = list;
        }

        writeJSON(animeKey(username), next);
        return next;
    },

    clear(username) {
        localStorage.removeItem(animeKey(username));
    },
};

const queueKey = (username) => `${PREFIX}queue_${username}`;
const deadKey = (username) => `${PREFIX}dead_${username}`;

/**
 * ¿Un fallo se reintentará o se descarta?
 *
 * Reintentables: sin red (0), token caducado (401), límite de peticiones
 * (429) y cualquier 5xx. Todo lo demás (400, 403, 404…) es definitivo: la
 * misma operación fallará igual dentro de diez minutos, y dejarla en la cola
 * bloquearía las que vienen detrás.
 */
function isDefinitive(error) {
    const status = typeof error?.status === 'number' ? error.status : null;
    if (status === null || status === 0 || status === 401 || status === 429) return false;
    return status >= 400 && status < 500;
}

/** Un solo flush por usuario a la vez: dos a la vez enviarían lo mismo dos veces. */
const inFlight = new Map();

export const OfflineQueue = {
    read(username) {
        const queue = readJSON(queueKey(username), []);
        return Array.isArray(queue) ? queue : [];
    },

    push(username, operation) {
        const queue = this.read(username);
        const entry = {
            opId: `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date().toISOString(),
            ...operation,
        };
        writeJSON(queueKey(username), [...queue, entry]);
        return entry;
    },

    remove(username, opId) {
        writeJSON(queueKey(username), this.read(username).filter((entry) => entry.opId !== opId));
    },

    removeMatching(username, predicate) {
        writeJSON(queueKey(username), this.read(username).filter((entry) => !predicate(entry)));
    },

    size(username) {
        return this.read(username).length;
    },

    /**
     * Cambia el id local provisional por el id del servidor en las entradas
     * que quedan en la cola (paths y referencias). Sin esto, el PUT o el
     * DELETE que sigue a un POST sin conexión apuntan a `local_…`, el
     * servidor responde 404 y la cola se atasca para siempre.
     */
    remapId(username, oldId, newId, exceptOpId) {
        let changed = false;
        const next = this.read(username).map((entry) => {
            if (entry.opId === exceptOpId) return entry;
            if (entry.animeId !== oldId && !String(entry.path || '').includes(oldId)) return entry;
            changed = true;
            return {
                ...entry,
                animeId: entry.animeId === oldId ? newId : entry.animeId,
                path: String(entry.path || '').split(oldId).join(newId),
            };
        });
        if (changed) writeJSON(queueKey(username), next);
    },

    /* Operaciones que el servidor rechazó de forma definitiva. No vuelven a
       enviarse, pero no se tiran en silencio: `flush` las devuelve y la
       interfaz las cuenta, y aquí quedan para inspección. */
    readDead(username) {
        const dead = readJSON(deadKey(username), []);
        return Array.isArray(dead) ? dead : [];
    },

    pushDead(username, entry, error) {
        const dead = this.readDead(username);
        dead.push({
            ...entry,
            failedAt: new Date().toISOString(),
            failureStatus: typeof error?.status === 'number' ? error.status : null,
            failureReason: String(error?.message || error || 'Error desconocido'),
        });
        writeJSON(deadKey(username), dead);
        console.warn('Operación descartada de la cola offline:', entry.method, entry.path, error);
    },

    clearDead(username) {
        localStorage.removeItem(deadKey(username));
    },

    /**
     * Reintenta las operaciones en orden.
     *
     * - Cada entrada se borra de la cola en cuanto sale bien, no al final:
     *   un `push` hecho mientras se sincroniza ya no se pisa.
     * - Un fallo definitivo (4xx) manda la entrada a la dead-letter y sigue
     *   con la siguiente; uno reintentable (red, 5xx) para la ronda entera.
     * - Si ya hay un flush en vuelo para este usuario, se devuelve ese mismo
     *   promise en vez de empezar otro (evita POST duplicados).
     */
    flush(username, send) {
        const running = inFlight.get(username);
        if (running) return running;

        const run = this._flush(username, send).finally(() => inFlight.delete(username));
        inFlight.set(username, run);
        return run;
    },

    async _flush(username, send) {
        const initial = this.read(username);
        if (!initial.length) return { synced: 0, remaining: 0, failed: 0, syncedEntries: [] };

        let synced = 0;
        let failed = 0;
        const syncedEntries = [];

        for (const entry of initial) {
            // Releída en cada vuelta: una entrada puede haber desaparecido
            // mientras tanto (p. ej. el «Deshacer» de un borrado) o haber
            // cambiado (el remapeo de `local_…` al id del servidor tras un
            // POST). Con la copia del snapshot se enviaría el path viejo.
            const current = this.read(username).find((known) => known.opId === entry.opId);
            if (!current) continue;

            try {
                await send(current);
                this.remove(username, current.opId);
                synced += 1;
                syncedEntries.push(current);
            } catch (error) {
                if (isDefinitive(error)) {
                    this.remove(username, current.opId);
                    this.pushDead(username, current, error);
                    failed += 1;
                    continue;
                }
                break;
            }
        }

        return { synced, remaining: this.size(username), failed, syncedEntries };
    },
};

/** Notifica cambios de conexión y ejecuta una acción al recuperar la red. */
export function watchConnection({ onChange, onReconnect } = {}) {
    const report = () => onChange?.(navigator.onLine);

    window.addEventListener('online', () => {
        report();
        onReconnect?.();
    });
    window.addEventListener('offline', report);

    report();
    return () => {
        window.removeEventListener('online', report);
        window.removeEventListener('offline', report);
    };
}