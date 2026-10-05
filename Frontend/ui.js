/**
 * Helpers de interfaz: construcción de nodos, avisos y diálogos.
 * Todo el texto se inserta con `text` (textContent), nunca con innerHTML,
 * así que el contenido de la API o del usuario no puede inyectar HTML.
 */

/** Crea un elemento. `attrs` admite class, text, dataset y onclick. */
export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);

    for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) continue;

        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, value);
    }

    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }

    return node;
}

function toastHost() {
    let host = document.getElementById('toasts');
    if (!host) {
        host = el('div', { id: 'toasts', class: 'toasts', role: 'region', 'aria-label': 'Avisos' });
        document.body.appendChild(host);
    }
    return host;
}

/** Aviso efímero. `action` añade un botón (por ejemplo, "Deshacer"). */
export function toast(message, { type = 'info', duration = 4500, action = null } = {}) {
    const node = el('div', { class: `toast toast--${type}`, role: 'status' },
        el('span', { class: 'toast__text', text: message }));

    let timer;
    const dismiss = () => {
        clearTimeout(timer);
        node.classList.add('is-leaving');
        node.addEventListener('animationend', () => node.remove(), { once: true });
        setTimeout(() => node.remove(), 400);
    };

    if (action) {
        node.appendChild(el('button', {
            class: 'toast__action',
            type: 'button',
            text: action.label,
            onClick: () => {
                dismiss();
                action.onClick();
            },
        }));
    }

    toastHost().appendChild(node);
    timer = setTimeout(dismiss, duration);
    return dismiss;
}

export function confirmDialog({
    title,
    message,
    confirmLabel = 'Confirmar',
    cancelLabel = 'Cancelar',
    danger = false,
} = {}) {
    return new Promise((resolve) => {
        const dialog = el('dialog', { class: 'modal modal--confirm' });

        const finish = (result) => {
            dialog.close();
            dialog.remove();
            resolve(result);
        };

        dialog.append(
            el('form', { method: 'dialog', class: 'modal__panel' },
                el('h2', { class: 'modal__title', text: title }),
                el('p', { class: 'modal__text', text: message }),
                el('div', { class: 'modal__actions' },
                    el('button', {
                        class: 'btn btn--ghost',
                        type: 'button',
                        text: cancelLabel,
                        onClick: () => finish(false),
                    }),
                    el('button', {
                        class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`,
                        type: 'button',
                        text: confirmLabel,
                        onClick: () => finish(true),
                    }),
                ),
            ),
        );

        dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            finish(false);
        });
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) finish(false);
        });

        document.body.appendChild(dialog);
        dialog.showModal();
        dialog.querySelector('.btn--primary, .btn--danger')?.focus();
    });
}

/** '?' -> '?', 26 -> '26 eps' */
export function formatEpisodes(episodes) {
    if (episodes === null || episodes === undefined || episodes === '' || episodes === '?') return '?';
    return `${episodes} eps`;
}

export function formatMeta(anime) {
    const parts = [];
    if (anime.year) parts.push(anime.year);

    const formatLabels = {
        TV: 'Serie TV',
        Movie: 'Película',
        OVA: 'OVA',
        ONA: 'ONA',
        Special: 'Especial',
        Music: 'Música',
    };
    const label = formatLabels[anime.format];
    if (label) parts.push(label);

    const episodes = formatEpisodes(anime.episodes);
    if (episodes !== '?') parts.push(episodes);

    return parts.join(' · ');
}

/** 470438 -> '470.438' */
export function formatCount(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value.toLocaleString('es-ES')
        : '';
}

/**
 * Insignias de "toda la historia" de AniList.
 *
 * El backend solo deja pasar los dos contextos conocidos, y cada uno trae su
 * `label` en español junto al `context` original en inglés, que se usa como
 * tooltip. Sin rankings (Kitsu, o anime fuera del ranking) devuelve lista vacía:
 * se prefiere no mostrar nada antes que inventar una posición.
 */
export function rankBadges(anime) {
    const rankings = Array.isArray(anime?.rankings) ? anime.rankings : [];
    return rankings
        .filter((entry) => entry && typeof entry.rank === 'number' && entry.label)
        .map((entry) => ({
            rank: entry.rank,
            label: entry.label,
            title: `${entry.label} · ${entry.context}`,
            context: entry.context,
        }));
}

/**
 * Resumen para fuentes sin ranking: Kitsu no publica posiciones, pero sí la nota
 * media y cuántos usuarios tienen el anime en sus listas.
 */
export function fallbackMeta(anime) {
    const parts = [];
    if (typeof anime?.score === 'number') parts.push(`nota ${anime.score}`);
    const lists = formatCount(anime?.lists);
    if (lists) parts.push(`${lists} en listas`);
    return parts.join(' · ');
}

export function debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}