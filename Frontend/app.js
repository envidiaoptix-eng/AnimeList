/**
 * Páginas de acceso: registro e inicio de sesión.
 * Guarda la sesión (usuario + token Bearer) y salta al panel.
 */

import { ApiClient, ApiError } from './api.js';
import { initThemeToggle } from './theme.js';
import { hydrateIcons } from './icons.js';
import { toast, setStatus } from './ui.js';

hydrateIcons();
initThemeToggle(document.getElementById('btn-theme'));

/** Si ya hay sesión válida, no hay nada que hacer aquí. */
if (ApiClient.isAuthenticated()) {
    location.replace('dashboard.html');
}

function busy(form, isBusy) {
    const button = form.querySelector('button[type="submit"]');
    button.disabled = isBusy;
    button.setAttribute('aria-busy', String(isBusy));
    button.textContent = isBusy ? 'Un momento…' : button.dataset.label;
}

const registerForm = document.getElementById('form-registro');
const loginForm = document.getElementById('form-login');

if (registerForm) {
    const status = document.getElementById('register-status');
    const password = document.getElementById('password');
    const password2 = document.getElementById('password2');
    registerForm.querySelector('button[type="submit"]').dataset.label = 'Crear cuenta';

    registerForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        setStatus(status, '');

        const username = registerForm.usuario.value.trim();
        const first = password.value;

        if (first !== password2.value) {
            setStatus(status, 'Las contraseñas no coinciden.', 'error');
            password2.focus();
            return;
        }

        busy(registerForm, true);
        try {
            await ApiClient.register(username, first);
            location.href = 'dashboard.html';
        } catch (error) {
            const message = error instanceof ApiError ? error.message : 'Error inesperado.';
            setStatus(status, message, 'error');
            if (error instanceof ApiError && error.status === 409) registerForm.usuario.focus();
            busy(registerForm, false);
        }
    });
}

if (loginForm) {
    const status = document.getElementById('login-status');
    loginForm.querySelector('button[type="submit"]').dataset.label = 'Entrar';

    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        setStatus(status, '');

        const username = loginForm.usuario.value.trim();
        busy(loginForm, true);

        try {
            await ApiClient.login(username, loginForm.password.value);
            location.href = 'dashboard.html';
        } catch (error) {
            const message = error instanceof ApiError
                ? error.message
                : 'No se pudo contactar con el servidor.';
            setStatus(status, message, 'error');
            loginForm.password.value = '';
            loginForm.password.focus();
            busy(loginForm, false);
        }
    });
}

window.addEventListener('offline', () => {
    if (registerForm || loginForm) toast('Sin conexión: revisa que el backend esté encendido.', { type: 'error' });
});