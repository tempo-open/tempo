/**
 * tempo: your own picture for the home, kept on this device: one file in Tempo's userdata folder
 * through the desktop bridge, or IndexedDB in a browser with no desktop shell. Client settings hold
 * only the choice of it, because they are rewritten whole on every change.
 */
import { useSyncExternalStore } from "react";

import type { OwnPicture } from "./homeArt";

/** The art is drawn at most about 1050 art pixels wide, so a longer side adds only bytes. */
const MAX_SIDE = 1600;
const PICTURE_TYPE = "image/webp";

interface PictureStorage {
  readonly read: () => Promise<Blob | null>;
  readonly write: (picture: Blob) => Promise<void>;
  readonly remove: () => Promise<void>;
}

const DATABASE_NAME = "tempo:home-picture";
const STORE_NAME = "picture";
const KEY = "home";
let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE_NAME));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => reject(new Error("The picture store is blocked.")));
  }));
}

async function withStore<A>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<A> | void,
) {
  const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
  const request = use(transaction.objectStore(STORE_NAME));
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  return request?.result;
}

const browserStorage: PictureStorage = {
  read: async () => ((await withStore("readonly", (store) => store.get(KEY))) as Blob) ?? null,
  write: async (picture) => {
    await withStore("readwrite", (store) => store.put(picture, KEY));
  },
  remove: async () => {
    await withStore("readwrite", (store) => store.delete(KEY));
  },
};

function desktopStorage(): PictureStorage | null {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.tempo;
  const read = bridge?.readHomePicture;
  const save = bridge?.saveHomePicture;
  const remove = bridge?.removeHomePicture;
  if (!read || !save || !remove) return null;
  return {
    read: async () => {
      const bytes = await read();
      return bytes && new Blob([bytes], { type: PICTURE_TYPE });
    },
    write: async (picture) => {
      if (!(await save(new Uint8Array(await picture.arrayBuffer())))) {
        throw new Error("The picture could not be saved.");
      }
    },
    remove,
  };
}

const storage = desktopStorage() ?? browserStorage;
/** The picture lives in this browser, not in Tempo's userdata folder. */
export const ownPictureInBrowser = storage === browserStorage;

let picture: OwnPicture = "reading";
let reading = false;
/** Counts saves and removals, so a first read that finishes after one never overrides it. */
let changes = 0;
const listeners = new Set<() => void>();

function show(saved: Blob | null) {
  if (typeof picture === "object") URL.revokeObjectURL(picture.url);
  picture = saved ? { url: URL.createObjectURL(saved) } : "none";
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!reading) {
    reading = true;
    const before = changes;
    void storage
      .read()
      .catch(() => null)
      .then((saved) => {
        if (changes === before) show(saved);
      });
  }
  return () => listeners.delete(listener);
}

const readNothing = () => () => {};

/**
 * Your own picture on this device, read once when first `wanted`. Unwanted, nothing is read and
 * the value is only a placeholder, for a home whose background is not the picture.
 */
export function useOwnPicture(wanted = true): OwnPicture {
  return useSyncExternalStore(
    wanted ? subscribe : readNothing,
    () => picture,
    () => picture,
  );
}

/** A copy small enough to keep, at most `MAX_SIDE` on a side; fails on a file that is no picture. */
async function preparePicture(file: Blob): Promise<Blob> {
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(image.width * scale)),
      Math.max(1, Math.round(image.height * scale)),
    );
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D canvas.");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await canvas.convertToBlob({ type: PICTURE_TYPE, quality: 0.92 });
  } finally {
    image.close();
  }
}

/** Keeps `file` as your own picture, replacing the one before. */
export async function saveOwnPicture(file: Blob): Promise<void> {
  const picture = await preparePicture(file);
  await storage.write(picture);
  changes++;
  show(picture);
}

export async function removeOwnPicture(): Promise<void> {
  await storage.remove();
  changes++;
  show(null);
}
