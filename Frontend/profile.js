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
import { confirmDialog, el, toast } from './ui.js';

const TARGETS = {
    avatar: { width: 256, height: 256, label: 'Avatar', maxInputBytes: 8 * 1024 * 1024 },
    banner: { width: 1500, height: 400, label: 'Banner', maxInputBytes: 12 * 1024 * 1024 },
};

const JPEG_QUALITY = 0.82;

/* ------------------------------------------------------------------ */
/* Object URLs: los bytes se piden solo cuando se pintan               */
/* ------------------------------------------------------------------ */

// Cada object URL consume memoria hasta que se revoca, y las anteriores se
// quedarían colgando al cambiar de foto o de usuario.
const urls = new Map();

function releaseUrl(kind) {
    const previous = urls.get(kind);
    if (previous) {
        URL.revokeObjectURL(previous);
        urls.delete(kind);
    }
}

/**
 * Devuelve una URL lista para `<img src>`: la externa si el usuario tiene una,
 * o el object URL del endpoint autenticado si subió una.
 */
async function imageUrl(kind, profile) {
    if (!profile) return '';

    const external = kind === 'avatar' ? profile.avatar_url : profile.banner_url;
    if (external) return external;

    if (!profile[`has_${kind}`]) {
        releaseUrl(kind);
        return '';
    }

    if (urls.has(kind)) return urls.get(kind);

    try {
        const blob = await ApiClient.fetchProfileImage(kind);
        const url = URL.createObjectURL(blob);
        urls.set(kind, url);
        return url;
    } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 404)) return '';
        throw error;
    }
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
 * Reescala con recorte *cover* y devuelve un blob JPEG.
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

    const img = await loadImage(await readFile(file));
    const scale = Math.max(target.width / img.width, target.height / img.height);
    const w = img.width * scale;
    const h = img.height * scale;

    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (target.width - w) / 2, (target.height - h) / 2, w, h);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) throw new Error('El navegador no ha podido generar la imagen.');

    return { blob, dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY) };
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

    let profile = null;
    // { dataUrl } mientras el usuario no guarda; null significa "sin cambios".
    const staged = { avatar: null, banner: null };

    const preview = (kind) => {
        const img = kind === 'avatar' ? dom.avatarImg : dom.bannerImg;
        const empty = kind === 'avatar' ? dom.avatarEmpty : dom.bannerEmpty;
        const note = kind === 'avatar' ? dom.avatarNote : dom.bannerNote;
        const stagedData = staged[kind];

        const has = stagedData ? true : Boolean(kind === 'avatar' ? profile?.has_avatar : profile?.has_banner);
        if (stagedData) img.src = stagedData;
        else img.src = '';

        img.hidden = !has;
        empty.hidden = has;
        if (note) note.textContent = stagedData ? 'Sin guardar' : '';
    };

    const describe = async (kind) => {
        const target = TARGETS[kind];
        const current = kind === 'avatar' ? profile?.avatar_url : profile?.banner_url;
        if (!current && !staged[kind] && !(kind === 'avatar' ? profile?.has_avatar : profile?.has_banner)) {
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
        try {
            const { dataUrl } = await cropImage(file, kind);
            staged[kind] = dataUrl;
            const img = kind === 'avatar' ? dom.avatarImg : dom.bannerImg;
            const empty = kind === 'avatar' ? dom.avatarEmpty : dom.bannerEmpty;
            img.src = dataUrl;
            img.hidden = false;
            empty.hidden = true;
            refreshNotes();
            dom.status.textContent = `${TARGETS[kind].label} recortada. Pulsa Guardar para subirla.`;
            dom.status.className = 'form-status is-success';
        } catch (error) {
            dom.status.textContent = error.message;
            dom.status.className = 'form-status is-error';
        }
    };

    dom.avatarInput.addEventListener('change', () => pick('avatar', dom.avatarInput.files?.[0]));
    dom.bannerInput.addEventListener('change', () => pick('banner', dom.bannerInput.files?.[0]));

    const removeImage = async (kind) => {
        const target = TARGETS[kind];
        const ok = await confirmDialog({
            title: `Quitar el ${target.label.toLowerCase()}`,
            message: 'La imagen se borrará de tu perfil.',
            confirmText: 'Quitar',
            danger: true,
        });
        if (!ok) return;

        staged[kind] = '';
        preview(kind);
        try {
            const updated = await ApiClient.removeProfileImage(kind);
            profile = updated.profile;
            await paint(profile);
            dom.status.textContent = `${target.label} eliminada.`;
            dom.status.className = 'form-status is-success';
        } catch (error) {
            dom.status.textContent = error.message || 'No se ha podido eliminar la imagen.';
            dom.status.className = 'form-status is-error';
        }
    };

    dom.avatarRemove.addEventListener('click', () => removeImage('avatar'));
    dom.bannerRemove.addEventListener('click', () => removeImage('banner'));

    dom.form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const displayName = dom.name.value.trim();
        const submit = dom.form.querySelector('button[type="submit"]');
        submit.disabled = true;
        dom.status.textContent = 'Guardando…';
        dom.status.className = 'form-status';

        try {
            let current = profile;
            if (displayName !== (profile.display_name || '')) {
                current = (await ApiClient.updateProfile({ display_name: displayName })).profile;
            }

            for (const kind of Object.keys(TARGETS)) {
                if (!(kind in staged) || staged[kind] === null) continue;
                if (staged[kind] === '') continue;
                const payload = await blobToBase64(await dataUrlToBlob(staged[kind]));
                current = (await ApiClient.uploadProfileImage(kind, payload)).profile;
                staged[kind] = null;
            }

            profile = current;
            refreshNotes();
            await paint(profile);
            dom.dialog.close();
            toast('Perfil actualizado.', { type: 'success' });
        } catch (error) {
            dom.status.textContent = error.message || 'No se ha podido guardar el perfil.';
            dom.status.className = 'form-status is-error';
        } finally {
            submit.disabled = false;
        }
    });

    dom.open.addEventListener('click', async () => {
        try {
            profile = await ApiClient.getProfile();
        } catch {
            profile = null;
        }

        staged.avatar = null;
        staged.banner = null;
        dom.name.value = profile?.display_name || '';
        dom.avatarInput.value = '';
        dom.bannerInput.value = '';

        await Promise.all([preview('avatar'), preview('banner')]);
        dom.status.textContent = describe('avatar');
        dom.status.className = 'form-status';
        dom.dialog.showModal();
    });

    dom.close.addEventListener('click', () => dom.dialog.close());
    document.getElementById('profile-cancel')?.addEventListener('click', () => dom.dialog.close());

    dom.dialog.addEventListener('close', () => {
        staged.avatar = null;
        staged.banner = null;
        dom.avatarImg.src = '';
        dom.bannerImg.src = '';
    });
}

function dataUrlToBlob(dataUrl) {
    return fetch(dataUrl).then((r) => r.blob());
}

export { TARGETS as PROFILE_IMAGE_TARGETS, imageUrl as profileImageUrl };