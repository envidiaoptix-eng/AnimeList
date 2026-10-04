/**
 * Configuración de Firebase.
 *
 * ESTÁ DESACTIVADO A PROPÓSITO. Para encenderlo:
 *   1. Crea el proyecto en https://console.firebase.google.com
 *   2. Añade una app web y copia aquí los datos de Firebase Console
 *     (Project settings > Your apps > SDK setup and configuration)
 *   3. Pon FIREBASE_ENABLED en true
 *
 * Flask sigue siendo la fuente de verdad: Firestore actúa como copia y
 * Storage como alojamiento de imágenes. Mientras esté en false, la aplicación
 * funciona igual con Flask + localStorage y este archivo no carga nada.
 */

export const FIREBASE_CONFIG = {
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: '',
};

export const FIREBASE_ENABLED = false;

/** Debe devolver true para que la configuración se considere válida. */
export function hasValidConfig(config = FIREBASE_CONFIG) {
    return Boolean(config?.apiKey && config?.projectId && config?.appId);
}