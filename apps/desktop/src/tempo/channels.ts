/** tempo: IPC channels for the desktop's tempo bridge (`desktopBridge.tempo`). */
/** Agent turns running on the environments this desktop hosts, which hold back an update. */
export const TEMPO_REPORT_LOCAL_TURNS_CHANNEL = "desktop:tempo:report-local-turns";
/** The reading card's "Open in" target: whether a browser exists, and opening a document in it. */
export const TEMPO_DOCUMENT_APPS_CHANNEL = "desktop:tempo:document-apps";
export const TEMPO_OPEN_DOCUMENT_CHANNEL = "desktop:tempo:open-document";
/** Your own picture for the home: one file in the userdata folder, read, saved and removed. */
export const TEMPO_READ_HOME_PICTURE_CHANNEL = "desktop:tempo:read-home-picture";
export const TEMPO_SAVE_HOME_PICTURE_CHANNEL = "desktop:tempo:save-home-picture";
export const TEMPO_REMOVE_HOME_PICTURE_CHANNEL = "desktop:tempo:remove-home-picture";
/** The window's look, which the preload writes for the web's boot script before it paints. */
export const TEMPO_GET_LOOK_CHANNEL = "desktop:tempo:get-look";
