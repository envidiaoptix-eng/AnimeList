/**
 * Panel del usuario: lista, alta, edición, borrado con deshacer, filtros y
 * estadísticas. Habla con el repositorio, nunca directamente con el backend.
 */

import { ApiClient } from './api.js';
import { DataRepository } from './data_repository.js';
import { Settings, watchConnection } from './storage.js';
import { initThemeToggle } from './theme.js';
import { icon, hydrateIcons } from './icons.js';
import { confirmDialog, debounce, el, fallbackMeta, formatMeta, rankBadges, toast } from './ui.js';
import { initSearchModal, initAutocomplete } from './search_modal.js';
import {
    initProfileDialog,
    profileImageUrl,
    releaseAllImageUrls,
} from './profile.js';

const session = ApiClient.getSession();

// La redirección es asíncrona: el módulo sigue evaluándose, así que el resto del
// código debe tolerar `session === null` en vez de leer session.username a ciegas.
if (!session) location.replace('login.html');

const username = session?.username ?? '';

/* Cuya lista se pinta: la propia, salvo que la URL traiga `?user=amigo`.
   En ese caso la pantalla entra en modo solo lectura: sin alta, sin editar y
   sin cola offline, porque esos datos no son del visitante. */
const queryUser = (new URLSearchParams(location.search).get('user') || '').trim();
const viewUser = queryUser || username;
const isOwnList = viewUser === username;

const STATUSES = ['Pendiente', 'Viendo', 'Completado', 'Abandonado'];

/* El color del filo de la tarjeta sale de una variable CSS en vez de cuatro
   clases: el mismo estado aparece en la insignia, en la barra de reparto y en
   el borde, y así los tres leen siempre del mismo token. */
const STATUS_VAR = {
    Pendiente: '--status-pendiente',
    Viendo: '--status-viendo',
    Completado: '--status-completado',
    Abandonado: '--status-abandonado',
};

/* Cuántas tarjetas se animan al entrar. Más allá de esto el escalonado se
   percibe como retardo, no como ritmo. */
const ENTER_STAGGER_LIMIT = 12;

/* Nº de esqueletos durante la carga. */
const SKELETON_COUNT = 8;

/* La cascada de entrada solo tiene sentido en la primera pintada: a partir de
   ahí se apaga para que filtrar y ordenar no parezcan un parpadeo. */
let animateEnter = true;

const dom = {
    avatar: document.getElementById('user-avatar'),
    avatarFallback: document.getElementById('avatar-fallback'),
    menuName: document.getElementById('menu-name'),
    menuUsername: document.getElementById('menu-username'),
    userButton: document.getElementById('btn-user'),
    userMenu: document.getElementById('user-menu-panel'),
    offline: document.getElementById('offline-badge'),
    offlineText: document.getElementById('offline-text'),
    logout: document.getElementById('btn-logout'),
    header: document.querySelector('.app-header'),
    banner: document.getElementById('profile-banner'),

    addPanel: document.getElementById('add-panel'),
    addToggle: document.getElementById('add-toggle'),
    addBody: document.getElementById('add-body'),
    addBodyInner: document.getElementById('add-body-inner'),
    form: document.getElementById('form-anime'),
    title: document.getElementById('anime-title'),
    rating: document.getElementById('anime-rating'),
    status: document.getElementById('anime-status'),
    episodes: document.getElementById('anime-episodes'),
    synopsis: document.getElementById('anime-synopsis'),
    formStatus: document.getElementById('form-status'),
    cover: document.getElementById('cover-preview'),
    autocomplete: document.getElementById('autocomplete'),
    openSearch: document.getElementById('btn-open-search'),

    total: document.getElementById('stat-total'),
    completed: document.getElementById('stat-completed'),
    average: document.getElementById('stat-average'),
    episodesStat: document.getElementById('stat-episodes'),
    distribution: document.getElementById('distribution-rows'),

    chips: document.getElementById('status-chips'),
    filterText: document.getElementById('filter-text'),
    sortBy: document.getElementById('sort-by'),
    viewSwitch: document.getElementById('view-switch'),
    listCount: document.getElementById('list-count'),
    listTitleLabel: document.getElementById('list-title-label'),
    grid: document.getElementById('contenedor-animes'),
    listStatus: document.getElementById('list-status'),
    empty: document.getElementById('empty-state'),
    emptyTitle: document.getElementById('empty-title'),
    emptyText: document.getElementById('empty-text'),
    emptyAction: document.getElementById('empty-action'),
    export: document.getElementById('btn-export'),
    statsSection: document.getElementById('stats-section'),
    statTotalLabel: document.getElementById('stat-total-label'),

    viewBanner: document.getElementById('view-banner'),
    viewBannerName: document.getElementById('view-banner-name'),
    viewBannerMeta: document.getElementById('view-banner-meta'),
    viewForm: document.getElementById('view-user-form'),
    viewInput: document.getElementById('view-user-input'),
    viewSuggestions: document.getElementById('view-user-suggestions'),
    adminButton: document.getElementById('btn-admin'),
    friendsButton: document.getElementById('btn-friends'),
    viewFriendActions: document.getElementById('view-friend-actions'),
    wall: document.getElementById('wall'),
    wallForm: document.getElementById('wall-form'),
    wallText: document.getElementById('wall-text'),
    wallStatus: document.getElementById('wall-status'),
    wallList: document.getElementById('wall-list'),
    wallCount: document.getElementById('wall-count'),
    wallTarget: document.getElementById('wall-target'),
};

const state = {
    all: [],
    shown: [],
    editingId: null,
    statusFilter: Settings.get('statusFilter'),
    sortBy: Settings.get('sortBy'),
    viewMode: Settings.get('viewMode'),
    textFilter: Settings.get('textFilter') || '',
    /** Metadatos de la ficha elegida en el buscador, para el próximo alta. */
    picked: {},
    /** Perfil de la cuenta visitada; solo existe en modo lista ajena. */
    viewProfile: null,
};

const searchModal = initSearchModal({ onPick: fillForm });

/* ---------------------------------------------------------------- */
/* Cabecera                                                         */
/* ---------------------------------------------------------------- */

/**
 * Pinta cabecera y avatar con el perfil actual.
 *
 * Se relanza tras cada cambio del perfil, así que se apoya solo en
 * `session.profile` en lugar de guardar una copia aparte.
 *
 * En cadena: el arranque lanza una pintada con el perfil cacheado y el
 * refresco de `/api/me` otra con el perfil fresco, y sin ordenar la más
 * vieja podía terminar la última y dejar la cabecera obsoleta (además de
 * pedir el blob dos veces). La última en llegar pinta al final.
 *
 * El `<img>` y la inicial de reserva son los mismos dos nodos siempre, y solo
 * cambia cuál se ve. Antes se sustituían entre sí, lo que obligaba a
 * rebuscar el elemento en cada repintado y a vigilar que el sustituto
 * estuviera en el DOM.
 */
let renderChain = Promise.resolve();

function renderUser() {
    renderChain = renderChain.then(
        () => paintUser().catch((error) => console.warn('No se pudo pintar la cabecera:', error)),
    );
    return renderChain;
}

async function paintUser() {
    const profile = session.profile;
    const name = profile?.display_name || username;
    const initial = name.trim().charAt(0).toUpperCase() || '?';

    // El menú y el avatar son siempre de la sesión: son los que abren «Mi
    // perfil» y «Salir». Banner y fondo, en cambio, son los de la cuenta cuya
    // lista se está mirando, que es lo que da contexto a la pantalla.
    dom.menuName.textContent = name;
    dom.menuUsername.textContent = `@${username}`;
    dom.avatarFallback.textContent = initial;
    // El botón de administración se decide con el perfil de la sesión, que es
    // lo que trae `is_admin` de `/api/me` (el token no lleva el rol).
    dom.adminButton.hidden = !Boolean(session.profile?.is_admin);

    const pageProfile = isOwnList ? profile : state.viewProfile;
    await paintBanner(pageProfile);
    await paintPageBackground(pageProfile);

    // El `<img>` y la inicial son los mismos dos nodos de siempre, y solo cambia
    // cuál se ve. `#avatar-fallback` no se ocultaba en ningún sitio, así que con
    // foto los dos acababan visibles dentro del botón de 38px: al no haber
    // `grid-template` caían en dos filas implícitas y desbordaban el círculo.
    let url = '';
    try {
        url = await profileImageUrl('avatar', profile);
    } catch {
        // Si la imagen no se puede pedir, se muestra la inicial de reserva.
        url = '';
    }

    dom.avatarFallback.hidden = Boolean(url);

    if (url) {
        dom.avatar.src = url;
        dom.avatar.alt = `Foto de ${name}`;
        dom.avatar.hidden = false;
    } else {
        dom.avatar.hidden = true;
        dom.avatar.removeAttribute('src');
    }
}

/**
 * Envuelve una URL en `url("...")`. Las comillas y la barra invertida se
 * escapan porque `background-image` no entiende de JSON: una URL con una comilla
 * sin escapar rompe la regla entera y el `body` se queda sin fondo del todo.
 */
