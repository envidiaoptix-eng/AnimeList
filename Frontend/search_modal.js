/**
 * Buscador de anime.
 *
 * Dos consumidores:
 *   initSearchModal()    diálogo con resultados, paginación y navegación por teclado
 *   initAutocomplete()   sugerencias bajo el campo de título del formulario
 *
 * Las dos capas llaman al proxy del backend (AniList con respaldo a Kitsu).
 */

import { ApiClient, ApiError } from './api.js';
import { Settings } from './storage.js';
import { el, debounce, fallbackMeta, formatMeta, rankBadges } from './ui.js';

const DEBOUNCE_MS = 320;

/* Nº de esqueletos mientras llegan los resultados. */
const SKELETON_COUNT = 8;

/** Portada de la ficha, o su inicial si la fuente no trae imagen. */
function tileCover(item) {
    const letter = (item.title || '?').charAt(0);

    return item.cover_url
        ? el('img', {
            src: item.cover_url,
            alt: '',
            loading: 'lazy',
            decoding: 'async',
            onError: (event) => event.target.replaceWith(emptyCover(letter)),
        })
        : emptyCover(letter);
}

function emptyCover(letter) {
    return el('div', { class: 'cover-empty', 'aria-hidden': 'true' },
        el('span', { class: 'cover-empty__letter', text: letter }));
}

function tileContent(item) {
    const fragment = document.createDocumentFragment();

    fragment.appendChild(tileCover(item));
    fragment.appendChild(el('span', { class: 'search-tile__title', text: item.title }));

    const badges = rankBadges(item);
    if (badges.length) {
        fragment.appendChild(el('span', { class: 'rank-list rank-list--tile' },
            ...badges.map((badge) => el('span', {
                class: 'rank-badge',
                title: badge.title,
                dataset: { rankContext: badge.context },
            },
            el('span', { class: 'rank-badge__num', text: `#${badge.rank}` }),
            el('span', { class: 'rank-badge__label', text: badge.label })))));
    }

    const resumen = formatMeta(item) || (item.status ? item.status : '');
    const alternativa = badges.length ? '' : fallbackMeta(item);
    fragment.appendChild(el('span', {
        class: 'search-tile__meta',
        text: [resumen, alternativa].filter(Boolean).join(' · '),
    }));

    return fragment;
}

export function initSearchModal({ onPick } = {}) {
    const dialog = document.getElementById('search-dialog');
    if (!dialog) return null;

    const input = document.getElementById('search-input');
    const results = document.getElementById('search-results');
    const status = document.getElementById('search-status');
    const moreBtn = document.getElementById('search-more');
    const adultBox = document.getElementById('search-adult');
    const closeBtn = document.getElementById('search-close');

    const state = { page: 1, term: '', items: [], hasNext: false, activeIndex: -1 };
    let controller = null;

    // El campo gobierna una lista de opciones, así que es un combobox. Sin esto
    // el resaltado con las flechas es solo visual: el lector de pantalla no
    // sabe que hay algo seleccionado.
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', results.id);

    const setStatus = (text, isError = false) => {
        status.textContent = text;
        status.classList.toggle('is-error', isError);
    };

    const renderSkeletons = () => {
        results.replaceChildren(
            ...Array.from({ length: SKELETON_COUNT }, () => el('div', { class: 'skeleton skeleton--card' })),
        );
    };

    const renderResults = () => {
        if (!state.items.length) {
            results.replaceChildren(el('p', {
                class: 'modal__hint',
                text: 'Sin resultados. Prueba con otro título o activa “Adultos”.',
            }));
            return;
        }

        results.replaceChildren(
            ...state.items.map((item, index) => {
                // El id estable es lo que `aria-activedescendant` apunta desde el
                // campo de texto; sin él la selección resaltada no se anuncia.
                const tile = el('button', {
                    id: `search-tile-${index}`,
                    class: 'search-tile',
                    type: 'button',
                    role: 'option',
                    'aria-selected': String(index === state.activeIndex),
                    dataset: { index: String(index) },
                    onClick: () => choose(item),
                }, tileContent(item));

                if (item.cover_color) tile.style.borderColor = item.cover_color;
                return tile;
            }),
        );
    };

    const setActive = (next) => {
        const tiles = [...results.querySelectorAll('.search-tile')];
        if (!tiles.length) return;

        state.activeIndex = (next + tiles.length) % tiles.length;
        tiles.forEach((tile, index) => {
            const isActive = index === state.activeIndex;
            tile.classList.toggle('is-active', isActive);
            tile.setAttribute('aria-selected', String(isActive));
            if (isActive) tile.scrollIntoView({ block: 'nearest' });
        });

        // `aria-activedescendant` es lo que hace que un lector de pantalla
        // siga la selección: sin él, el foco real sigue en el campo de texto
        // y la casilla resaltada no se anuncia aunque se vea.
        input.setAttribute('aria-activedescendant', tiles[state.activeIndex].id);
    };

    /** Deja el modal como estaba al abrirse: sin resultados ni paginación. */
    const reset = () => {
        state.items = [];
        state.activeIndex = -1;
        state.hasNext = false;
        state.page = 1;
        state.term = '';
        moreBtn.hidden = true;
        results.replaceChildren();
    };

    async function search({ append = false } = {}) {
        const term = input.value.trim();
        if (!term) {
            state.items = [];
            state.hasNext = false;
            moreBtn.hidden = true;
            results.replaceChildren();
            setStatus('Escribe el nombre de un anime para empezar.');
            return;
        }

        state.term = term;
        state.page = append ? state.page + 1 : 1;
        state.activeIndex = -1;

        if (!append) renderSkeletons();
        setStatus(append ? 'Cargando más resultados…' : `Buscando “${term}”…`);
        moreBtn.hidden = true;

        controller?.abort();
        controller = new AbortController();

        try {
            const data = await ApiClient.searchAnime(term, {
                page: state.page,
                adult: adultBox.checked,
                signal: controller.signal,
            });

            const items = data.results || [];
            state.items = append ? [...state.items, ...items] : items;
            state.hasNext = Boolean(data.has_next);

            renderResults();
            moreBtn.hidden = !state.hasNext;
            setStatus(
                `${state.items.length} de ${data.total} resultado${data.total === 1 ? '' : 's'} · fuente: ${data.source}`,
            );
        } catch (error) {
            if (error.name === 'AbortError') return;
            if (error instanceof ApiError) {
                setStatus(error.message, true);
                if (!append) results.replaceChildren();
                return;
            }
            setStatus('Error inesperado al buscar.', true);
        }
    }

    function choose(item) {
        dialog.close();
        onPick?.(item);
    }

    const searchDebounced = debounce(() => search(), DEBOUNCE_MS);

    input.addEventListener('input', searchDebounced);
    adultBox.addEventListener('change', () => {
        Settings.set('showAdult', adultBox.checked);
        search();
    });
    moreBtn.addEventListener('click', () => search({ append: true }));
    closeBtn.addEventListener('click', () => dialog.close());

    dialog.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            // Chromium consume Escape en <input type="search"> para vaciar el campo
            // y no llega a cerrar el <dialog>. Se cierra aquí y se evita el vaciado.
            event.preventDefault();
            dialog.close();
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(state.activeIndex + 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(state.activeIndex - 1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            setActive(0);
        } else if (event.key === 'End') {
            event.preventDefault();
            setActive(state.items.length - 1);
        } else if (event.key === 'Enter') {
            if (state.activeIndex >= 0 && state.items[state.activeIndex]) {
                event.preventDefault();
                choose(state.items[state.activeIndex]);
            }
        }
    });

    dialog.addEventListener('close', () => {
        controller?.abort();
        input.removeAttribute('aria-activedescendant');
        // Sin esto, reabrir el modal mostraria los resultados de la busqueda
        // anterior bajo el texto de "escribe el nombre de un anime".
        reset();
    });

    return {
        open(term = '') {
            adultBox.checked = Settings.get('showAdult');
            input.value = term;
            reset();
            dialog.showModal();
            input.focus();
            if (!term) input.select();

            if (term) search();
            else setStatus('Escribe el nombre de un anime para empezar.');
        },
        search,
        select(item) {
            choose(item);
        },
    };
}

