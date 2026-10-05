/**
 * Portada pública.
 *
 * No pide nada al backend: la maqueta del hero está escrita en el HTML, así que
 * se puede abrir incluso con el backend caído. Lo único que se consulta es la
 * sesión local, para decidir si el botón principal dice "entrar" o "ir a mi
 * lista".
 */

import { ApiClient } from './api.js';
import { hydrateIcons } from './icons.js';
import { initThemeToggle } from './theme.js';

hydrateIcons();
initThemeToggle(document.getElementById('btn-theme'));

const signedIn = ApiClient.isAuthenticated();

if (signedIn) {
    // Con sesión abierta la portada no tiene nada que enseñar: al panel.
    window.location.replace('dashboard.html');
} else {
    // Sin sesión, los botones "Entrar" y "Ya tengo cuenta" son lo mismo.
    // Se deja solo "Crear cuenta" para no repetir el mismo enlace dos veces.
    document.querySelectorAll('.hero__actions .btn--ghost').forEach((node) => node.remove());
}

/* La cabecera se despega del resto al empezar a hacer scroll. */
const nav = document.getElementById('landing-nav');

if (nav) {
    const sentinel = document.createElement('div');
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px;pointer-events:none;';
    document.body.prepend(sentinel);

    new IntersectionObserver(
        ([entry]) => nav.classList.toggle('is-stuck', !entry.isIntersecting),
        { threshold: 0 },
    ).observe(sentinel);
}