const cssUrl = (value) => `"${value.replace(/[\\"]/g, '\\$&')}"`;

/**
 * Object URL de las imágenes de una cuenta ajena.
 *
 * La propia pasa por la caché de `profile.js`, que vive toda la sesión y es
 * la que usa también el diálogo de perfil. La de otro usuario se pide aquí y
 * se guarda aparte: si compartieran la caché, mirar el banner de un amigo y
 * abrir después «Mi perfil» mostraría la foto de él como si fuera la tuya.
 */
const viewImageUrls = new Map();

async function viewImageUrl(kind, profile) {
    if (!profile) return '';

    const external = profile[`${kind}_url`];
    if (external) return external;
    if (!profile[`has_${kind}`]) return '';

    try {
        const blob = await ApiClient.fetchProfileImage(kind, profile.username);
        const url = URL.createObjectURL(blob);
        const previous = viewImageUrls.get(kind);
        if (previous) URL.revokeObjectURL(previous);
        viewImageUrls.set(kind, url);
        return url;
    } catch {
        // Sin esa imagen la página se queda con el fondo del tema.
        return '';
    }
}

function releaseViewImageUrls() {
    for (const url of viewImageUrls.values()) URL.revokeObjectURL(url);
    viewImageUrls.clear();
}

/** Imagen de la página: la de la sesión, o la de la cuenta visitada. */
const pageImageUrl = (kind, profile) => (isOwnList ? profileImageUrl(kind, profile) : viewImageUrl(kind, profile));

/**
 * Pinta el fondo de pagina del usuario.
 *
 * Va como variable en `:root` en vez de como `background-image` directo para no
 * tocar la regla de `body` de `base.css`, que comparten la portada, el acceso y
 * el login. La clase `has-page-bg` es la que activa el velo, y solo la define
 * `dashboard.css`, asi que esas paginas no lo heredan ni aunque la variable
 * llegara a estar puesta.
 */
async function paintPageBackground(profile) {
    let url = '';
    try {
        url = await pageImageUrl('background', profile);
    } catch {
        // Sin el fichero no hay objeto que pintar: se deja el fondo del tema.
        url = '';
    }

    if (url) {
        document.documentElement.style.setProperty('--page-bg', `url(${cssUrl(url)})`);
        document.body.classList.add('has-page-bg');
    } else {
        document.documentElement.style.removeProperty('--page-bg');
        document.body.classList.remove('has-page-bg');
    }
}

async function paintBanner(profile) {
    let url = '';
    try {
        url = await pageImageUrl('banner', profile);
    } catch {
        url = '';
    }

    if (url) {
        dom.banner.src = url;
        dom.banner.alt = '';
        dom.banner.hidden = false;
        dom.header.classList.add('has-banner');
    } else {
        dom.banner.hidden = true;
        dom.banner.removeAttribute('src');
        dom.header.classList.remove('has-banner');
    }
}

function setOffline(isOffline) {
    dom.offline.hidden = !isOffline;

    const queued = DataRepository.queueSize(username);
    dom.offlineText.textContent = isOffline && queued > 0
        ? `Sin conexión · ${queued} pendiente${queued === 1 ? '' : 's'}`
        : 'Sin conexión';
}

/**
 * Vuelve a pintar el badge tras una escritura. Sin esto, encolar un cambio con el
 * navegador ya en "sin conexión" no actualizaba el contador de pendientes.
 */
function refreshPending() {
    const online = typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
    setOffline(!online);
}

/* ---------------------------------------------------------------- */
/* Datos                                                            */
/* ---------------------------------------------------------------- */

async function load() {
    dom.grid.replaceChildren(
        ...Array.from({ length: SKELETON_COUNT }, () => el('div', { class: 'skeleton skeleton--card' })),
    );

    try {
        state.all = await DataRepository.getAnimes(viewUser);
        applyView();
        renderStats();
        renderViewBanner();
        // La cola offline es de la sesión, no de la cuenta visitada: volcarla
        // mientras se mira una lista ajena escribiría sobre la lista propia.
        if (isOwnList) await syncQueue();
    } catch (error) {
        dom.grid.replaceChildren();
        if (!isOwnList && error?.status === 404) {
            toast(`No existe ningún usuario llamado “${viewUser}”.`, { type: 'error' });
            location.replace('dashboard.html');
            return;
        }
        toast(error.message || 'No se pudo cargar tu lista.', { type: 'error' });
    }
}

/**
 * Rellena la banda superior cuando se mira la lista de otra cuenta.
 *
 * El contador sale de `state.all`, que es lo que de verdad se está pintando;
 * el nombre visible puede llegar después (el perfil se pide en paralelo), así
 * que esta función se vuelve a llamar cuando cae.
 */
function renderViewBanner() {
    if (isOwnList) return;

    const profile = state.viewProfile;
    const displayName = profile?.display_name;
    dom.viewBannerName.textContent = displayName && displayName !== viewUser
        ? `${displayName} (@${viewUser})`
        : `@${viewUser}`;
    dom.viewBannerMeta.textContent = `${state.all.length} anime${state.all.length === 1 ? '' : 's'} en su lista`;
    dom.viewBanner.hidden = false;
    renderFriendActions();
}

/**
 * Botón de amistad en la banda de lista ajena.
 *
 * El estado (`none`, `outgoing`, `incoming`, `friend`) lo trae
 * `GET /api/users/<target>` en `state.viewProfile.friendship`; aquí solo se
 * pinta la acción que corresponde. Tras cada operación el servidor devuelve el
 * estado nuevo (`response.state`), así que se refleja sin volver a pedir el
 * perfil. Si aún no llegó el perfil, no se pinta nada: el botón nunca debe
 * adivinar el estado.
 */
function renderFriendActions() {
    if (isOwnList) return;
    const box = dom.viewFriendActions;
    const friendship = state.viewProfile?.friendship;
    box.replaceChildren();
    box.hidden = !friendship || friendship === 'self';

    if (box.hidden) return;

    /** Aplica `response.state` al perfil pintado y repinta la banda. */
    const apply = (response) => {
        if (state.viewProfile && response?.state) {
            state.viewProfile.friendship = response.state;
        }
        renderFriendActions();
    };

    const call = async (action, successMessage) => {
        try {
            const response = await action();
            if (successMessage) toast(successMessage, { type: 'success' });
            apply(response);
        } catch (error) {
            toast(error.message || 'No se ha podido completar la operación.', { type: 'error' });
        }
    };

    if (friendship === 'none') {
        box.append(el('button', {
            class: 'btn btn--primary btn--sm',
            type: 'button',
            text: 'Añadir amigo',
            onClick: () => call(
                () => ApiClient.sendFriendRequest(viewUser),
                `Solicitud enviada a ${viewUser}.`,
            ),
        }));
    } else if (friendship === 'outgoing') {
        box.append(el('button', {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            text: 'Solicitud enviada · Retirar',
            onClick: () => call(
                () => ApiClient.rejectFriendRequest(viewUser),
                'Solicitud retirada.',
            ),
        }));
    } else if (friendship === 'incoming') {
        box.append(
            el('button', {
                class: 'btn btn--primary btn--sm',
                type: 'button',
                text: 'Aceptar solicitud',
                onClick: () => call(
                    () => ApiClient.acceptFriendRequest(viewUser),
                    `Ahora sois amigos de ${viewUser}.`,
                ),
            }),
            el('button', {
                class: 'btn btn--ghost btn--sm',
                type: 'button',
                text: 'Rechazar',
                onClick: () => call(
                    () => ApiClient.rejectFriendRequest(viewUser),
                    'Solicitud rechazada.',
                ),
            }),
        );
    } else if (friendship === 'friend') {
        box.append(el('button', {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            text: 'Sois amigos · Dejar de serlo',
            onClick: async () => {
                const confirmed = await confirmDialog({
                    title: 'Eliminar amistad',
                    message: `¿Dejar de ser amigo de ${viewUser}?`,
                    confirmLabel: 'Eliminar',
                    danger: true,
                });
                if (!confirmed) return;
                await call(() => ApiClient.removeFriend(viewUser),
                    `Ya no eres amigo de ${viewUser}.`);
            },
        }));
    }
}

/* ---------------------------------------------------------------- */
/* Muro de comentarios de la lista ajena                             */
/* ---------------------------------------------------------------- */

