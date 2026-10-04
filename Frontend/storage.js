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
        return true;
    } catch (error) {
        console.warn('No se pudo escribir en localStorage:', error);
        return false;
    }
}

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
     * Reintenta las operaciones en orden. Se detiene en el primer fallo para no
     * descolocar la secuencia, y devuelve cuántas se sincronizaron.
     */
    async flush(username, send) {
        const queue = this.read(username);
        if (!queue.length) return { synced: 0, remaining: 0 };

        let synced = 0;
        const pending = [];

        for (const [index, entry] of queue.entries()) {
            try {
                await send(entry);
                synced += 1;
            } catch (error) {
                pending.push(...queue.slice(index));
                break;
            }
        }

        writeJSON(queueKey(username), pending);
        return { synced, remaining: pending.length };
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