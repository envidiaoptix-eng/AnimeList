/**
 * Iconos SVG en línea.
 *
 * Antes esto eran emojis (⛩️ 🔍 🗑 🎞️). El problema no era el estilo
 * sino el comportamiento: un emoji se dibuja con la fuente del sistema,
 * así que cambia de forma, tamaño y línea base entre Windows, macOS,
 * Android y Linux, y no admite color ni grosor. Además el emoji de papelera
 * salía multicolor en medio de una interfaz monocroma.
 *
 * Aquí cada icono es un trazado propio sobre una rejilla de 24x24 con
 * `currentColor`, así que hereda color, tamaño y grosor de su contexto.
 * Al estar en el DOM no hay peticiones ni sprite que sincronizar, y no hay
 * una segunda red de seguridad que cargar.
 */

const NS = 'http://www.w3.org/2000/svg';

/* Cada entrada es una lista de trazados `d`. Los circulos y rectangulos
   van reescritos como trazados para poder usar un solo tipo de elemento. */
const ICONS = {
    /* --- Navegacion y acciones --- */
    search: [
        'M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
        'M21 21l-4.35-4.35',
    ],
    plus: [
        'M12 5v14',
        'M5 12h14',
    ],
    close: [
        'M18 6 6 18',
        'M6 6l12 12',
    ],
    check: [
        'M20 6 9 17l-5-5',
    ],
    pencil: [
        'M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z',
    ],
    trash: [
        'M3 6h18',
        'M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6',
        'M18.5 6l-.8 13.1a2 2 0 0 1-2 1.9H8.3a2 2 0 0 1-2-1.9L5.5 6',
    ],
    'external-link': [
        'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
        'M15 3h6v6',
        'M10 14 21 3',
    ],
    'log-out': [
        'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4',
        'M16 17l5-5-5-5',
        'M21 12H9',
    ],

    /* --- Tema --- */
    sun: [
        'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
        'M12 2v2',
        'M12 20v2',
        'M4.93 4.93l1.41 1.41',
        'M17.66 17.66l1.41 1.41',
        'M2 12h2',
        'M20 12h2',
        'M6.34 17.66l-1.41-1.41',
        'M19.07 4.93l-1.41 1.41',
    ],
    moon: [
        'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z',
    ],

    /* --- Direccion --- */
    /* Solo el chevron hacia abajo: es el que usa el desplegable del formulario
       de alta, y al girar el elemento la forma invertida sale sola. */
    'chevron-down': ['M6 9l6 6 6-6'],

    /* --- Diseno de vista --- */
    'layout-grid': [
        'M4 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
        'M15 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
        'M15 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z',
        'M4 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z',
    ],
    'layout-list': [
        'M8 6h13',
        'M8 12h13',
        'M8 18h13',
        'M3.5 6h.01',
        'M3.5 12h.01',
        'M3.5 18h.01',
    ],

    /* --- Contenido --- */
    film: [
        'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z',
        'M8 4v16',
        'M16 4v16',
        'M3 9h5',
        'M3 15h5',
        'M16 9h5',
        'M16 15h5',
    ],
    image: [
        'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
        'M9 9.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0',
        'M21 15.5l-4.5-4.5L6 21',
    ],
    'image-plus': [
        'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
        'M12 8.5v7',
        'M8.5 12h7',
    ],
    'user-plus': [
        'M15 21v-1.5a4.5 4.5 0 0 0-4.5-4.5h-5A4.5 4.5 0 0 0 1 19.5V21',
        'M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
        'M19 8v6',
        'M22 11h-6',
    ],
    'user': [
        'M20 21v-1.5a4.5 4.5 0 0 0-4.5-4.5h-7A4.5 4.5 0 0 0 4 19.5V21',
        'M16 7.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    ],
    shield: [
        'M12 3l7.5 3v6c0 4.4-3.1 8.2-7.5 9.5C7.6 20.2 4.5 16.4 4.5 12V6Z',
        'M9 12.2l2.2 2.2L15.4 10',
    ],
    'bar-chart': [
        'M3 21h18',
        'M7 21V11',
        'M12 21V5',
        'M17 21v-6',
    ],
    'folder-open': [
        'M3 8a1 1 0 0 1 1-1h4.6l2 2.4H20a1 1 0 0 1 1 1V10',
        'M3 10h18l-2.2 8.4a1 1 0 0 1-1 .6H6.2a1 1 0 0 1-1-.6Z',
    ],
    /* La estrella va rellena: es la unica que representa una puntuacion. */
    star: {
        fill: true,
        d: [
            'M12 2.6l2.85 5.77 6.37.93-4.61 4.49 1.09 6.34L12 17.13l-5.7 3l1.09-6.34-4.61-4.49 6.37-.93Z',
        ],
    },

    /* --- Estados e indicadores --- */
    'wifi-off': [
        'M2 2l20 20',
        'M8.6 8.6A10.9 10.9 0 0 0 5 12.6',
        'M1.4 9a15.9 15.9 0 0 1 4.7-2.9',
        'M16.7 11.1a10.9 10.9 0 0 1 2.3 1.5',
        'M5.5 16a6 6 0 0 1 6.9 0',
        'M12 20h.01',
    ],
    sparkles: [
        'M11 3l1.7 4.6L17.5 9l-4.8 1.4L11 15l-1.7-4.6L4.5 9l4.8-1.4Z',
        'M18 14.5l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9Z',
        'M6 2.5l.6 1.6 1.6.6-1.6.6L6 6.9l-.6-1.6L3.8 4.7l1.6-.6Z',
    ],
    /* El aviso es el icono que usa `ui.js` para los `toast` de error. */
    alert: [
        'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
        'M12 7.5V12',
        'M12 16h.01',
    ],

    /* --- Marca --- */
    torii: [
        'M2.5 8.5a2.5 2.5 0 0 1 2.5-2.5h14a2.5 2.5 0 0 1 2.5 2.5Z',
        'M2 8.5h20',
        'M4.5 8.5V21',
        'M19.5 8.5V21',
        'M9 13.5h6',
        'M8.5 13.5V21',
        'M15.5 13.5V21',
    ],
};

/** Normaliza una entrada a `{ d: [...], fill }`. */
function spec(name) {
    const entry = ICONS[name];
    if (!entry) throw new Error(`Icono desconocido: ${name}`);
    return Array.isArray(entry) ? { d: entry, fill: false } : entry;
}

/**
 * Devuelve un `<svg>` listo para insertar.
 *
 * @param {string} name        clave de `ICONS`
 * @param {object} [options]
 * @param {number} [options.size=20]    lado en px
 * @param {string} [options.class]      clases extra
 * @param {string} [options.title]      nombre accesible; sin el, `aria-hidden`
 * @param {number} [options.strokeWidth=1.75]
 */
export function icon(name, { size = 20, class: extra = '', title = null, strokeWidth = 1.75 } = {}) {
    const { d, fill } = spec(name);
    const svg = document.createElementNS(NS, 'svg');

    svg.setAttribute('class', extra ? `icon ${extra}` : 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('aria-hidden', title ? null : 'true');

    if (title) {
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', title);
    } else {
        // Safari mantiene los SVG en el orden de tabulacion aunque no sean
        // interactivos, asi que hay que expulsarlos a mano.
        svg.setAttribute('focusable', 'false');
    }

    if (fill) {
        svg.setAttribute('fill', 'currentColor');
        svg.setAttribute('stroke', 'none');
    } else {
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', strokeWidth);
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
    }

    for (const data of d) {
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', data);
        svg.appendChild(path);
    }

    return svg;
}

/**
 * Sustituye los `<i data-icon="nombre">` del HTML estatico por su SVG.
 *
 * Escribir los trazados a mano en cada pagina significaba tener la misma
 * forma repetida en cuatro ficheros, con el riesgo de que se desincronicen.
 * El marcador en el HTML solo declara cual usa; la geometria vive aqui.
 *
 * Las clases del marcador se trasladan al SVG, asi que `<i data-icon="search"
 * class="icon--sm">` da un icono de 16 px.
 */
export function hydrateIcons(root = document) {
    for (const slot of root.querySelectorAll('[data-icon]')) {
        const { icon: name, iconSize, iconTitle } = slot.dataset;

        if (!name) continue;

        try {
            slot.replaceWith(icon(name, {
                class: slot.className || '',
                title: iconTitle || null,
                ...(iconSize ? { size: Number(iconSize) } : {}),
            }));
        } catch (error) {
            // Un nombre mal escrito no debe dejar media pagina sin pintar:
            // se avisa por consola y el marcador se queda como estaba.
            console.warn(error.message, slot.outerHTML);
        }
    }
}