const wall = {
    comments: [],

    /** Pide el muro de la cuenta visitada y lo repinta. */
    async load() {
        dom.wallList.replaceChildren();
        dom.wallStatus.textContent = 'Cargando comentarios…';
        dom.wallStatus.classList.remove('is-error');
        try {
            const data = await ApiClient.listComments({ target: viewUser });
            this.comments = data.comments || [];
            this.render();
        } catch (error) {
            dom.wallStatus.textContent = error.message || 'No se pudieron cargar los comentarios.';
            dom.wallStatus.classList.add('is-error');
        }
    },

    render() {
        const total = this.comments.length;
        dom.wallCount.textContent = String(total);

        if (!total) {
            dom.wallList.replaceChildren(el('p', {
                class: 'wall-empty',
                text: `Todavía no hay comentarios en la lista de ${viewUser}.`,
            }));
            dom.wallStatus.textContent = '';
            return;
        }

        dom.wallList.replaceChildren(...this.comments.map((comment) => this.row(comment)));
        hydrateIcons(dom.wallList);
        dom.wallStatus.textContent = '';
    },

    row(comment) {
        const mine = comment.user === username;
        const canDelete = mine || Boolean(session?.profile?.is_admin);
        const when = comment.created_at ? comment.created_at.slice(0, 10) : '';

        return el('article', { class: 'wall-comment', dataset: { id: comment.id } },
            el('div', { class: 'wall-comment__body' },
                el('p', { class: 'wall-comment__meta' },
                    el('span', {
                        class: 'wall-comment__author',
                        text: comment.display_name || comment.user,
                    }),
                    el('span', { text: `@${comment.user}` }),
                    when ? el('span', { text: when }) : null,
                ),
                el('p', { class: 'wall-comment__text', text: comment.text }),
            ),
            // El backend decide quién puede borrar (autor o admin); el botón
            // solo evita el viaje a quien ya sabe que no podrá.
            canDelete ? el('button', {
                class: 'icon-btn',
                type: 'button',
                'aria-label': 'Borrar comentario',
                onClick: async () => {
                    const confirmed = await confirmDialog({
                        title: 'Borrar comentario',
                        message: '¿Eliminar este comentario?',
                        confirmLabel: 'Borrar',
                        danger: true,
                    });
                    if (!confirmed) return;
                    try {
                        await ApiClient.deleteComment(comment.id);
                        toast('Comentario eliminado.', { type: 'success' });
                        this.comments = this.comments.filter((c) => c.id !== comment.id);
                        this.render();
                    } catch (error) {
                        toast(error.message || 'No se pudo borrar el comentario.', { type: 'error' });
                    }
                },
            }, icon('trash', { size: 16 })) : null,
        );
    },

    /** Publica en el muro y recarga; los errores 400/429 salen como aviso. */
    async submit(text) {
        dom.wallStatus.classList.remove('is-error');
        try {
            await ApiClient.addComment({ text, target: viewUser });
            dom.wallText.value = '';
            await this.load();
        } catch (error) {
            dom.wallStatus.textContent = error.message || 'No se pudo publicar el comentario.';
            dom.wallStatus.classList.add('is-error');
        }
    },
};

/**
 * Vuelca la cola offline y recarga si había algo pendiente.
 *
 * Con guarda de reentrada: el arranque y la recuperación de red la lanzan a la
 * vez, y dos vuelcos simultáneos enviarían las mismas operaciones dos veces
 * (el lock de `OfflineQueue.flush` ya no las duplica, pero el repintado y el
 * toast se dispararían igualmente dos veces).
 */
let syncing = false;

async function syncQueue() {
    if (syncing) return;
    syncing = true;

    try {
        const { synced, failed, touchedProfile } = await DataRepository.flushQueue(username);

        // Una operación rechazada de forma definitiva por el servidor ya no se
        // reintentará: se avisa, no se pierde en silencio.
        if (failed > 0) {
            toast(
                `${failed} cambio${failed === 1 ? '' : 's'} sin conexión no se pudo enviar y se descartó.`,
                { type: 'error' },
            );
        }

        if (!synced) return;

        state.all = await DataRepository.getAnimes(username);
        applyView();
        renderStats();

        // La cola también puede llevar el nombre visible. Si salió, la cabecera
        // sigue enseñando el viejo hasta que se recargue la página.
        if (touchedProfile) {
            session.profile = await ApiClient.getProfile().catch(() => session.profile);
            await renderUser();
        }

        toast(`${synced} cambio${synced === 1 ? '' : 's'} sincronizado${synced === 1 ? '' : 's'}.`, {
            type: 'success',
        });
    } catch (error) {
        // Antes este `await` suelto (en el `online` de abajo) dejaba un
        // rechazo no manejado en la consola sin decirle nada al usuario.
        console.warn('No se pudo sincronizar la cola offline:', error);
        toast(error.message || 'No se pudo sincronizar la cola pendiente.', { type: 'error' });
    } finally {
        syncing = false;
    }
}

/* ---------------------------------------------------------------- */
/* Exportar                                                        */
/* ---------------------------------------------------------------- */

/** Campos del CSV, en orden. Los que no existan en un anime salen vacíos. */
const EXPORT_COLUMNS = [
    'title',
    'title_native',
    'title_english',
    'status',
    'rating',
    'episodes',
    'format',
    'year',
    'genres',
    'synopsis',
];

/**
 * Escapa una celda de CSV.
 *
 * El separador es `;` y no `,` porque en configuración española la coma es el
 * separador decimal: con `,` Excel abriría las columnas donde toca. Entre
 * comillas van el separador, las comillas y los saltos de línea.
 */
