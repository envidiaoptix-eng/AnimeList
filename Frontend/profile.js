/**
 * Perfil: avatar y banner.
 *
 * El recorte se hace aquí, en el cliente, y no en el servidor a propósito:
 *
 *   - Evita subir la foto original. Un selfie de 4 MB de móvil llega a ser 25 KB.
 *   - No hace falta Pillow ni ninguna dependencia nueva en Flask.
 *   - El servidor solo recibe el resultado final y lo valida por magic bytes.
 *
 * El recorte es tipo "cover": rellena el marco completo y recorta el sobrante
 * por el centro, que es lo que se espera de una foto de perfil. Sin esto, una
 * foto vertical dejaría la cabeza fuera del avatar.
 */

import { ApiClient, ApiError } from './api.js';
import { DataRepository } from './data_repository.js';
import { confirmDialog, el, toast, setStatus } from './ui.js';

const TARGETS = {
    avatar: { width: 256, height: 256, label: 'Avatar', maxInputBytes: 8 * 1024 * 1024 },
    banner: { width: 1500, height: 400, label: 'Banner', maxInputBytes: 12 * 1024 * 1024 },
    // Se recorta a cover como los otros dos, pero con mas margen: el fondo se
    // estira por pantalla completa con `background-size: cover` y depende de la
    // ventana, asi que 1920x1080 es el minimo razonable en un monitor normal.
    // Se baja la calidad al codificar (ver `JPEG_QUALITY_BACKGROUND`) porque
    // 1.4 MB en base64 ya se acerca al tope del servidor.
    background: { width: 1920, height: 1080, label: 'Fondo', maxInputBytes: 16 * 1024 * 1024 },
};

const JPEG_QUALITY = 0.82;

/* El fondo es mucho mas grande que el avatar, asi que a la misma calidad se pasa
   del tope de `BACKGROUND_MAX_BYTES`. Con 0.72 un 1920x1080 ocupa del orden de
   300-500 KB, que en base64 son ~400-700 KB: dentro del 1 MB del servidor y del
   `MAX_CONTENT_LENGTH` de 3 MB. Los otros dos tipos no notan el cambio. */
const JPEG_QUALITY_BACKGROUND = 0.72;


/* Espejo de `PASSWORD_MIN` / `PASSWORD_MAX` de `Backend/config.py`. Si allí
   cambian, hay que cambiarlos aquí también. El backend sigue siendo quien
   manda: esto solo evita una ida y vuelta para avisar de algo que ya se sabe. */
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;

/* `maxlength` del input de nombre visible, en `dashboard.html`. El backend
   acepta entre 1 y 50 (`routes_auth.py`), y sin este dato el guardado mandaba
   un nombre vacío y recibía un 400 con el motivo equivocado. */
const DISPLAY_NAME_MAX = 50;

const HTTP_URL = /^https?:\/\//i;

/* ------------------------------------------------------------------ */
/* Object URLs: los bytes se piden solo cuando se pintan               */
/* ------------------------------------------------------------------ */

// Cada object URL consume memoria hasta que se revoca, y las anteriores se
// quedarían colgando al cambiar de foto o de usuario.
const urls = new Map();

/* Petición en vuelo por tipo: dos pintadas concurrentes (arranque + refresco
   del perfil) solían pedir el mismo blob dos veces y la segunda `urls.set`
   tapaba a la primera, que nunca se revocaba. */
const inflight = new Map();

/* Contador por tipo: `releaseUrl` lo sube. Si una petición termina tras un
   release, su blob ya es el antiguo y no debe guardarse en caché (se vería
   la foto vieja hasta recargar). */
const generations = new Map();

function releaseUrl(kind) {
    const previous = urls.get(kind);
    if (previous) {
        URL.revokeObjectURL(previous);
        urls.delete(kind);
    }
    generations.set(kind, (generations.get(kind) || 0) + 1);
}

/**
 * Devuelve una URL lista para `<img src>`: la externa si el usuario tiene una,
 * o el object URL del endpoint autenticado si subió una.
 */
