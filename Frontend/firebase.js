/**
 * Capa opcional de Firebase: Firestore (copia de listas) y Storage (imágenes).
 *
 * El SDK se carga dinámicamente desde el CDN y SOLO si hay configuración
 * válida, así que con FIREBASE_ENABLED en false no se descarga nada.
 *
 * La interfaz pública es la que data_repository.js espera en window.FirebaseService:
 *   isInitialized() · getAnimes() · addAnime() · updateAnime() · deleteAnime()
 *   uploadImage() · mirrorAll() · signInAnonymously()
 */

import { FIREBASE_CONFIG, FIREBASE_ENABLED, hasValidConfig } from './firebase-config.js';

const SDK_VERSION = '10.12.2';
const SDK_BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

const state = {
    initialized: false,
    db: null,
    storage: null,
    reason: 'no habilitado',
};

const collection = (username) => `users/${username}/anime`;

function firestoreRules() {
    return `
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null
                          && request.auth.token.username == userId;

      match /anime/{animeId} {
        allow read, write: if request.auth != null
                            && request.auth.token.username == userId;
      }
    }
  }
}
`;
}

/**
 * Inicializa Firebase si procede. Devuelve false si no hay configuración o si
 * el CDN no está disponible, y en ambos casos la app sigue con Flask.
 */
export async function initFirebase() {
    if (state.initialized) return true;

    if (!FIREBASE_ENABLED) {
        state.reason = 'FIREBASE_ENABLED está en false';
        return false;
    }
    if (!hasValidConfig()) {
        state.reason = 'faltan claves en firebase-config.js';
        return false;
    }

    try {
        const [app, firestore, storage] = await Promise.all([
            import(`${SDK_BASE}/firebase-app.js`),
            import(`${SDK_BASE}/firebase-firestore.js`),
            import(`${SDK_BASE}/firebase-storage.js`),
        ]);

        const firebaseApp = app.getApps().length
            ? app.getApp()
            : app.initializeApp(FIREBASE_CONFIG);

        state.db = firestore.getFirestore(firebaseApp);
        state.storage = storage.getStorage(firebaseApp);
        state.initialized = true;
        state.reason = 'listo';
        return true;
    } catch (error) {
        state.reason = `SDK no disponible: ${error.message}`;
        console.warn('[Firebase] desactivado:', state.reason);
        return false;
    }
}

/** Sube una imagen a Storage y devuelve su URL pública. */
export async function uploadImage(file, { folder = 'covers', username } = {}) {
    if (!state.initialized || !state.storage) {
        throw new Error('Firebase no está activo.');
    }

    const { ref, uploadBytes, getDownloadURL } = await import(
        `${SDK_BASE}/firebase-storage.js`
    );

    const extension = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
    const target = ref(state.storage, `${folder}/${username}/${name}`);

    await uploadBytes(target, file, { contentType: file.type });
    return getDownloadURL(target);
}

/** Copia la lista completa a Firestore (una escritura por documento). */
export async function mirrorAll(username, animes) {
    if (!state.initialized) return 0;

    const { collection: fsCollection, doc, setDoc, writeBatch } = await import(
        `${SDK_BASE}/firebase-firestore.js`
    );

    const batch = writeBatch(state.db);
    const reference = fsCollection(state.db, collection(username));

    for (const anime of animes) {
        batch.set(doc(reference, anime.id), anime, { merge: true });
    }

    await batch.commit();
    return animes.length;
}

export const FirebaseService = {
    isInitialized() {
        return state.initialized;
    },

    reason() {
        return state.reason;
    },

    async getAnimes(username) {
        if (!state.initialized) return null;
        const { collection: fsCollection, getDocs } = await import(
            `${SDK_BASE}/firebase-firestore.js`
        );
        const snapshot = await getDocs(fsCollection(state.db, collection(username)));
        return snapshot.docs.map((entry) => entry.data());
    },

    async addAnime(username, anime) {
        if (!state.initialized) return null;
        const { collection: fsCollection, doc, setDoc } = await import(
            `${SDK_BASE}/firebase-firestore.js`
        );
        await setDoc(doc(fsCollection(state.db, collection(username)), anime.id), anime, { merge: true });
        return anime;
    },

    async updateAnime(username, anime) {
        return this.addAnime(username, anime);
    },

    async deleteAnime(username, animeId) {
        if (!state.initialized) return false;
        const { collection: fsCollection, doc, deleteDoc } = await import(
            `${SDK_BASE}/firebase-firestore.js`
        );
        await deleteDoc(doc(fsCollection(state.db, collection(username)), animeId));
        return true;
    },

    async signInAnonymously() {
        if (!state.initialized) return null;
        const { getApp } = await import(`${SDK_BASE}/firebase-app.js`);
        const { getAuth, signInAnonymously } = await import(`${SDK_BASE}/firebase-auth.js`);
        const credential = await signInAnonymously(getAuth(getApp()));
        return credential.user;
    },

    uploadImage,
    mirrorAll,
    firestoreRules,
};