function csvCell(value) {
    if (Array.isArray(value)) value = value.join(', ');
    const text = value === null || value === undefined ? '' : String(value);
    return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Dispara la descarga de un texto como fichero.
 *
 * El object URL se revoca en un `setTimeout` y no de inmediato: al revocarlo en
 * el mismo turno, algunos navegadores recortan la descarga a cero bytes.
 */
function download(filename, mime, content) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const link = el('a', { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Exporta la lista completa.
 *
 * Se lee de `state.all` y no de la lista ya filtrada: al exportar se espera la
 * lista entera, no lo que haya en pantalla en ese momento. Se recurre al
 * repositorio si todavía no se ha cargado nada.
 */
async function exportList(format) {
    const list = state.all.length ? state.all : await DataRepository.getAnimes(username);

    if (!list.length) {
        toast('Tu lista está vacía: no hay nada que exportar.', { type: 'info' });
        return;
    }

    const base = `animelist-${username}-${stamp()}`;

    if (format === 'json') {
        download(`${base}.json`, 'application/json;charset=utf-8', JSON.stringify(list, null, 2));
    } else {
        const rows = list.map((anime) => EXPORT_COLUMNS.map((key) => csvCell(anime[key])).join(';'));
        // BOM UTF-8: sin él, Excel en español abre los acentos como caracteres
        // raros, porque la hoja asume la codificación local.
        download(`${base}.csv`, 'text/csv;charset=utf-8', `\uFEFF${EXPORT_COLUMNS.join(';')}\r\n${rows.join('\r\n')}\r\n`);
    }

    const pending = list.filter((anime) => anime.pending).length;
    toast(`Exportados ${list.length} anime.` + (pending ? ` ${pending} aún sin sincronizar.` : ''), {
        type: 'success',
    });
}

function visible() {
    const term = state.textFilter.trim().toLowerCase();

    const filtered = state.all.filter((anime) => {
        if (state.statusFilter !== 'Todos' && anime.status !== state.statusFilter) return false;
        if (!term) return true;

        return [anime.title, anime.title_native, anime.title_english, ...(anime.genres || [])]
            .filter(Boolean)
            .some((field) => field.toLowerCase().includes(term));
    });

    const collator = new Intl.Collator('es', { sensitivity: 'base' });
    const episodeCount = (anime) => (typeof anime.episodes === 'number' ? anime.episodes : -1);

    const sorters = {
        updated: (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''),
        rating: (a, b) => b.rating - a.rating,
        title: (a, b) => collator.compare(a.title || '', b.title || ''),
        episodes: (a, b) => episodeCount(b) - episodeCount(a),
    };

    return [...filtered].sort(sorters[state.sortBy] || sorters.updated);
}

/**
 * Resumen: cuatro cifras y el reparto por estado.
 *
 * Todo se calcula en el cliente sobre `state.all`. El backend tiene
 * `/api/stats`, pero consultarlo sería una segunda fuente de verdad para los
 * mismos números, y aquí ya están en memoria.
 */
function renderStats() {
    const ratings = state.all.map((anime) => anime.rating).filter((value) => typeof value === 'number');
    const episodes = state.all.reduce(
        (sum, anime) => sum + (typeof anime.episodes === 'number' ? anime.episodes : 0),
        0,
    );

    dom.total.textContent = state.all.length;
    dom.completed.textContent = state.all.filter((anime) => anime.status === 'Completado').length;
    dom.average.textContent = ratings.length
        ? (ratings.reduce((sum, value) => sum + value, 0) / ratings.length).toFixed(1)
        : '–';
    dom.episodesStat.textContent = episodes || '–';

    renderDistribution();
}

/**
 * Una barra por estado, con la proporción sobre el total.
 *
 * El relleno lleva `--i` para que las barras crezcan en cascada; la animación
 * se reinicia en cada repintado, así que reordenar no las deja a medias.
 */
function renderDistribution() {
    const total = state.all.length;

    const rows = STATUSES.map((status, index) => {
        const count = state.all.filter((anime) => anime.status === status).length;
        const share = total ? Math.round((count / total) * 100) : 0;

        return el('div', { class: 'distribution__row' },
            el('span', { class: 'distribution__name' },
                el('span', { class: 'status-dot', style: `color: var(${STATUS_VAR[status]})`, 'aria-hidden': 'true' }),
                el('span', { text: status }),
            ),
            el('span', {
                class: 'distribution__track',
                role: 'img',
                'aria-label': `${status}: ${count} de ${total}`,
            },
            el('span', {
                class: 'distribution__fill',
                style: `width: ${share}%; color: var(${STATUS_VAR[status]}); animation-delay: ${index * 60}ms`,
            })),
            el('span', { class: 'distribution__value', text: `${count}` }),
        );
    });

    dom.distribution.replaceChildren(...rows);
}

/* ---------------------------------------------------------------- */
/* Tarjetas                                                         */
/* ---------------------------------------------------------------- */

/** Portada de la ficha, o su inicial si AniList y Kitsu no trajeron imagen. */
function coverNode(anime) {
    const title = anime.title || '?';
    const fallback = () => el('div', {
        class: 'cover-empty',
        'aria-hidden': 'true',
    }, el('span', { class: 'cover-empty__letter', text: title.charAt(0) }));

    if (!anime.cover_url) return fallback();

    return el('img', {
        src: anime.cover_url,
        alt: `Portada de ${title}`,
        loading: 'lazy',
        decoding: 'async',
        onError: (event) => event.target.replaceWith(fallback()),
    });
}

/** Aplica el color del estado como variable, de donde lo leen el filo y la insignia. */
function paintStatus(node, anime) {
    const variable = STATUS_VAR[anime.status];
    if (variable) node.style.setProperty('--status-color', `var(${variable})`);
    return node;
}

function ratingNode(anime, { withSuffix = true } = {}) {
    return el('span', { class: 'rating' },
        icon('star', { size: 15 }),
        el('span', { text: String(anime.rating) }),
        withSuffix ? el('span', { class: 'rating__suffix', text: '/10' }) : null,
    );
}

function statusBadge(anime, extra = '') {
    return el('span', {
        class: `badge badge--dot ${extra} badge--${anime.status}`.trim(),
        text: anime.status,
    });
}

function actionsRow(anime) {
    return el('div', { class: 'card__foot' },
        el('span', { class: 'card__foot-left' },
            ratingNode(anime),
            isOwnList && DataRepository.isPending(username, anime.id)
                ? el('span', { class: 'badge badge--pending', text: 'pendiente' })
                : null,
        ),
        el('div', { class: 'card__actions' }, ...actionButtons(anime)),
    );
}

function cardNode(anime) {
    const isEditing = state.editingId === anime.id;

    const card = el('article', {
        class: `card${isEditing ? ' card--editing' : ''}`,
        role: 'listitem',
        dataset: { id: anime.id },
    });

    const cover = paintStatus(el('div', { class: 'card__cover' },
        coverNode(anime),
        statusBadge(anime, 'badge--cover'),
    ), anime);
    if (anime.cover_color) cover.style.backgroundColor = anime.cover_color;

    card.append(cover, el('div', { class: 'card__body' },
        el('h3', { class: 'card__title', text: anime.title }),
        rankRow(anime),
        el('p', { class: 'card__meta', text: formatMeta(anime) }),
        anime.synopsis ? el('p', { class: 'card__synopsis', text: anime.synopsis }) : null,
        (anime.genres || []).length
            ? el('div', { class: 'card__genres' },
                ...anime.genres.slice(0, 3).map((genre) => el('span', { class: 'tag', text: genre })))
            : null,
        externalLink(anime),
    ));

    card.appendChild(isEditing ? editForm(anime) : actionsRow(anime));
    return card;
}

/**
 * La misma ficha en horizontal, para quien prefiera leer la lista en vez de
 * recorrer un muro de portadas. Comparte metadatos y etiquetas con la tarjeta,
 * pero no repite el bloque de edicion: se reutiliza `editForm` igual que en
 * rejilla para que ambos modos guarden exactamente lo mismo.
 */
function listRow(anime) {
    const isEditing = state.editingId === anime.id;

    const row = el('article', {
        class: `row${isEditing ? ' row--editing' : ''}`,
        role: 'listitem',
        dataset: { id: anime.id },
    });

    if (!isEditing) {
        const cover = paintStatus(el('div', { class: 'row__cover' }, coverNode(anime)), anime);
        if (anime.cover_color) cover.style.backgroundColor = anime.cover_color;

        row.append(cover, el('div', { class: 'row__main' },
            el('div', { class: 'row__head' },
                el('h3', { class: 'row__title', text: anime.title }),
                el('span', { class: 'row__meta', text: formatMeta(anime) }),
            ),
            rankRow(anime),
            anime.synopsis ? el('p', { class: 'row__synopsis', text: anime.synopsis }) : null,
            (anime.genres || []).length
                ? el('div', { class: 'row__genres' },
                    ...anime.genres.slice(0, 4).map((genre) => el('span', { class: 'tag', text: genre })))
                : null,
        ));

        const aside = el('div', { class: 'row__aside' });
        if (anime.anilist_id || anime.kitsu_id) aside.appendChild(externalLink(anime, 'row__link'));
        aside.appendChild(ratingNode(anime, { withSuffix: false }));

        if (isOwnList && DataRepository.isPending(username, anime.id)) {
            aside.appendChild(el('span', { class: 'badge badge--pending', text: 'pendiente' }));
        }

        aside.append(...actionButtons(anime));
        row.appendChild(aside);
    }

    if (isEditing) row.appendChild(editForm(anime));
    return row;
}

/** Los dos botones de acción de la ficha, sueltos para reusar en ambos modos. */
function actionButtons(anime) {
    // En lista ajena no hay nada que hacer: editar y borrar son de la dueña
    // de la lista (o del admin, que entra por su propio camino en la
    // administración). Sin botones no hay formulario de edición que abrir.
    if (!isOwnList) return [];

    const button = (action, glyph, label, extra) => el('button', {
        class: `icon-btn ${extra}`.trim(),
        type: 'button',
        title: label,
        'aria-label': `${label} ${anime.title}`,
        dataset: { action },
    }, icon(glyph, { size: 17 }));

    return [
        button('edit', 'pencil', 'Editar', ''),
        button('delete', 'trash', 'Eliminar', 'icon-btn--danger'),
    ];
}

/**
 * Las dos insignias de "toda la historia" de AniList. Sin rankings se cae al
 * resumen de Kitsu (nota media y usuarios en sus listas), porque Kitsu no
 * publica posiciones y conviene decirlo antes de dejar la ficha sin nada.
 */
function rankRow(anime) {
    const badges = rankBadges(anime);
    if (badges.length) {
        return el('div', { class: 'rank-list' },
            ...badges.map((badge) => el('span', {
                class: 'rank-badge',
                title: badge.title,
                dataset: { rankContext: badge.context },
            },
            el('span', { class: 'rank-badge__num', text: `#${badge.rank}` }),
            el('span', { class: 'rank-badge__label', text: badge.label }))));
    }

    const nota = fallbackMeta(anime);
    return nota ? el('p', { class: 'rank-note', text: nota }) : null;
}

function externalLink(anime, extra = '') {
    if (!anime.anilist_id && !anime.kitsu_id) return null;

    const link = el('a', {
        class: `card__link ${extra}`.trim(),
        href: anime.anilist_id
            ? `https://anilist.co/anime/${anime.anilist_id}`
            : `https://kitsu.io/anime/${anime.kitsu_id}`,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: 'Ver la ficha en la fuente',
    }, icon('external-link', { size: 13 }), el('span', { text: 'Ver ficha' }));

    return link;
}

function editForm(anime) {
    const form = el('form', { class: 'card-edit', novalidate: true });

    /* Los ids salen del id del anime para que no choquen: solo se edita una
       ficha a la vez, pero el enlace `label[for]` tiene que ser único en el
       documento y puede haber más de un formulario de este en el árbol. */
    const fieldId = (name) => `edit-${anime.id}-${name}`;

    const titleInput = el('input', {
        id: fieldId('title'), type: 'text', value: anime.title, maxlength: '200', required: true,
    });
    const ratingInput = el('input', {
        id: fieldId('rating'), type: 'number', min: '1', max: '10', value: String(anime.rating), required: true,
    });
    const statusSelect = el('select', { id: fieldId('status') },
        ...STATUSES.map((value) => el('option', { value, text: value, selected: value === anime.status })),
    );
    const episodesInput = el('input', {
        id: fieldId('episodes'),
        type: 'text',
        inputmode: 'numeric',
        value: anime.episodes === '?' || anime.episodes == null ? '' : String(anime.episodes),
    });
    const synopsisInput = el('textarea', {
        id: fieldId('synopsis'), rows: '3', maxlength: '2000',
    });
    synopsisInput.value = anime.synopsis || '';

    const field = (name, label, control) => el('div', { class: 'field' },
        el('label', { for: fieldId(name), text: label }),
        control,
    );

    form.append(
        field('title', 'Título', titleInput),
        el('div', { class: 'card-edit__row' },
            field('rating', 'Nota', ratingInput),
            field('status', 'Estado', statusSelect),
        ),
        field('episodes', 'Episodios', episodesInput),
        field('synopsis', 'Sinopsis', synopsisInput),
        el('div', { class: 'card-edit__actions' },
            el('button', {
                class: 'btn btn--ghost btn--sm',
                type: 'button',
                text: 'Cancelar',
                dataset: { action: 'cancel' },
            }),
            el('button', { class: 'btn btn--primary btn--sm', type: 'submit', text: 'Guardar' }),
        ),
    );

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const rating = Number(ratingInput.value);
        const title = titleInput.value.trim();

        if (!title) {
            toast('El título no puede quedar vacío.', { type: 'error' });
            titleInput.focus();
            return;
        }
        if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
            toast('La nota debe ser un entero entre 1 y 10.', { type: 'error' });
            ratingInput.focus();
            return;
        }

        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;

        try {
            const { anime: saved, queued } = await DataRepository.updateAnime(anime.id, {
                title,
                rating,
                status: statusSelect.value,
                episodes: toEpisodes(episodesInput.value),
                synopsis: synopsisInput.value.trim(),
            }, username);

            state.editingId = null;
            replaceInList(saved);
            applyView();
            renderStats();
            refreshPending();

            toast(queued ? 'Cambios guardados en local; se enviarán al recuperar la red.' : 'Anime actualizado.', {
                type: queued ? 'info' : 'success',
            });
        } catch (error) {
            submit.disabled = false;
            toast(error.message || 'No se pudo actualizar.', { type: 'error' });
        }
    });

    return form;
}

