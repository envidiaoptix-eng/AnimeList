/**
 * Panel del usuario: lista, alta, edición, borrado con deshacer, filtros y
 * estadísticas. Habla con el repositorio, nunca directamente con el backend.
 */

import { ApiClient } from './api.js';
import { DataRepository } from './data_repository.js';
import { Settings, watchConnection } from './storage.js';
import { initThemeToggle } from './theme.js';
import { confirmDialog, el, fallbackMeta, formatMeta, rankBadges, toast } from './ui.js';
import { initSearchModal, initAutocomplete } from './search_modal.js';
import {
    initProfileDialog,
    profileImageUrl,
    releaseAllImageUrls,
} from './profile.js';

const session = ApiClient.getSession();

// La redirección es asíncrona: el módulo sigue evaluándose, así que el resto del
// código debe tolerar `session === null` en vez de leer session.username a ciegas.
if (!session) location.replace('index.html');

const username = session?.username ?? '';

const STATUSES = ['Pendiente', 'Viendo', 'Completado', 'Abandonado'];

const dom = {
    display: document.getElementById('user-display'),
    avatar: document.getElementById('user-avatar'),
    offline: document.getElementById('offline-badge'),
    logout: document.getElementById('btn-logout'),
    header: document.querySelector('.app-header'),
    banner: document.getElementById('profile-banner'),

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

    chips: document.getElementById('status-chips'),
    filterText: document.getElementById('filter-text'),
    sortBy: document.getElementById('sort-by'),
    listCount: document.getElementById('list-count'),
    grid: document.getElementById('contenedor-animes'),
    empty: document.getElementById('empty-state'),
    emptyTitle: document.getElementById('empty-title'),
    emptyText: document.getElementById('empty-text'),
};

