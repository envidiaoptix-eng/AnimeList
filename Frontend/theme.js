/**
 * Tema claro/oscuro.
 *
 * El <head> de cada página aplica el tema guardado antes de pintar para evitar
 * el parpadeo inicial; este módulo gestiona el botón, la transición y la
 * sincronización con el sistema.
 */

import { Settings } from './storage.js';
import { icon } from './icons.js';

const MEDIA_QUERY = '(prefers-color-scheme: light)';

/* Debe coincidir con `--dur-slow` de css/tokens.css. */
const TRANSITION_MS = 320;

/* El color de la barra del navegador móvil va aparte del fondo: los dos
   valores se han movido al cambiar de tema y si no, al recargar, el
   navegador conserva el antiguo durante un instante. */
const THEME_COLOR = { light: '#f4f6fa', dark: '#0a0b10' };

function systemTheme() {
    return window.matchMedia(MEDIA_QUERY).matches ? 'light' : 'dark';
}

export function getTheme() {
    return Settings.get('theme') || systemTheme();
}

/**
 * Aplica el tema. Con `animate` se marca `html` durante la transición para
 * que el cambio de color se vea: sin esa clase, poner `transition` en el
 * CSS de forma permanente haría que cada hover y cada foco se moviesen
 * cada vez que se cambia de tema.
 */
export function applyTheme(theme, { animate = false } = {}) {
    const next = theme === 'light' ? 'light' : 'dark';
    const root = document.documentElement;
    const previous = root.dataset.theme;

    if (animate && previous && previous !== next && !prefersReducedMotion()) {
        root.classList.add('is-theme-switching');
        // Sin temporizador la clase se quedaria puesta y el siguiente
        // hover saldria lento para siempre.
        window.clearTimeout(applyTheme.timer);
        applyTheme.timer = window.setTimeout(() => {
            root.classList.remove('is-theme-switching');
        }, TRANSITION_MS);
    }

    root.dataset.theme = next;
    root.style.colorScheme = next;

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = THEME_COLOR[next];

    return next;
}

function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function setTheme(theme) {
    const applied = applyTheme(theme, { animate: true });
    Settings.set('theme', applied);
    return applied;
}

export function toggleTheme() {
    return setTheme(getTheme() === 'light' ? 'dark' : 'light');
}

/**
 * Conecta el botón de tema y sigue los cambios del sistema si no hay elección.
 *
 * El icono se reconstruye aquí en lugar de cambiarlo con `content` en CSS: el
 * icono de antes era un carácter Unicode, que es justo lo que este rediseño
 * elimina de la interfaz.
 */
export function initThemeToggle(button) {
    const paint = () => {
        if (!button) return;

        const isLight = getTheme() === 'light';
        button.setAttribute('aria-pressed', String(isLight));
        button.setAttribute('aria-label', isLight ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro');
        button.replaceChildren(icon(isLight ? 'moon' : 'sun'));
    };

    if (button) {
        button.addEventListener('click', () => {
            toggleTheme();
            paint();
        });
    }

    window.matchMedia(MEDIA_QUERY).addEventListener('change', () => {
        // Una eleccion explicita gana al sistema: si no, cambiar el tema del
        // SO a mitad de sesion dejaria la pagina incoherentente con lo guardado.
        if (!Settings.get('theme')) {
            applyTheme(systemTheme(), { animate: true });
            paint();
        }
    });

    applyTheme(getTheme());
    paint();
}