/* ---------------------------------------------------------------- */
/* Render principal                                                 */
/* ---------------------------------------------------------------- */

/**
 * Pinta la lista visible.
 *
 * Reconcilia por `data-id` en vez de tirar el contenedor entero. Antes cada
 * cambio de filtro u orden reconstruía N artículos desde cero: con cien
 * fichas eso son cien portadas que vuelven a pedir su imagen y cien
 * animaciones de entrada, y el salto se nota sobre todo al ordenar.
 *
 * Reutilizando los nodos, el navegador solo mueve lo que cambia de sitio y
 * las rutas siguen vivas.
 */
function applyView() {
    state.shown = visible();

    const isList = state.viewMode === 'list';
    const build = isList ? listRow : cardNode;

    dom.grid.className = isList ? 'rows' : 'cards';
    dom.listCount.textContent = state.shown.length;

    // Índice de lo que ya está pintado, para no recrear lo que no cambia.
    const existing = new Map();
    for (const node of dom.grid.children) {
        if (node.dataset?.id) existing.set(node.dataset.id, node);
    }

    const entered = [];

    const next = state.shown.map((anime, index) => {
        const current = existing.get(anime.id);

        if (!current) {
            const fresh = build(anime);

            // La cascada solo en la primera pintada: aplicarla en cada
            // repintado convierte filtrar en un parpadeo, no en una animación.
            if (animateEnter && index < ENTER_STAGGER_LIMIT) {
                fresh.style.setProperty('--i', index);
                fresh.classList.add('card--enter');
                entered.push(fresh);
            }

            return fresh;
        }

        existing.delete(anime.id);

        // Solo se reconstruye lo que de verdad difiere: cambiar de modo de
        // vista, o entrar o salir del modo edición.
        const editing = state.editingId === anime.id;
        const wrongMode = current.classList.contains('card') !== !isList;
        // La clase de edición depende del modo: en lista es `row--editing`.
        // Comprobando siempre `card--editing`, el formulario de la vista lista
        // se reconstruía en cada repintado y se perdía lo tecleado.
        const wrongEditing = current.classList.contains(isList ? 'row--editing' : 'card--editing') !== editing;

        return wrongMode || wrongEditing ? build(anime) : current;
    });

    dom.grid.replaceChildren(...next);

    // La clase de animación se retira en el siguiente fotograma: dejarla puesta
    // pisaría cualquier `animation` legítima que se añada más adelante.
    if (entered.length) {
        requestAnimationFrame(() => {
            for (const node of entered) node.classList.remove('card--enter');
        });
        animateEnter = false;
    }

    dom.empty.hidden = state.shown.length > 0;
    if (state.shown.length === 0) {
        const hasAny = state.all.length > 0;
        dom.emptyTitle.textContent = hasAny
            ? 'Nada coincide con el filtro'
            : (isOwnList ? 'Tu lista está vacía' : `La lista de ${viewUser} está vacía`);
        dom.emptyText.textContent = hasAny
            ? 'Prueba con otro estado o borra el texto de búsqueda.'
            : (isOwnList
                ? 'Busca un anime, revisa la nota y guárdalo.'
                : 'Todavía no ha guardado ningún anime.');
    }

    announce();
}

/**
 * Anuncia el resultado del filtro.
 *
 * Va en una región `sr-only` propia y no sobre la rejilla: con `aria-live` en
 * el contenedor, cada pulsación del filtro volvería a anunciar las cien
 * fichas de golpe, que es justo lo que un lector de pantalla no necesita.
 */
function announce() {
    const shown = state.shown.length;

    if (state.all.length === 0) {
        dom.listStatus.textContent = isOwnList
            ? 'Tu lista está vacía.'
            : `La lista de ${viewUser} está vacía.`;
    } else if (shown === 0) {
        dom.listStatus.textContent = 'Ningún anime coincide con el filtro.';
    } else if (shown !== state.all.length) {
        dom.listStatus.textContent = `${shown} de ${state.all.length} animes.`;
    } else {
        dom.listStatus.textContent = isOwnList
            ? `${shown} anime${shown === 1 ? '' : 's'} en tu lista.`
            : `${shown} anime${shown === 1 ? '' : 's'} en la lista de ${viewUser}.`;
    }
}

function replaceInList(anime) {
    if (!anime) return;
    const index = state.all.findIndex((entry) => entry.id === anime.id);
    if (index === -1) state.all = [anime, ...state.all];
    else state.all[index] = anime;
}

/* ---------------------------------------------------------------- */
/* Acciones                                                         */
/* ---------------------------------------------------------------- */

function toEpisodes(value) {
    const trimmed = String(value || '').trim();
    return /^\d+$/.test(trimmed) ? Number(trimmed) : '?';
}

function resetCover() {
    dom.cover.replaceChildren(el('span', {
        class: 'cover-preview__empty',
        'aria-hidden': 'true',
    }, icon('film', { size: 24 })));
}

function fillForm(item) {
    state.picked = {
        anilist_id: item.anilist_id ?? null,
        kitsu_id: item.kitsu_id ?? null,
        source: item.source || 'manual',
        cover_url: item.cover_url || '',
        year: item.year ?? null,
        format: item.format || 'Unknown',
        studios: item.studios || [],
        score: item.score ?? null,
        rankings: item.rankings || [],
        lists: item.lists ?? null,
        trailer: item.trailer || '',
        genres: item.genres || [],
    };

    dom.title.value = item.title || '';
    dom.rating.value = '';
    dom.status.value = item.status || 'Pendiente';
    dom.episodes.value = toEpisodes(item.episodes) === '?' ? '' : String(item.episodes);
    dom.synopsis.value = item.synopsis || '';

    dom.cover.replaceChildren(
        item.cover_url
            ? el('img', {
                src: item.cover_url,
                alt: `Portada de ${item.title}`,
                decoding: 'async',
            })
            : el('span', { class: 'cover-preview__empty', 'aria-hidden': 'true' }, icon('film', { size: 24 })),
    );

    // Si el panel estaba plegado, la ficha recién elegida se perdería detrás
    // del pliegue: se abre antes de avisar.
    ensureAddPanelOpen();
    setFormStatus('Ficha cargada: revisa la nota y guarda.', 'success');
    dom.rating.focus();
}

function setFormStatus(message, kind = '') {
    dom.formStatus.textContent = message;
    dom.formStatus.className = `form-status${kind ? ` is-${kind}` : ''}`;
}

async function submitForm(event) {
    event.preventDefault();

    const title = dom.title.value.trim();
    const rating = Number(dom.rating.value);

    if (!title) {
        setFormStatus('Escribe un título.', 'error');
        dom.title.focus();
        return;
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
        setFormStatus('La nota debe ser un número entero entre 1 y 10.', 'error');
        dom.rating.focus();
        return;
    }

    const submit = dom.form.querySelector('button[type="submit"]');
    submit.disabled = true;
    setFormStatus('Guardando…');

    try {
        const { anime, queued } = await DataRepository.addAnime({
            ...state.picked,
            title,
            rating,
            status: dom.status.value,
            episodes: toEpisodes(dom.episodes.value),
            synopsis: dom.synopsis.value.trim(),
        }, username);

        state.picked = {};
        dom.form.reset();
        resetCover();
        setFormStatus('');
        setAddPanelOpen(false);

        replaceInList(anime);
        if (!anime) state.all = await DataRepository.getAnimes(username);
        applyView();
        renderStats();
        refreshPending();

        toast(queued ? 'Guardado sin conexión; se enviará luego.' : `“${title}” añadido a tu lista.`, {
            type: 'success',
        });
    } catch (error) {
        setFormStatus(error.message || 'No se pudo guardar.', 'error');
    } finally {
        submit.disabled = false;
    }
}