async function imageUrl(kind, profile) {
    if (!profile) return '';

    // Antes esto era `kind === 'avatar' ? avatar_url : banner_url`, asi que el
    // fondo caia siempre en `banner_url` y su URL externa no se llegaba a usar.
    // `${kind}_url` es el mismo nombre de campo en los dos casos que lo tienen.
    const external = profile[`${kind}_url`];
    if (external) return external;

    if (!profile[`has_${kind}`]) {
        releaseUrl(kind);
        return '';
    }

    if (urls.has(kind)) return urls.get(kind);
    if (inflight.has(kind)) return inflight.get(kind);

    const generation = generations.get(kind) || 0;
    const request = (async () => {
        try {
            const blob = await ApiClient.fetchProfileImage(kind);
            const url = URL.createObjectURL(blob);

            if ((generations.get(kind) || 0) !== generation) {
                // Se quitó o cambió la foto mientras se descargaba: estos bytes
                // ya no son los que se quieren ver. No se cachea, y la siguiente
                // pintada (encadenada tras esta) pedirá los nuevos.
                URL.revokeObjectURL(url);
                return '';
            }

            urls.set(kind, url);
            return url;
        } catch (error) {
            if (error instanceof ApiError && (error.status === 401 || error.status === 404)) return '';
            throw error;
        } finally {
            inflight.delete(kind);
        }
    })();

    inflight.set(kind, request);
    return request;
}

export function releaseAllImageUrls() {
    for (const kind of Object.keys(TARGETS)) releaseUrl(kind);
}

/* ------------------------------------------------------------------ */
/* Recorte con canvas                                                  */
/* ------------------------------------------------------------------ */

function readFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('No se ha podido leer el archivo.'));
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
    });
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('El archivo no es una imagen válida.'));
        img.src = src;
    });
}

/**
 * Abre el fichero respetando la orientación EXIF.
 *
 * Devuelve algo con `width`, `height`, `drawImage` y, si vino de un bitmap,
 * `close()` para liberar los bytes. El sprite intermedio es el que sabe leer
 * la EXIF; si el navegador no lo soporta, se usa el `<img>` de siempre y se
 * acepta que la foto salga girada.
 */
async function loadOriented(file) {
    if (typeof createImageBitmap === 'function') {
        try {
            return await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch {
            // Navegador sin soporte o PNG que no le gusta: se sigue por debajo.
        }
    }

    return loadImage(await readFile(file));
}

/**
 * Reescala con recorte *cover* y devuelve un blob JPEG.
 *
 * `createImageBitmap` con `imageOrientation: 'from-image'` aplica la
 * orientación EXIF antes de dibujar. Sin esto, una foto hecha en horizontal
 * con el móvil llega girada 90º y el recorte sale del revés. El `<img>`
 * sencillo no lo hace, y `createImageBitmap` no existe en todos los
 * navegadores, así que se recurre a él y se cae al camino antiguo si falla.
 *
 * @returns {Promise<{blob: Blob, dataUrl: string}>}
 */
export async function cropImage(file, kind) {
    const target = TARGETS[kind];
    if (!target) throw new Error('Tipo de imagen desconocido.');

    if (!/^image\/(png|jpeg)$/.test(file.type)) {
        throw new Error('Solo se admiten imágenes PNG o JPG.');
    }
    if (file.size > target.maxInputBytes) {
        const mb = Math.round(target.maxInputBytes / 1024 / 1024);
        throw new Error(`La imagen original supera los ${mb} MB.`);
    }

    const source = await loadOriented(file);
    const scale = Math.max(target.width / source.width, target.height / source.height);
    const w = source.width * scale;
    const h = source.height * scale;

    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, (target.width - w) / 2, (target.height - h) / 2, w, h);
    source.close?.();

    const quality = kind === 'background' ? JPEG_QUALITY_BACKGROUND : JPEG_QUALITY;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('El navegador no ha podido generar la imagen.');

    return { blob, dataUrl: canvas.toDataURL('image/jpeg', quality) };
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('No se ha podido preparar la imagen.'));
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.readAsDataURL(blob);
    });
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

const dom = {};

/**
 * Monta el diálogo de perfil. `paint` recibe el perfil ya actualizado para que
 * quien lo llama repinte cabecera y avatar.
 */