/**
 * Sugerencias mientras se escribe el título. Devuelve los pocos campos que
 * necesita el formulario; el resto se completa al elegir.
 */
export function initAutocomplete({ input, box, onPick, minChars = 3 }) {
    if (!input || !box) return null;

    let controller = null;
    let items = [];
    let activeIndex = -1;

    const close = () => {
        box.hidden = true;
        box.replaceChildren();
        items = [];
        activeIndex = -1;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    };

    const setActive = (next) => {
        const options = [...box.querySelectorAll('.autocomplete__item')];
        if (!options.length) return;

        activeIndex = (next + options.length) % options.length;
        options.forEach((option, index) => {
            const isActive = index === activeIndex;
            option.classList.toggle('is-active', isActive);
            option.setAttribute('aria-selected', String(isActive));
            if (isActive) option.scrollIntoView({ block: 'nearest' });
        });

        input.setAttribute('aria-activedescendant', options[activeIndex].id);
    };

    async function lookup() {
        const term = input.value.trim();
        if (term.length < minChars) {
            close();
            return;
        }

        controller?.abort();
        controller = new AbortController();

        try {
            const data = await ApiClient.searchAnime(term, {
                adult: Settings.get('showAdult'),
                autocomplete: true,
                signal: controller.signal,
            });

            items = data.results || [];
            if (!items.length) {
                close();
                return;
            }

            box.replaceChildren(
                ...items.map((item, index) => el('button', {
                    id: `anime-suggestion-${index}`,
                    class: 'autocomplete__item',
                    type: 'button',
                    role: 'option',
                    'aria-selected': 'false',
                    dataset: { index: String(index) },
                    onClick: () => pick(item.title),
                },
                    item.cover_url
                        ? el('img', { src: item.cover_url, alt: '', loading: 'lazy' })
                        : el('span', { class: 'autocomplete__year', text: '•' }),
                    el('span', {},
                        el('span', { class: 'autocomplete__title', text: item.title }),
                        item.year ? el('span', { class: 'autocomplete__year', text: ` · ${item.year}` }) : null,
                    ),
                )),
            );

            box.hidden = false;
            input.setAttribute('aria-expanded', 'true');
        } catch (error) {
            if (error.name !== 'AbortError') close();
        }
    }

    function pick(title) {
        input.value = title;
        close();
        onPick?.(title);
    }

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', box.id || 'autocomplete');

    input.addEventListener('input', debounce(lookup, DEBOUNCE_MS));
    input.addEventListener('blur', () => setTimeout(close, 160));

    input.addEventListener('keydown', (event) => {
        if (box.hidden) return;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(activeIndex + 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(activeIndex - 1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            setActive(0);
        } else if (event.key === 'End') {
            event.preventDefault();
            setActive(items.length - 1);
        } else if (event.key === 'Enter' && activeIndex >= 0) {
            event.preventDefault();
            if (items[activeIndex]) pick(items[activeIndex].title);
        } else if (event.key === 'Escape') {
            close();
        }
    });

    return { close, lookup };
}