async function removeCard(anime) {
    const confirmed = await confirmDialog({
        title: `¿Eliminar “${anime.title}”?`,
        message: 'Podrás deshacerlo durante unos segundos.',
        confirmLabel: 'Eliminar',
        danger: true,
    });
    if (!confirmed) return;

    try {
        const { queued, previous } = await DataRepository.deleteAnime(anime.id, username);

        state.all = state.all.filter((entry) => entry.id !== anime.id);
        applyView();
        renderStats();
        refreshPending();

        toast(queued ? 'Eliminado en local; se sincronizará luego.' : `“${anime.title}” eliminado.`, {
            type: 'success',
            duration: 8000,
            action: previous ? { label: 'Deshacer', onClick: () => undoDelete(previous) } : null,
        });
    } catch (error) {
        toast(error.message || 'No se pudo eliminar.', { type: 'error' });
    }
}

async function undoDelete(previous) {
    try {
        const { anime, queued } = await DataRepository.restoreAnime(username, previous);

        if (anime) replaceInList(anime);
        else state.all = await DataRepository.getAnimes(username);

        applyView();
        renderStats();
        refreshPending();
        toast(queued ? 'Restaurado en local.' : `“${previous.title}” restaurado.`, { type: 'success' });
    } catch (error) {
        toast(error.message || 'No se pudo restaurar.', { type: 'error' });
    }
}

/* ---------------------------------------------------------------- */
/* Eventos                                                          */
/* ---------------------------------------------------------------- */

function syncChips() {
    dom.chips.querySelectorAll('.chip').forEach((chip) => {
        const isActive = chip.dataset.status === state.statusFilter;
        chip.classList.toggle('is-active', isActive);
        chip.setAttribute('aria-pressed', String(isActive));
    });
}

function syncViewSwitch() {
    dom.viewSwitch.querySelectorAll('[data-view]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.view === state.viewMode));
    });
}

/**
 * El formulario de alta vive plegado: la primera pantalla es la lista, que es
 * de donde se viene. Abrirlo es explícito y el estado se recuerda, así que
 * quien alta seguido no lo tiene que desplegar cada vez.
 *
 * El colapso se anima con `grid-template-rows: 0fr -> 1fr` en lugar de
 * `hidden`, porque `display: none` no interpola. Pero `0fr` solo recorta la
 * caja: el contenido sigue siendo tabulable, así que además se marca
 * `inert`, que sí lo saca del orden de tabulación y del árbol de accesibilidad
 * sin interrumpir la transición.
 */
function setAddPanelOpen(open, { focus = true } = {}) {
    dom.addToggle.setAttribute('aria-expanded', String(open));
    dom.addBody.classList.toggle('is-open', open);
    dom.addBodyInner.inert = !open;

    Settings.set('addPanelOpen', open);
    if (open && focus) dom.title.focus();
}

/** Abre el panel si estaba plegado. Lo llama el buscador al elegir ficha. */
function ensureAddPanelOpen() {
    if (dom.addToggle.getAttribute('aria-expanded') !== 'true') {
        setAddPanelOpen(true);
    }
}

function setViewMode(mode) {
    state.viewMode = mode === 'list' ? 'list' : 'grid';
    Settings.set('viewMode', state.viewMode);
    syncViewSwitch();
    applyView();
}

/**
 * Menú de usuario.
 *
 * Se cierra con Escape, con clic fuera y con `Tab` fuera; el foco vuelve al
 * botón que lo abrió para que un teclado no se quede suelto.
 */
function initUserMenu() {
    const close = ({ restoreFocus = false } = {}) => {
        if (dom.userMenu.hidden) return;
        dom.userMenu.hidden = true;
        dom.userButton.setAttribute('aria-expanded', 'false');
        if (restoreFocus) dom.userButton.focus();
    };

    const open = () => {
        dom.userMenu.hidden = false;
        dom.userButton.setAttribute('aria-expanded', 'true');
    };

    dom.userButton.addEventListener('click', (event) => {
        event.stopPropagation();
        if (dom.userMenu.hidden) open();
        else close();
    });

    dom.userMenu.addEventListener('click', (event) => {
        if (event.target.closest('button')) close();
    });

    document.addEventListener('click', (event) => {
        if (!dom.userMenu.hidden && !dom.userMenu.contains(event.target)) close();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || dom.userMenu.hidden) return;
        event.stopPropagation();
        close({ restoreFocus: true });
    });
}

/**
 * Censo de cuentas: ver su lista, resetear contraseñas, cambiar el rol y borrar.
 *
 * Solo el botón del menú lo abre cuando la sesión es admin, pero el rol no
 * viaja en el token: cada petición de aquí abajo vuelve a comprobarlo el
 * backend, así que si los poderes caducan a mitad de sesión la operación
 * devuelve 403 y el aviso lo cuenta. Ninguna fila es editable con `innerHTML`:
 * todo se construye con `el()`.
 */
function initAdminDialog() {
    const dialog = document.getElementById('admin-dialog');
    const list = document.getElementById('admin-users');
    const status = document.getElementById('admin-status');
    const filter = document.getElementById('admin-filter');

    /** Censo tal y como lo devolvió el servidor; se filtra en cliente. */
    let users = [];

    const setStatus = (text, isError = false) => {
        status.textContent = text;
        status.classList.toggle('is-error', isError);
    };

    /** Devuelve `true` si la operación salió bien; el error siempre es un toast. */
    const run = async (action, successMessage) => {
        try {
            await action();
            toast(successMessage, { type: 'success' });
            return true;
        } catch (error) {
            toast(error.message || 'No se ha podido completar la operación.', { type: 'error' });
            return false;
        }
    };

    function renderRows() {
        const term = filter.value.trim().toLowerCase();
        const visible = users.filter((account) => !term
            || account.username.toLowerCase().includes(term)
            || String(account.display_name || '').toLowerCase().includes(term));

        setStatus(`${visible.length} de ${users.length} cuenta${users.length === 1 ? '' : 's'}`);

        if (!visible.length) {
            list.replaceChildren(el('p', {
                class: 'modal__hint',
                text: users.length ? 'Ninguna cuenta coincide con el filtro.' : 'Todavía no hay ninguna cuenta.',
            }));
            return;
        }

        list.replaceChildren(...visible.map(rowNode));
        hydrateIcons(list);
    }

    function rowNode(account) {
        const isMe = account.username === username;

        /* Contraseña: el formulario va debajo de la fila en vez de en un
           segundo diálogo; así nunca hay dos modales apilados. */
        const passwordForm = el('form', { class: 'admin-row__pw', hidden: true },
            el('input', {
                type: 'password',
                minlength: '6',
                maxlength: '128',
                required: true,
                autocomplete: 'new-password',
                placeholder: 'Nueva contraseña (mínimo 6)',
                'aria-label': `Nueva contraseña de ${account.username}`,
            }),
            el('button', { class: 'btn btn--primary btn--sm', type: 'submit', text: 'Guardar' }),
            el('button', {
                class: 'btn btn--ghost btn--sm',
                type: 'button',
                text: 'Cancelar',
                onClick: () => {
                    passwordForm.hidden = true;
                    passwordForm.reset();
                },
            }),
        );

        passwordForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const value = passwordForm.querySelector('input').value;
            const ok = await run(
                () => ApiClient.adminResetPassword(account.username, value),
                `Contraseña de ${account.username} actualizada.`,
            );
            if (ok) {
                passwordForm.hidden = true;
                passwordForm.reset();
            }
        });

        const meta = [
            `@${account.username}`,
            `${account.anime_count} anime${account.anime_count === 1 ? '' : 's'}`,
            account.is_admin ? 'admin' : null,
        ].filter(Boolean).join(' · ');

        return el('div', { class: 'admin-row', dataset: { user: account.username } },
            el('div', { class: 'admin-row__id' },
                el('span', { class: 'admin-row__name', text: account.display_name || account.username }),
                el('span', { class: 'admin-row__meta', text: meta }),
            ),
            el('div', { class: 'admin-row__actions' },
                el('button', {
                    class: 'btn btn--ghost btn--sm',
                    type: 'button',
                    text: 'Ver lista',
                    onClick: () => {
                        location.href = `dashboard.html?user=${encodeURIComponent(account.username)}`;
                    },
                }),
                el('button', {
                    class: 'btn btn--ghost btn--sm',
                    type: 'button',
                    text: 'Contraseña',
                    onClick: () => {
                        passwordForm.hidden = false;
                        passwordForm.querySelector('input').focus();
                    },
                }),
                // Borrarse a sí mismo o bajarse el rol acaba siempre en 400 del
                // backend; esconderlo evita el viaje y el error.
                isMe ? null : el('button', {
                    class: 'btn btn--ghost btn--sm',
                    type: 'button',
                    text: account.is_admin ? 'Quitar admin' : 'Dar admin',
                    onClick: async () => {
                        const next = account.is_admin ? 'user' : 'admin';
                        const confirmed = await confirmDialog({
                            title: next === 'admin' ? 'Dar administración' : 'Quitar administración',
                            message: next === 'admin'
                                ? `¿Dar poderes de administración a ${account.username}?`
                                : `¿Quitar los poderes de administración a ${account.username}?`,
                            danger: next === 'user',
                        });
                        if (!confirmed) return;

                        const ok = await run(
                            () => ApiClient.adminSetRole(account.username, next),
                            `Rol de ${account.username} actualizado.`,
                        );
                        if (ok) {
                            account.is_admin = next === 'admin';
                            renderRows();
                        }
                    },
                }),
                isMe ? null : el('button', {
                    class: 'btn btn--danger btn--sm',
                    type: 'button',
                    text: 'Borrar',
                    onClick: async () => {
                        const confirmed = await confirmDialog({
                            title: 'Borrar cuenta',
                            message: `Se borrarán la cuenta de ${account.username} y sus ${account.anime_count} animes. No se puede deshacer.`,
                            confirmLabel: 'Borrar',
                            danger: true,
                        });
                        if (!confirmed) return;

                        const ok = await run(
                            () => ApiClient.adminDeleteUser(account.username),
                            `Cuenta de ${account.username} borrada.`,
                        );
                        if (ok) {
                            users = users.filter((entry) => entry.username !== account.username);
                            renderRows();
                        }
                    },
                }),
            ),
            passwordForm,
        );
    }

    async function open() {
        if (dialog.open) return;
        filter.value = '';
        list.replaceChildren();
        setStatus('Cargando cuentas…');
        dialog.showModal();

        try {
            const data = await ApiClient.adminListUsers();
            users = data.users || [];
            renderRows();
        } catch (error) {
            setStatus(error.message || 'No se pudo cargar el censo.', true);
        }
    }

    filter.addEventListener('input', () => {
        if (users.length) renderRows();
    });
    document.getElementById('admin-close').addEventListener('click', () => dialog.close());
    // Clic en el fondo: igual que en el resto de diálogos de la app.
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
    });

    return { open };
}