export function initProfileDialog({ paint }) {
    dom.dialog = document.getElementById('profile-dialog');
    dom.open = document.getElementById('btn-profile');
    dom.close = document.getElementById('profile-close');
    dom.form = document.getElementById('form-profile');
    dom.name = document.getElementById('profile-name');
    dom.status = document.getElementById('profile-status');
    dom.avatarImg = document.getElementById('profile-avatar');
    dom.avatarEmpty = document.getElementById('profile-avatar-empty');
    // OJO: el banner de la cabecera también se llama a secas; aquí va `-preview`
    // para no chocar de id con él (getElementById devuelve el primero del DOM).
    dom.bannerImg = document.getElementById('profile-banner-preview');
    dom.bannerEmpty = document.getElementById('profile-banner-empty');
    dom.avatarInput = document.getElementById('profile-avatar-file');
    dom.bannerInput = document.getElementById('profile-banner-file');
    dom.avatarRemove = document.getElementById('profile-avatar-remove');
    dom.bannerRemove = document.getElementById('profile-banner-remove');
    dom.avatarNote = document.getElementById('profile-avatar-note');
    dom.bannerNote = document.getElementById('profile-banner-note');
    dom.backgroundImg = document.getElementById('profile-background');
    dom.backgroundEmpty = document.getElementById('profile-background-empty');
    dom.backgroundLabel = document.getElementById('profile-background-label');
    dom.backgroundInput = document.getElementById('profile-background-file');
    dom.backgroundRemove = document.getElementById('profile-background-remove');
    dom.backgroundNote = document.getElementById('profile-background-note');
    dom.avatarUrl = document.getElementById('profile-avatar-url');
    dom.backgroundUrl = document.getElementById('profile-background-url');
    dom.avatarLabel = document.getElementById('profile-avatar-label');
    dom.bannerLabel = document.getElementById('profile-banner-label');
    dom.submit = dom.form.querySelector('button[type="submit"]');

    dom.password = document.getElementById('profile-password');
    dom.passwordCurrent = document.getElementById('password-current');
    dom.passwordNew = document.getElementById('password-new');
    dom.passwordRepeat = document.getElementById('password-repeat');
    dom.passwordSave = document.getElementById('password-save');
    dom.passwordStatus = document.getElementById('password-status');

    const username = ApiClient.getSession()?.username ?? '';

    let profile = null;
    /** Por qué falló `GET /api/me`. Antes se lo tragaba un `catch { profile = null }`
     *  sin dejar rastro, y guardar reventaba con un TypeError incomprensible. */
    let loadError = null;
    // { dataUrl } mientras el usuario no guarda; null significa "sin cambios".
    const staged = { avatar: null, banner: null };

    /** Un 401 o un 404 no se arreglan reintentando: el formulario se cierra. */
    const isFatalLoadError = (error) => error?.status === 401 || error?.status === 404;

    /** Traduce el fallo de `GET /api/me` a algo accionable. */
    const describeLoadError = (error) => {
        if (error?.status === 0) {
            return 'Sin conexión: no se ha podido leer tu perfil. Los cambios se guardarán al recuperar la red.';
        }
        if (error?.status === 401) return 'Tu sesión ha caducado. Cierra el perfil y vuelve a entrar.';
        if (error?.status === 404) return 'Esta cuenta ya no existe en el servidor.';
        return error?.message || 'No se ha podido cargar tu perfil.';
    };

    /** Cierra el formulario entero, para guardar o por un error irrecuperable. */
    const lockForm = () => {
        dom.name.disabled = true;
        dom.avatarUrl.disabled = true;
        dom.backgroundUrl.disabled = true;
        dom.avatarInput.disabled = true;
        dom.bannerInput.disabled = true;
        dom.avatarRemove.disabled = true;
        dom.bannerRemove.disabled = true;
        dom.backgroundRemove.disabled = true;
        dom.avatarLabel.classList.add('is-disabled');
        dom.bannerLabel.classList.add('is-disabled');
        dom.backgroundLabel.classList.add('is-disabled');
        dom.submit.disabled = true;
        dom.passwordCurrent.disabled = true;
        dom.passwordNew.disabled = true;
        dom.passwordRepeat.disabled = true;
        dom.passwordSave.disabled = true;
    };

    /** Lo contrario de `lockForm`. `fatal` deja el formulario cerrado del todo. */
    const unlockForm = ({ fatal = false } = {}) => {
        dom.name.disabled = fatal;
        dom.avatarUrl.disabled = fatal;
        dom.backgroundUrl.disabled = fatal;
        dom.avatarInput.disabled = fatal;
        dom.bannerInput.disabled = fatal;
        dom.avatarRemove.disabled = fatal;
        dom.bannerRemove.disabled = fatal;
        dom.backgroundRemove.disabled = fatal;
        dom.avatarLabel.classList.toggle('is-disabled', fatal);
        dom.bannerLabel.classList.toggle('is-disabled', fatal);
        dom.backgroundLabel.classList.toggle('is-disabled', fatal);
        dom.submit.disabled = fatal;
        dom.passwordCurrent.disabled = fatal;
        dom.passwordNew.disabled = fatal;
        dom.passwordRepeat.disabled = fatal;
        dom.passwordSave.disabled = fatal;
    };

    /**
     * Pinta la vista previa: lo staged si lo hay, si no la imagen ya guardada.
     *
     * Antes ponía `src = ''` cuando no había nada staged pero dejaba `hidden`
     * en false si el perfil tenía foto, así que se veía un `<img>` vacío (una
     * imagen rota) en vez de la foto. `imageUrl` es la misma función que usa la
     * cabecera y ya devuelve '' cuando no hay nada, y además reutiliza el
     * object URL en vez de descargar los bytes otra vez.
     */
    const preview = async (kind) => {
        const img = kind === 'avatar' ? dom.avatarImg : kind === 'banner' ? dom.bannerImg : dom.backgroundImg;
        const empty = kind === 'avatar' ? dom.avatarEmpty : kind === 'banner' ? dom.bannerEmpty : dom.backgroundEmpty;
        const note = kind === 'avatar' ? dom.avatarNote : kind === 'banner' ? dom.bannerNote : dom.backgroundNote;
        const stagedData = staged[kind];

        let src = '';
        let pending = false;

        if (stagedData === '') {
            // Quitada en este diálogo: se ve el hueco aunque haya una guardada.
            releaseUrl(kind);
        } else if (stagedData) {
            src = stagedData;
            pending = true;
        } else {
            src = await imageUrl(kind, profile);
        }

        const has = Boolean(src);
        if (has) {
            if (img.getAttribute('src') !== src) img.src = src;
        } else {
            // `src = ''` hace que algunos navegadores pidan la propia página.
            img.removeAttribute('src');
        }

        img.hidden = !has;
        empty.hidden = has;
        if (note) note.textContent = pending ? 'Sin guardar' : '';
    };

    /**
     * Lo que se lee en la línea de estado al abrir el diálogo.
     *
     * Para avatar y banner sirve el tamaño final. El fondo no: `1920×1080` no le
     * dice nada a quien lo elige, y además se estira a la ventana, así que lo
     * único honesto es decir si lo hay y con qué se atenúa para leer encima.
     */
    const describe = (kind) => {
        const target = TARGETS[kind];
        if (kind === 'background') {
            const hay = Boolean(profile?.background_url || profile?.has_background || staged.background);
            return hay ? 'Fondo de página activo · se atenúa para poder leer' : 'Sin fondo de página';
        }

        const current = profile?.[`${kind}_url`];
        if (!current && !staged[kind] && !profile?.[`has_${kind}`]) {
            return `Sin imagen · se guardará a ${target.width}×${target.height}`;
        }
        return `${target.width}×${target.height}`;
    };

    const refreshNotes = () => {
        dom.avatarNote.textContent = staged.avatar ? 'Sin guardar' : '';
        dom.bannerNote.textContent = staged.banner ? 'Sin guardar' : '';
    };

    const pick = async (kind, file) => {
        if (!file) return;
        // Vaciar el input antes de procesar: si se elige dos veces el mismo
        // archivo en la misma sesion, `value` no cambia, el navegador no dispara
        // `change` y no se vuelve a recortar. El `File` llega como argumento, asi
        // que vaciarlo no lo invalida.
        (kind === 'avatar' ? dom.avatarInput
            : kind === 'banner' ? dom.bannerInput
                : dom.backgroundInput).value = '';
        try {
            const { dataUrl } = await cropImage(file, kind);
            staged[kind] = dataUrl;
            await preview(kind);
            setStatus(dom.status, `${TARGETS[kind].label} recortada. Pulsa Guardar para subirla.`, 'success');
        } catch (error) {
            setStatus(dom.status, error.message, 'error');
        }
    };

    dom.avatarInput.addEventListener('change', () => pick('avatar', dom.avatarInput.files?.[0]));
    dom.bannerInput.addEventListener('change', () => pick('banner', dom.bannerInput.files?.[0]));
    dom.backgroundInput.addEventListener('change', () => pick('background', dom.backgroundInput.files?.[0]));

    const removeImage = async (kind) => {
        const target = TARGETS[kind];
        const ok = await confirmDialog({
            title: `Quitar el ${target.label.toLowerCase()}`,
            message: 'La imagen se borrará de tu perfil.',
            // La clave es `confirmLabel`: con `confirmText` el diálogo caía en
            // el valor por defecto y el botón decía "Confirmar".
            confirmLabel: 'Quitar',
            danger: true,
        });
        if (!ok) return;

        staged[kind] = '';
        await preview(kind);
        try {
            const updated = await ApiClient.removeProfileImage(kind);
            profile = updated.profile;
            await paint(profile);
            setStatus(dom.status, `${target.label} eliminada.`, 'success');
        } catch (error) {
            // La foto sigue puesta si no se pudo borrar: se deshace el `staged`
            // para no dejar la vista previa mintiendo sobre lo que hay guardado.
            staged[kind] = null;
            await preview(kind);
            setStatus(dom.status, error.message || 'No se ha podido eliminar la imagen.', 'error');
        }
    };

    dom.avatarRemove.addEventListener('click', () => removeImage('avatar'));
    dom.bannerRemove.addEventListener('click', () => removeImage('banner'));
    dom.backgroundRemove.addEventListener('click', () => removeImage('background'));

    dom.passwordSave.addEventListener('click', async () => {
        const current = dom.passwordCurrent.value;
        const next = dom.passwordNew.value;
        const repeat = dom.passwordRepeat.value;

        if (next !== repeat) {
            setStatus(dom.passwordStatus, 'Las dos contraseñas nuevas no coinciden.', 'error');
            dom.passwordRepeat.focus();
            return;
        }
        if (next.length < PASSWORD_MIN) {
            setStatus(dom.passwordStatus, `La contraseña necesita al menos ${PASSWORD_MIN} caracteres.`, 'error');
            dom.passwordNew.focus();
            return;
        }
        if (next.length > PASSWORD_MAX) {
            setStatus(dom.passwordStatus, `La contraseña no puede superar los ${PASSWORD_MAX} caracteres.`, 'error');
            return;
        }
        if (next === current) {
            setStatus(dom.passwordStatus, 'La contraseña nueva tiene que ser distinta de la actual.', 'error');
            return;
        }

        dom.passwordSave.disabled = true;
        setStatus(dom.passwordStatus, 'Cambiando…');

        try {
            await ApiClient.changePassword(current, next);
            dom.passwordCurrent.value = '';
            dom.passwordNew.value = '';
            dom.passwordRepeat.value = '';
            setStatus(dom.passwordStatus, '');
            dom.password.open = false;
            toast('Contraseña actualizada.', { type: 'success' });
        } catch (error) {
            // Un 401 aquí es «la contraseña actual no es correcta», no una sesión
            // caducada: por eso `changePassword` no deja que `api.js` cierre la
            // sesión. Si no se distinguieran, un 401 echaría al usuario del
            // formulario con una redirección a la pantalla de acceso.
            setStatus(
                dom.passwordStatus,
                error.status === 401
                    ? 'La contraseña actual no es correcta.'
                    : error.message || 'No se ha podido cambiar la contraseña.',
                'error',
            );
        } finally {
            dom.passwordSave.disabled = false;
        }
    });

    dom.form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const displayName = dom.name.value.trim();
        const avatarUrl = dom.avatarUrl.value.trim();
        const backgroundUrl = dom.backgroundUrl.value.trim();

        if (!displayName || displayName.length > DISPLAY_NAME_MAX) {
            setStatus(dom.status, `El nombre visible debe tener entre 1 y ${DISPLAY_NAME_MAX} caracteres.`, 'error');
            dom.name.focus();
            return;
        }

        // El backend rechaza con un 400 las URLs que no sean http(s), pero
        // comprobarlo aquí evita el viaje de ida y vuelta.
        if (avatarUrl && !HTTP_URL.test(avatarUrl)) {
            setStatus(dom.status, 'La URL de la imagen debe empezar por http o https.', 'error');
            dom.avatarUrl.focus();
            return;
        }

        if (backgroundUrl && !HTTP_URL.test(backgroundUrl)) {
            setStatus(dom.status, 'La URL del fondo debe empezar por http o https.', 'error');
            dom.backgroundUrl.focus();
            return;
        }

        lockForm();
        setStatus(dom.status, 'Guardando…');

        try {
            const current = profile || {};

            // Sin red solo se pueden encolar los campos de texto. Un banner son
            // ~120 KB de base64 y la cola vive en localStorage, con unos 5 MB de
            // cuota: encolarlo podría acabar vaciando la caché de animes.
            const hasImage = Object.keys(TARGETS).some((kind) => staged[kind]);
            const offline = !ApiClient.isAuthenticated() || navigator.onLine === false;
            if (hasImage && offline) {
                throw new ApiError('Las fotos necesitan conexión: vuelve a estar en línea para subirlas.', 0);
            }

            const fields = {};
            if (displayName !== (current.display_name || '')) fields.display_name = displayName;
            if (avatarUrl !== (current.avatar_url || '')) fields.avatar_url = avatarUrl;
            if (backgroundUrl !== (current.background_url || '')) fields.background_url = backgroundUrl;

            // `saveProfile` guarda por red y, si no hay, encola. Se usa tambien en
            // la ruta normal para no duplicar el try/catch del status 0.
            let updated = current;
            let queued = false;
            if (Object.keys(fields).length) {
                const saved = await DataRepository.saveProfile(fields, username);
                // `saved.profile` puede ser `null` cuando la operación se encola
                // sin conexión: no se pierde el resto de los flags del perfil.
                updated = saved.profile ? { ...current, ...saved.profile } : { ...current, ...fields };
                queued = saved.queued;
            }

            for (const kind of Object.keys(TARGETS)) {
                if (!staged[kind]) continue;
                const payload = await blobToBase64(await dataUrlToBlob(staged[kind]));
                updated = (await ApiClient.uploadProfileImage(kind, payload)).profile;
                // `imageUrl` cachea el object URL del blob ANTERIOR por tipo.
                // Limpiando solo `staged`, el `paint` de abajo pedia la URL y
                // devolvia esa: la cabecera se quedaba con la foto vieja hasta
                // recargar. Se suelta antes de repintar, que es cuando se usa.
                releaseUrl(kind);
                staged[kind] = null;
            }

            profile = updated;
            refreshNotes();
            dom.avatarUrl.value = profile?.avatar_url ?? '';
            dom.backgroundUrl.value = profile?.background_url ?? '';
            await paint(profile);
            dom.dialog.close();
            toast(
                queued ? 'Perfil actualizado. Se enviará al recuperar la conexión.' : 'Perfil actualizado.',
                { type: 'success' },
            );
        } catch (error) {
            setStatus(dom.status, error.message || 'No se ha podido guardar el perfil.', 'error');
        } finally {
            unlockForm({ fatal: isFatalLoadError(loadError) });
        }
    });

    dom.open.addEventListener('click', async () => {
        if (dom.dialog.open) return;
        loadError = null;
        try {
            profile = await ApiClient.getProfile();
        } catch (error) {
            // Sin este `catch` con nombre, `profile` se quedaba a null en
            // silencio y guardar leía `profile.display_name` de un null:
            // «Cannot read properties of null». Ahora el motivo se enseña.
            profile = null;
            loadError = error;
        }

        staged.avatar = null;
        staged.banner = null;
        staged.background = null;
        dom.name.value = profile?.display_name || '';
        dom.avatarUrl.value = profile?.avatar_url || '';
        dom.backgroundUrl.value = profile?.background_url || '';
        dom.avatarInput.value = '';
        dom.bannerInput.value = '';
        dom.backgroundInput.value = '';

        await Promise.all([preview('avatar'), preview('banner'), preview('background')]);

        if (loadError) {
            setStatus(dom.status, describeLoadError(loadError), isFatalLoadError(loadError) ? 'error' : null);
        } else {
            setStatus(dom.status, describe('avatar'));
        }

        // Con un 401 o un 404 cualquier guardado sería un intento en balde.
        unlockForm({ fatal: isFatalLoadError(loadError) });
        dom.dialog.showModal();
    });

    dom.close.addEventListener('click', () => dom.dialog.close());
    document.getElementById('profile-cancel')?.addEventListener('click', () => dom.dialog.close());

    dom.dialog.addEventListener('close', () => {
        staged.avatar = null;
        staged.banner = null;
        staged.background = null;
        dom.avatarImg.removeAttribute('src');
        dom.bannerImg.removeAttribute('src');
        dom.backgroundImg.removeAttribute('src');
        setStatus(dom.passwordStatus, '');
        dom.passwordCurrent.value = '';
        dom.passwordNew.value = '';
        dom.passwordRepeat.value = '';
        loadError = null;
        unlockForm();
    });
}

/* ------------------------------------------------------------------ */
/* Contraseña                                                        */
/* ------------------------------------------------------------------ */

function dataUrlToBlob(dataUrl) {
    return fetch(dataUrl).then((r) => r.blob());
}

export { TARGETS as PROFILE_IMAGE_TARGETS, imageUrl as profileImageUrl };