const state = {
    all: [],
    shown: [],
    editingId: null,
    statusFilter: Settings.get('statusFilter'),
    sortBy: Settings.get('sortBy'),
    textFilter: '',
    /** Metadatos de la ficha elegida en el buscador, para el próximo alta. */
    picked: {},
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
 */
async function renderUser() {
    const profile = session.profile;
    const name = profile?.display_name || username;

    dom.display.textContent = name;

    await paintBanner(profile);

    // Si antes se pintó el marcador de inicial y ahora hay foto, el `<span>` que
    // sustituyó al `<img>` sigue en el DOM: hay que volver al elemento real.
    if (!dom.avatar.isConnected || dom.avatar.tagName !== 'IMG') {
        const nuevo = document.createElement('img');
        nuevo.id = 'user-avatar';
        nuevo.className = 'avatar';
        dom.avatar.replaceWith(nuevo);
        dom.avatar = nuevo;
    }

    dom.avatar.alt = '';
    dom.avatar.removeAttribute('src');
    dom.avatar.hidden = true;

    try {
        const url = await profileImageUrl('avatar', profile);
        if (url) {
            dom.avatar.src = url;
            dom.avatar.alt = `Foto de ${name}`;
            dom.avatar.hidden = false;
            return;
        }
    } catch {
        // Si la imagen no se puede pedir, se muestra el marcador de inicial.
    }

    const placeholder = el('span', {
        class: 'avatar avatar--placeholder',
        'aria-hidden': 'true',
        text: name.trim().charAt(0).toUpperCase() || '?',
    });
    dom.avatar.replaceWith(placeholder);
    dom.avatar = placeholder;
}

async function paintBanner(profile) {
    let url = '';
    try {
        url = await profileImageUrl('banner', profile);
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
    if (isOffline && queued > 0) {
        dom.offline.textContent = `Sin conexión · ${queued} pendiente${queued === 1 ? '' : 's'}`;
    } else {
        dom.offline.textContent = 'Sin conexión';
    }
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
        ...Array.from({ length: 8 }, () => el('div', { class: 'skeleton skeleton--card' })),
    );

    try {
        state.all = await DataRepository.getAnimes(username);
        applyView();
        renderStats();
        await syncQueue();
    } catch (error) {
        dom.grid.replaceChildren();
        toast(error.message || 'No se pudo cargar tu lista.', { type: 'error' });
    }
}

/** Vuelca la cola offline y recarga si había algo pendiente. */
async function syncQueue() {
    const { synced } = await DataRepository.flushQueue(username);
    if (!synced) return;

    state.all = await DataRepository.getAnimes(username);
    applyView();
    renderStats();
    toast(`${synced} cambio${synced === 1 ? '' : 's'} sincronizado${synced === 1 ? '' : 's'}.`, {
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
}

/* ---------------------------------------------------------------- */
/* Tarjetas                                                         */
/* ---------------------------------------------------------------- */

function coverNode(anime) {
    const title = anime.title || '?';
    const fallback = () => el('div', {
        class: 'card__cover--empty',
        'aria-hidden': 'true',
        text: title.charAt(0),
    });

    if (!anime.cover_url) return fallback();

    return el('img', {
        src: anime.cover_url,
        alt: `Portada de ${title}`,
        loading: 'lazy',
        onError: (event) => event.target.replaceWith(fallback()),
    });
}

function cardNode(anime) {
    const isEditing = state.editingId === anime.id;

    const card = el('article', {
        class: `card${isEditing ? ' card--editing' : ''}`,
        role: 'listitem',
        dataset: { id: anime.id },
    });

    const cover = el('div', { class: 'card__cover' },
        coverNode(anime),
        el('span', { class: `badge badge--cover badge--${anime.status}`, text: anime.status }),
    );
    if (anime.cover_color) cover.style.background = anime.cover_color;

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
 * Las dos insignias de "toda la historia" de AniList. Sin rankings se cae al
 * resumen de Kitsu (nota media y usuarios en sus listas), porque Kitsu no
 * publica posiciones y conviene decirlo antes que dejar la ficha sin nada.
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

function externalLink(anime) {
    if (!anime.anilist_id && !anime.kitsu_id) return null;

    return el('a', {
        class: 'card__link',
        href: anime.anilist_id
            ? `https://anilist.co/anime/${anime.anilist_id}`
            : `https://kitsu.io/anime/${anime.kitsu_id}`,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'Ver ficha ↗',
    });
}

function actionsRow(anime) {
    return el('div', { class: 'card__foot' },
        el('span', { class: 'rating' },
            String(anime.rating),
            el('span', { class: 'rating__suffix', text: '/10' }),
            DataRepository.isPending(username, anime.id)
                ? el('span', { class: 'badge badge--pending', text: 'pendiente' })
                : null,
        ),
        el('div', { class: 'card__actions' },
            el('button', {
                class: 'icon-btn',
                type: 'button',
                title: 'Editar',
                'aria-label': `Editar ${anime.title}`,
                dataset: { action: 'edit' },
                text: '✎',
            }),
            el('button', {
                class: 'icon-btn icon-btn--danger',
                type: 'button',
                title: 'Eliminar',
                'aria-label': `Eliminar ${anime.title}`,
                dataset: { action: 'delete' },
                text: '🗑',
            }),
        ),
    );
}

function editForm(anime) {
    const form = el('form', { class: 'card-edit', novalidate: true });

    const titleInput = el('input', { type: 'text', value: anime.title, maxlength: '200', required: true });
    const ratingInput = el('input', {
        type: 'number', min: '1', max: '10', value: String(anime.rating), required: true,
    });
    const statusSelect = el('select', {},
        ...STATUSES.map((value) => el('option', { value, text: value, selected: value === anime.status })),
    );
    const episodesInput = el('input', {
        type: 'text',
        inputmode: 'numeric',
        value: anime.episodes === '?' || anime.episodes == null ? '' : String(anime.episodes),
    });
    const synopsisInput = el('textarea', { rows: '3', maxlength: '2000' });
    synopsisInput.value = anime.synopsis || '';

    form.append(
        el('div', { class: 'field' }, el('label', { text: 'Título' }), titleInput),
        el('div', { class: 'card-edit__row' },
            el('div', { class: 'field' }, el('label', { text: 'Nota' }), ratingInput),
            el('div', { class: 'field' }, el('label', { text: 'Estado' }), statusSelect),
        ),
        el('div', { class: 'field' }, el('label', { text: 'Episodios' }), episodesInput),
        el('div', { class: 'field' }, el('label', { text: 'Sinopsis' }), synopsisInput),
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

function applyView() {
    state.shown = visible();
    dom.listCount.textContent = state.shown.length;
    dom.grid.replaceChildren(...state.shown.map(cardNode));

    dom.empty.hidden = state.shown.length > 0;
    if (state.shown.length === 0) {
        const hasAny = state.all.length > 0;
        dom.emptyTitle.textContent = hasAny ? 'Nada coincide con el filtro' : 'Tu lista está vacía';
        dom.emptyText.textContent = hasAny
            ? 'Prueba con otro estado o borra el texto de búsqueda.'
            : 'Busca un anime arriba y pulsa “Guardar en mi lista”.';
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
    dom.cover.replaceChildren(
        el('span', { class: 'cover-preview__empty', 'aria-hidden': 'true', text: '🎞️' }),
    );
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
            ? el('img', { src: item.cover_url, alt: `Portada de ${item.title}` })
            : el('span', { class: 'cover-preview__empty', 'aria-hidden': 'true', text: '🎞️' }),
    );

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

function bindEvents() {
    initThemeToggle(document.getElementById('btn-theme'));

    initProfileDialog({
        paint: async (profile) => {
            session.profile = profile;
            await renderUser();
        },
    });

    // Al salir ya no va a haber quien revoke los object URLs: se liberan ahora
    // para no dejar los bytes de las imagenes en memoria.
    window.addEventListener('pagehide', releaseAllImageUrls);

    dom.logout.addEventListener('click', () => {
        releaseAllImageUrls();
        ApiClient.logout();
        location.href = 'index.html';
    });

    dom.form.addEventListener('submit', submitForm);
    dom.form.addEventListener('reset', () => {
        setFormStatus('');
        state.picked = {};
        resetCover();
    });

    dom.openSearch.addEventListener('click', () => searchModal?.open(dom.title.value.trim()));

    dom.chips.addEventListener('click', (event) => {
        const chip = event.target.closest('.chip');
        if (!chip) return;

        state.statusFilter = chip.dataset.status;
        Settings.set('statusFilter', state.statusFilter);
        syncChips();
        applyView();
    });

    dom.filterText.addEventListener('input', () => {
        state.textFilter = dom.filterText.value;
        applyView();
    });

    dom.sortBy.value = state.sortBy;
    dom.sortBy.addEventListener('change', () => {
        state.sortBy = dom.sortBy.value;
        Settings.set('sortBy', state.sortBy);
        applyView();
    });

    dom.grid.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;

        const id = button.closest('.card')?.dataset.id;
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
            if (online) syncQueue();
        },
    });
}

function boot() {
    if (!session) return; // redirigiendo al inicio: no hay nada que pintar

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