/**
 * Amistades: solicitudes en ambos sentidos y amigos confirmados.
 *
 * Sigue el patrón de `initAdminDialog`: un solo diálogo, filas construidas con
 * `el()` (nada de `innerHTML`) e hidratadas con `hydrateIcons`. Toda operación
 * pasa por `confirmDialog` cuando es destructiva y sus errores (409 de estado
 * duplicado, 429 del límite horario) salen como toast con el mensaje del
 * backend, que ya explica qué hacer.
 */
function initFriendsDialog() {
    const dialog = document.getElementById('friends-dialog');
    const list = document.getElementById('friends-list');
    const status = document.getElementById('friends-status');
    const form = document.getElementById('friend-request-form');
    const input = document.getElementById('friend-request-input');
    const suggestions = document.getElementById('friend-request-suggestions');

    /** Listado tal y como lo devolvió el servidor; se reutiliza entre acciones. */
    let data = { friends: [], incoming: [], outgoing: [] };

    const setStatus = (text, isError = false) => {
        status.textContent = text;
        status.classList.toggle('is-error', isError);
    };

    /** Devuelve `true` si la operación salió bien; el error siempre es un toast. */
    const run = async (action, successMessage) => {
        try {
            await action();
            toast(successMessage, { type: 'success' });
            return true;
        } catch (error) {
            toast(error.message || 'No se ha podido completar la operación.', { type: 'error' });
            return false;
        }
    };

    /** Vuelve a pedir el listado y repinta; lo usan las acciones de las filas. */
    const refresh = async () => {
        try {
            data = await ApiClient.listFriends();
            renderSections();
        } catch (error) {
            setStatus(error.message || 'No se pudieron cargar tus amigos.', true);
        }
    };

    function renderSections() {
        const total = data.friends.length;
        setStatus(`${total} amigo${total === 1 ? '' : 's'}`
            + ` · ${data.incoming.length} solicitud${data.incoming.length === 1 ? '' : 'es'} entrante${data.incoming.length === 1 ? '' : 's'}`
            + (data.outgoing.length ? ` · ${data.outgoing.length} enviada${data.outgoing.length === 1 ? '' : 's'}` : ''));

        const nodes = [];
        const section = (title, entries, rowFn) => {
            if (!entries.length && title !== 'Amigos') return;
            nodes.push(el('h3', { class: 'friends__section', text: title }));
            if (!entries.length) {
                nodes.push(el('p', { class: 'modal__hint', text: 'Ninguna por ahora.' }));
                return;
            }
            nodes.push(...entries.map(rowFn));
        };

        section('Solicitudes recibidas', data.incoming, incomingRow);
        section('Solicitudes enviadas', data.outgoing, outgoingRow);
        section('Amigos', data.friends, friendRow);

        list.replaceChildren(...nodes);
        hydrateIcons(list);
    }

    const profileLine = (entry) => [
        `@${entry.username}`,
        entry.since ? `desde ${entry.since.slice(0, 10)}` : null,
    ].filter(Boolean).join(' · ');

    const rowShell = (entry) => el('div', { class: 'admin-row', dataset: { user: entry.username } },
        el('div', { class: 'admin-row__id' },
            el('span', { class: 'admin-row__name', text: entry.display_name || entry.username }),
            el('span', { class: 'admin-row__meta', text: profileLine(entry) }),
        ),
        el('div', { class: 'admin-row__actions' }),
    );

    const actionsOf = (row) => row.querySelector('.admin-row__actions');

    function incomingRow(entry) {
        const row = rowShell(entry);
        actionsOf(row).append(
            el('button', {
                class: 'btn btn--primary btn--sm',
                type: 'button',
                text: 'Aceptar',
                onClick: async () => {
                    const ok = await run(
                        () => ApiClient.acceptFriendRequest(entry.username),
                        `Ahora sois amigos de ${entry.username}.`,
                    );
                    if (ok) refresh();
                },
            }),
            el('button', {
                class: 'btn btn--ghost btn--sm',
                type: 'button',
                text: 'Rechazar',
                onClick: async () => {
                    const ok = await run(
                        () => ApiClient.rejectFriendRequest(entry.username),
                        'Solicitud rechazada.',
                    );
                    if (ok) refresh();
                },
            }),
        );
        return row;
    }

    function outgoingRow(entry) {
        const row = rowShell(entry);
        actionsOf(row).append(
            el('button', {
                class: 'btn btn--ghost btn--sm',
                type: 'button',
                text: 'Retirar',
                onClick: async () => {
                    const confirmed = await confirmDialog({
                        title: 'Retirar solicitud',
                        message: `¿Retirar la solicitud enviada a ${entry.username}?`,
                    });
                    if (!confirmed) return;
                    const ok = await run(
                        () => ApiClient.rejectFriendRequest(entry.username),
                        'Solicitud retirada.',
                    );
                    if (ok) refresh();
                },
            }),
        );
        return row;
    }

    function friendRow(entry) {
        const row = rowShell(entry);
        actionsOf(row).append(
            el('button', {
                class: 'btn btn--ghost btn--sm',
                type: 'button',
                text: 'Ver lista',
                onClick: () => {
                    dialog.close();
                    location.href = `dashboard.html?user=${encodeURIComponent(entry.username)}`;
                },
            }),
            el('button', {
                class: 'btn btn--danger btn--sm',
                type: 'button',
                text: 'Dejar de ser amigo',
                onClick: async () => {
                    const confirmed = await confirmDialog({
                        title: 'Eliminar amistad',
                        message: `¿Dejar de ser amigo de ${entry.username}?`,
                        confirmLabel: 'Eliminar',
                        danger: true,
                    });
                    if (!confirmed) return;
                    const ok = await run(
                        () => ApiClient.removeFriend(entry.username),
                        `Ya no eres amigo de ${entry.username}.`,
                    );
                    if (ok) refresh();
                },
            }),
        );
        return row;
    }

    /** Sugerencias de cuentas mientras se teclea el destino de la solicitud. */
    const suggest = debounce(async () => {
        const term = input.value.trim();
        if (!term) {
            suggestions.replaceChildren();
            return;
        }
        try {
            const { users } = await ApiClient.searchUsers(term);
            suggestions.replaceChildren(...users.map((u) => el('option', { value: u.username })));
        } catch {
            /* Sin red la sugerencia queda vacía; el envío por nombre sigue funcionando. */
        }
    }, 250);

    input.addEventListener('input', suggest);

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const target = input.value.trim();
        if (!target) return;
        const ok = await run(
            () => ApiClient.sendFriendRequest(target),
            `Solicitud enviada a ${target}.`,
        );
        if (ok) {
            input.value = '';
            suggestions.replaceChildren();
            refresh();
        }
    });

    async function open() {
        if (dialog.open) return;
        input.value = '';
        suggestions.replaceChildren();
        list.replaceChildren();
        setStatus('Cargando amigos…');
        dialog.showModal();
        await refresh();
    }

    document.getElementById('friends-close').addEventListener('click', () => dialog.close());
    // Clic en el fondo: igual que en el resto de diálogos de la app.
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
    });

    return { open };
}

