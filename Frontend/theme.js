/**
 * Tema claro/oscuro.
 * El <head> de cada página aplica el tema guardado antes de pintar para evitar
 * el parpadeo; este módulo gestiona el botón y la sincronización con el sistema.
 */

import { Settings } from './storage.js';

const MEDIA_QUERY = '(prefers-color-scheme: light)';

function systemTheme() {
    return window.matchMedia(MEDIA_QUERY).matches ? 'light' : 'dark';
}

export function getTheme() {
    return Settings.get('theme') || systemTheme();
}

export function applyTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = next === 'light' ? '#eef1f7' : '#0b0b12';
    return next;
}

export function setTheme(theme) {
    const applied = applyTheme(theme);
    Settings.set('theme', applied);
    return applied;
}

export function toggleTheme() {
    return setTheme(getTheme() === 'light' ? 'dark' : 'light');
}

/** Conecta el botón de tema y sigue los cambios del sistema si no hay elección. */
export function initThemeToggle(button) {
    const sync = () => {
        const isLight = getTheme() === 'light';
        if (button) {
            button.setAttribute('aria-pressed', String(isLight));
            button.setAttribute('aria-label', isLight ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro');
        }
    };

    if (button) {
        button.addEventListener('click', () => {
            toggleTheme();
            sync();
        });
    }

    window.matchMedia(MEDIA_QUERY).addEventListener('change', () => {
        if (!Settings.get('theme')) {
            applyTheme(systemTheme());
            sync();
        }
    });

    applyTheme(getTheme());
    sync();
}