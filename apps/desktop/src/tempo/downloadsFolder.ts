// @effect-diagnostics nodeBuiltinImport:off - will-download needs its path synchronously.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

/** The first free path for `fileName` in `directory`, numbered as browsers number copies. */
export function freeDownloadPath(
  directory: string,
  fileName: string,
  exists: (path: string) => boolean = NodeFS.existsSync,
): string | null {
  const extension = NodePath.extname(fileName);
  const stem = NodePath.basename(fileName, extension) || "download";
  for (let copy = 0; copy < 100; copy += 1) {
    const name = copy === 0 ? `${stem}${extension}` : `${stem} (${copy})${extension}`;
    const path = NodePath.join(directory, name);
    if (!exists(path)) return path;
  }
  return null;
}

/**
 * tempo: what the window saves (Save file, exports) goes to Downloads and shows in Finder, as preview
 * downloads do. Left alone, Electron asks with a save dialog that opens where the last save went.
 */
export function saveWindowDownloadsToDownloads(window: Electron.BrowserWindow): void {
  const contents = window.webContents;
  const session = contents.session;
  const place = (
    _event: Electron.Event,
    item: Electron.DownloadItem,
    source: Electron.WebContents,
  ) => {
    if (source !== contents) return;
    const path = freeDownloadPath(Electron.app.getPath("downloads"), item.getFilename());
    if (path === null) return;
    item.setSavePath(path);
    item.once("done", (_doneEvent, state) => {
      if (state === "completed") Electron.shell.showItemInFolder(path);
    });
  };
  session.on("will-download", place);
  contents.once("destroyed", () => session.off("will-download", place));
}