function bindEvents() {
    initThemeToggle(document.getElementById('btn-theme'));

    initProfileDialog({
        paint: async (profile) => {
            // Guardar sin conexión devuelve un perfil parcial (solo los campos
            // que cambian, sin `has_avatar`/`has_banner`/`has_background`) o
            // `null` si no se pudo leer el perfil al abrir el diálogo. Pintarlo
            // tal cual borraba el avatar, el banner y el fondo de la cabecera
            // hasta recargar: se mezcla sobre lo que ya hay y `null` no toca nada.
            if (profile) session.profile = { ...session.profile, ...profile };
            await renderUser();
        },
    });

    initUserMenu();

    // Solo quien es admin llega a pulsarlo; el backend vuelve a comprobarlo.
    const adminDialog = initAdminDialog();
    dom.adminButton.addEventListener('click', () => adminDialog.open());

    // Amigos: accesible para cualquier sesión, desde el menú de usuario.
    const friendsDialog = initFriendsDialog();
    dom.friendsButton.addEventListener('click', () => friendsDialog.open());

    /* Ir a la lista de otra cuenta, desde el menú de usuario. El `datalist`
       sugiere mientras se escribe, pero basta con el nombre y Enter: si no
       existe, el backend responde 404 y la pantalla vuelve a la propia. */
    const gotoUser = (value) => {
        const target = String(value || '').trim();
        if (!target) return;
        location.href = target.toLowerCase() === username.toLowerCase()
            ? 'dashboard.html'
            : `dashboard.html?user=${encodeURIComponent(target)}`;
    };

    dom.viewForm.addEventListener('submit', (event) => {
        event.preventDefault();
        gotoUser(dom.viewInput.value);
    });

    const suggestUsers = debounce(async () => {
        const term = dom.viewInput.value.trim();
        if (!term) {
            dom.viewSuggestions.replaceChildren();
            return;
        }
        try {
            const { users } = await ApiClient.searchUsers(term);
            dom.viewSuggestions.replaceChildren(...users.map((u) => el('option', { value: u.username })));
        } catch {
            /* Sin red la sugerencia se queda vacía; el envío por Enter sigue funcionando. */
        }
    }, 250);

    dom.viewInput.addEventListener('input', suggestUsers);

    // Al salir ya no va a haber quien revoke los object URLs: se liberan ahora
    // para no dejar los bytes de las imagenes en memoria.
    window.addEventListener('pagehide', () => {
        releaseViewImageUrls();
        releaseAllImageUrls();
    });

    dom.logout.addEventListener('click', () => {
        releaseViewImageUrls();
        releaseAllImageUrls();
        ApiClient.logout();
        location.href = 'login.html';
    });

    dom.addToggle.addEventListener('click', () => {
        setAddPanelOpen(dom.addToggle.getAttribute('aria-expanded') !== 'true');
    });

    dom.emptyAction.addEventListener('click', () => searchModal?.open(''));

    // El CSV es el formato por defecto; el aviso ofrece el JSON como
    // alternativa sin llenar la barra de controles con un segundo boton.
    dom.export.addEventListener('click', async () => {
        await exportList('csv');
        toast('¿Prefieres el JSON?', {
            duration: 6000,
            action: { label: 'Descargar JSON', onClick: () => exportList('json') },
        });
    });

    dom.form.addEventListener('submit', submitForm);
    dom.form.addEventListener('reset', () => {
        setFormStatus('');
        state.picked = {};
        resetCover();
    });

    dom.openSearch.addEventListener('click', () => searchModal?.open(dom.title.value.trim()));

    // Publicar en el muro de la lista visitada. El propio muro solo está
    // visible en lista ajena, así que `viewUser` es siempre la cuenta ajena.
    dom.wallForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = dom.wallText.value.trim();
        if (!text) {
            dom.wallStatus.textContent = 'El comentario no puede estar vacío.';
            dom.wallStatus.classList.add('is-error');
            return;
        }
        wall.submit(text);
    });

    dom.chips.addEventListener('click', (event) => {
        const chip = event.target.closest('.chip');
        if (!chip) return;

        state.statusFilter = chip.dataset.status;
        Settings.set('statusFilter', state.statusFilter);
        syncChips();
        applyView();
    });

    /* Sin retardo, cada pulsación reconstruía la lista entera y en una lista
       larga se notaba como tirones. Con 180 ms hay tiempo de sobra para
       escribir una palabra sin que el resultado parezca obsoleto. */
    const onFilter = debounce(() => applyView(), 180);

    dom.filterText.addEventListener('input', () => {
        state.textFilter = dom.filterText.value;
        Settings.set('textFilter', state.textFilter);
        onFilter();
    });

    dom.sortBy.value = state.sortBy;
    dom.sortBy.addEventListener('change', () => {
        state.sortBy = dom.sortBy.value;
        Settings.set('sortBy', state.sortBy);
        applyView();
    });

    dom.viewSwitch.addEventListener('click', (event) => {
        const button = event.target.closest('[data-view]');
        if (button) setViewMode(button.dataset.view);
    });

    dom.grid.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;

        // `.card` y `.row` son los dos envoltorios posibles, según el modo de vista.
        const id = button.closest('[data-id]')?.dataset.id;
        const anime = state.all.find((entry) => entry.id === id);
        if (!anime) return;

        if (button.dataset.action === 'edit') {
            state.editingId = anime.id;
            applyView();
            dom.grid.querySelector(`[data-id="${CSS.escape(anime.id)}"] .card-edit input`)?.focus();
        } else if (button.dataset.action === 'cancel') {
            state.editingId = null;
            applyView();
        } else if (button.dataset.action === 'delete') {
            removeCard(anime);
        }
    });

    watchConnection({
        onChange: (online) => {
            setOffline(!online);
            // La cola es de la sesión; en lista ajena no hay nada que volcar.
            if (online && isOwnList) syncQueue();
        },
    });
}

function boot() {
    if (!session) return; // redirigiendo al acceso: no hay nada que pintar

    // Los iconos del HTML estático se sustituyen antes de que se pinten los
    // datos, para que la cabecera no cambie de aspecto al cargar la lista.
    hydrateIcons();

    if (!isOwnList) {
        // Modo solo lectura: se oculta todo lo que escriba en la lista ajena.
        // Los botones de las tarjetas ya no salen por `actionButtons`, pero el
        // panel de alta, exportar y buscar animes nuevos también sobran.
        dom.addPanel.hidden = true;
        dom.addBodyInner.inert = true;
        dom.export.hidden = true;
        dom.openSearch.hidden = true;
        dom.emptyAction.hidden = true;
        dom.listTitleLabel.textContent = `Lista de ${viewUser}`;
        dom.statTotalLabel.textContent = 'En su lista';
        dom.statsSection.setAttribute('aria-label', `Resumen de la lista de ${viewUser}`);
        dom.viewBanner.hidden = false;
        dom.viewBannerName.textContent = `@${viewUser}`;

        // El muro es exclusivo de la lista ajena: el propio tiene el panel de
        // alta y los comentarios sobre tu lista no aportan nada aquí.
        dom.wall.hidden = false;
        dom.wallTarget.textContent = viewUser;
        wall.load();

        // Banner y fondo de la cuenta visitada. El perfil llega en paralelo a
        // la lista, y el que tarde no debe retrasar el resto del arranque.
        ApiClient.getUser(viewUser)
            .then(({ profile }) => {
                state.viewProfile = profile;
                return renderUser();
            })
            .then(renderViewBanner)
            .catch(() => { /* si la cuenta no existe, `load` ya lo dirá con su 404 */ });
    }

// Sin await a proposito: el resto de la interfaz no debe esperar a que
    // lleguen los bytes de las imagenes del perfil.
    renderUser();

    // `session.profile` viene cacheado en localStorage del ultimo inicio de
    // sesion, asi que se queda obsoleto en cuanto el perfil cambia (foto nueva,
    // nombre editado, o el mismo cambio hecho desde otro navegador). Un refresco
    // al entrar evita que el avatar desaparezca hasta el siguiente login.
    ApiClient.getProfile()
        .then((profile) => {
            if (!profile) return;
            session.profile = profile;
            return renderUser();
        })
        .catch(() => { /* la foto ya pintada sirve de respaldo */ });

    syncChips();
    syncViewSwitch();

    dom.filterText.value = state.textFilter;
    resetCover();
    // El panel arranca plegado salvo que se guardara abierto. Sin `focus`, que
    // robaría el foco a la página recién cargada. En lista ajena ni siquiera
    // se decide: el panel está oculto y el estado guardado no se toca.
    if (isOwnList) {
        setAddPanelOpen(Settings.get('addPanelOpen') === true, { focus: false });
    }

    bindEvents();

    initAutocomplete({
        input: dom.title,
        box: dom.autocomplete,
        // El autocompletado sugiere títulos; la ficha completa se abre en el
        // diálogo para que el usuario confirme el anime exacto.
        onPick: (title) => searchModal?.open(title),
    });

    load();
}

boot();