// @effect-diagnostics globalTimers:off globalFetch:off - This browser and WebView transport runs without an Effect runtime.
import { claimsBrowserControl } from "@t3tools/shared/tempoBrowserControl";
import { TEMPO_CLI_NAME } from "@t3tools/shared/tempoBrand";
import { type DeviceHubAccess, withDeviceHubQuery } from "../device/hubAccess.ts";
import {
  PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE,
  type PreviewStreamHostSetup,
  type PreviewViewportSetting,
} from "@t3tools/contracts";

export const PREVIEW_STREAM_BASE_PATH = "/api/preview-stream";

export interface PreviewStreamViewport {
  readonly width: number;
  readonly height: number;
}

export type PreviewStreamMouseButton = "none" | "left" | "middle" | "right";

export interface PreviewStreamControl {
  readonly canOperate: boolean;
  readonly controller: "agent" | "you" | "another-viewer" | "unclaimed";
  readonly generation: number;
  readonly dialog: null | {
    readonly type: string;
    readonly message: string;
    readonly defaultValue: string;
  };
}

// tempo: no control label; clients show no control bar.

const isPreviewStreamDialog = (value: unknown): value is PreviewStreamControl["dialog"] =>
  value === null ||
  (typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "defaultValue" in value &&
    typeof value.defaultValue === "string");

/** Coordinates are page CSS px. */
export type PreviewStreamInput =
  // tempo: `send` claims the tab before deliberate input itself; older servers
  // need the claim, and older clients still release.
  | { readonly type: "takeControl" }
  | { readonly type: "releaseControl" }
  | { readonly type: "dialog"; readonly accept: boolean; readonly promptText?: string }
  | { readonly type: "viewport"; readonly setting: PreviewViewportSetting }
  | {
      readonly type: "mouse";
      readonly action: "move" | "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button: PreviewStreamMouseButton;
      /** Pressed buttons: left 1, right 2, middle 4. */
      readonly buttons: number;
      readonly clickCount: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "key";
      readonly action: "down" | "up";
      readonly key: string;
      readonly code: string;
      /** Windows virtual key code (DOM `keyCode`); Enter, Backspace, and arrows need it. */
      readonly keyCode?: number;
      /** Only for printable keys without Ctrl or Meta. */
      readonly text?: string;
      readonly modifiers: number;
    }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "history"; readonly delta: -1 | 1 }
  | { readonly type: "reload"; readonly ignoreCache?: boolean }
  | { readonly type: "probe"; readonly x: number; readonly y: number };

export interface PreviewStreamDownload {
  readonly fileName: string;
  readonly sizeBytes: number;
  /** Authenticated with the stream's own access; cookie sessions must send credentials. */
  readonly url: string;
}

export interface PreviewStreamFileChooser {
  readonly multiple: boolean;
  readonly accept: string;
  /** POST multipart `file` parts here; an empty form cancels the page's picker. */
  readonly uploadUrl: string;
  readonly credentials: boolean;
}

const previewStreamUploadUrl = (
  target: Pick<PreviewStreamTarget, "access" | "threadId" | "tabId">,
  chooser: string,
): string =>
  withDeviceHubQuery(
    `${target.access.httpBase}/upload?${new URLSearchParams({
      threadId: target.threadId,
      tabId: target.tabId,
      chooser,
    }).toString()}`,
    target.access,
  );

export async function uploadPreviewStreamFiles(
  chooser: PreviewStreamFileChooser,
  files: ReadonlyArray<Blob & { readonly name?: string }>,
): Promise<void> {
  const body = new FormData();
  for (const file of files) body.append("file", file, file.name ?? "file");
  const response = await fetch(chooser.uploadUrl, {
    method: "POST",
    body,
    credentials: chooser.credentials ? "include" : "omit",
  });
  if (!response.ok) throw new Error((await response.text()) || "The upload was refused.");
}

export const previewStreamDownloadUrl = (
  target: Pick<PreviewStreamTarget, "access" | "threadId" | "tabId">,
  id: string,
): string =>
  withDeviceHubQuery(
    `${target.access.httpBase}/download?${new URLSearchParams({
      threadId: target.threadId,
      tabId: target.tabId,
      id,
    }).toString()}`,
    target.access,
  );

export interface PreviewStreamProbe {
  readonly x: number;
  readonly y: number;
  readonly editable: boolean;
}

export interface PreviewStreamPointer {
  readonly phase: "move" | "click";
  readonly x: number;
  readonly y: number;
  readonly sequence: number;
}

export const previewStreamModifiers = (event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

export interface PreviewStreamTarget {
  readonly access: DeviceHubAccess;
  readonly threadId: string;
  readonly tabId: string;
  /** Viewer backing-store size in device px. The server never sends larger frames. */
  readonly maxWidth: number;
  readonly maxHeight: number;
  // tempo: nothing grants control automatically any more.
  /** Passive viewers reduce their own access to read-only. */
  readonly interactive?: boolean;
}

export interface PreviewStreamEvents {
  /**
   * tempo: `page` is the CSS size the frame shows, which the server sends ahead of
   * each frame; servers from before send none, and their viewport stands in.
   */
  readonly onFrame: (jpeg: ArrayBuffer, page: PreviewStreamViewport | null) => void;
  readonly onViewport: (viewport: PreviewStreamViewport) => void;
  readonly onProbe?: (probe: PreviewStreamProbe) => void;
  readonly onPointer?: (pointer: PreviewStreamPointer) => void;
  readonly onControl?: (control: PreviewStreamControl) => void;
  readonly onClipboard?: (text: string) => void;
  readonly onDownload?: (download: PreviewStreamDownload) => void;
  readonly onPopup?: (tabId: string) => void;
  readonly onFileChooser?: (chooser: PreviewStreamFileChooser | null) => void;
  readonly onConnectedChange: (connected: boolean) => void;
  /** The upgrade was refused; refresh access and start a new client. */
  readonly onUnauthorized: () => void;
  readonly onGone?: () => void;
  readonly onHostSetup?: (setup: PreviewStreamHostSetup) => void;
}

export interface PreviewStreamClient {
  readonly send: (input: PreviewStreamInput) => boolean;
  readonly stop: () => void;
  /**
   * tempo: a paused viewer holds back its frame acks, so the server sends it no more frames until it
   * resumes. It stays connected, keeping its hold on the tab and the page's other messages.
   */
  readonly setPaused: (paused: boolean) => void;
}

const ACK_MESSAGE = JSON.stringify({ type: "ack" });
const TAKE_CONTROL_MESSAGE = JSON.stringify({ type: "takeControl" });
export function createPreviewStreamClient(
  target: PreviewStreamTarget,
  events: PreviewStreamEvents,
): PreviewStreamClient {
  const query = new URLSearchParams({
    threadId: target.threadId,
    tabId: target.tabId,
    maxWidth: String(Math.max(1, Math.round(target.maxWidth))),
    maxHeight: String(Math.max(1, Math.round(target.maxHeight))),
  });
  if (target.interactive === false) query.set("interactive", "false");
  const url = withDeviceHubQuery(`${target.access.wsBase}/ws?${query.toString()}`, target.access);
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let control: PreviewStreamControl | null = null;
  // tempo: a claim this viewer sent that no control update has answered yet.
  let claimSent = false;
  let fileChooser: string | null = null;
  // tempo: see `setPaused`; the acks answer frames from the current socket only.
  let paused = false;
  let heldAcks: Array<string> = [];

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    heldAcks = [];
    let opened = false;
    // tempo: the next frame's CSS size, and when it came.
    let frameSize: { readonly page: PreviewStreamViewport; readonly at: number } | null = null;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      events.onConnectedChange(true);
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        failures = 0;
        const size = frameSize;
        frameSize = null;
        // tempo: the frame's size message went just ahead of it, so the time since
        // is the frame's transfer, which the server sizes the next frames by.
        const ack = size
          ? JSON.stringify({ type: "ack", ms: Math.round(performance.now() - size.at) })
          : ACK_MESSAGE;
        if (paused) heldAcks.push(ack);
        else ws.send(ack);
        events.onFrame(event.data, size?.page ?? null);
        return;
      }
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const {
        type,
        x,
        y,
        width,
        height,
        editable,
        canOperate,
        controller,
        generation,
        dialog,
        text,
        id,
        fileName,
        sizeBytes,
        multiple,
        accept,
        phase,
        sequence,
        tabId,
      } = message as Record<string, unknown>;
      if (
        type === "fileChooser" &&
        typeof id === "string" &&
        typeof multiple === "boolean" &&
        typeof accept === "string"
      ) {
        fileChooser = id;
        events.onFileChooser?.({
          multiple,
          accept,
          uploadUrl: previewStreamUploadUrl(target, id),
          credentials: target.access.credentials,
        });
      } else if (type === "fileChooserClosed" && typeof id === "string") {
        if (fileChooser !== id) return;
        fileChooser = null;
        events.onFileChooser?.(null);
      } else if (
        type === "pointer" &&
        (phase === "move" || phase === "click") &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof sequence === "number"
      ) {
        events.onPointer?.({ phase, x, y, sequence });
      } else if (type === "popup" && typeof tabId === "string") {
        events.onPopup?.(tabId);
      } else if (type === "clipboard" && typeof text === "string") {
        events.onClipboard?.(text);
      } else if (
        type === "download" &&
        typeof id === "string" &&
        typeof fileName === "string" &&
        typeof sizeBytes === "number"
      ) {
        events.onDownload?.({
          fileName,
          sizeBytes,
          url: previewStreamDownloadUrl(target, id),
        });
      } else if (type === "viewport" && typeof width === "number" && typeof height === "number") {
        failures = 0;
        events.onViewport({ width, height });
      } else if (
        type === "frame" &&
        typeof width === "number" &&
        typeof height === "number" &&
        width > 0 &&
        height > 0
      ) {
        frameSize = { page: { width, height }, at: performance.now() };
      } else if (
        type === "probe" &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof editable === "boolean"
      ) {
        events.onProbe?.({ x, y, editable });
      } else if (
        type === "control" &&
        typeof canOperate === "boolean" &&
        (controller === "agent" ||
          controller === "you" ||
          controller === "another-viewer" ||
          controller === "unclaimed") &&
        typeof generation === "number" &&
        isPreviewStreamDialog(dialog)
      ) {
        const nextControl: PreviewStreamControl = {
          canOperate,
          controller,
          generation,
          dialog,
        };
        control = nextControl;
        // tempo: the server's word supersedes a claim in flight; repeating one is harmless.
        claimSent = false;
        events.onControl?.(nextControl);
      }
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      control = null;
      if (opened) events.onConnectedChange(false);
      if (stopped) return;
      if (event.code === 4404) {
        stopped = true;
        events.onGone?.();
        return;
      }
      if (event.code === PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE) {
        stopped = true;
        events.onHostSetup?.(decodeHostSetup(event.reason));
        return;
      }
      // Rejected upgrades surface as 1006 before open for both cookies and tickets.
      if (event.code === 1008 || event.code === 4401 || (!opened && event.code === 1006)) {
        stopped = true;
        events.onUnauthorized();
        return;
      }
      retryTimer = setTimeout(connect, Math.min(500 * 2 ** failures++, 10_000));
    });
    ws.addEventListener("error", () => ws.close());
  };

  connect();

  return {
    send: (input) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      if (!control?.canOperate) return false;
      // tempo: any operator drives the tab. Deliberate input claims it first,
      // which servers from before always-on control also need. Passive input
      // (hovering, probes, panel resizes) never claims it, so it waits.
      if (control.controller !== "you" && !claimSent) {
        if (!claimsBrowserControl(input)) return false;
        socket.send(TAKE_CONTROL_MESSAGE);
        claimSent = true;
      }
      if (input.type !== "takeControl") socket.send(JSON.stringify(input));
      return true;
    },
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      const ws = socket;
      socket = null;
      control = null;
      ws?.close();
    },
    setPaused: (next) => {
      paused = next;
      if (paused || socket?.readyState !== WebSocket.OPEN) return;
      for (const ack of heldAcks.splice(0)) socket.send(ack);
    },
  };
}

export interface PreviewFramePainter {
  readonly paint: (jpeg: ArrayBuffer, page?: PreviewStreamViewport | null) => void;
  readonly stop: () => void;
}

/**
 * One decode at a time, keeping only the latest waiting frame for slow viewers.
 * tempo: `onPainted` gets the CSS size of the frame now on the canvas, if known.
 */
export function createPreviewFramePainter(
  canvas: HTMLCanvasElement,
  onPainted?: (page: PreviewStreamViewport | null) => void,
): PreviewFramePainter {
  const context = canvas.getContext("2d");
  let stopped = false;
  let decoding = false;
  let waiting: { readonly jpeg: ArrayBuffer; readonly page: PreviewStreamViewport | null } | null =
    null;
  const draw = (jpeg: ArrayBuffer, page: PreviewStreamViewport | null) => {
    decoding = true;
    void createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }))
      .then((bitmap) => {
        if (stopped || !context) {
          bitmap.close();
          return;
        }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        onPainted?.(page);
      })
      .catch(() => undefined)
      .finally(() => {
        decoding = false;
        const next = waiting;
        waiting = null;
        if (next && !stopped) draw(next.jpeg, next.page);
      });
  };
  return {
    paint: (jpeg, page = null) => {
      if (stopped) return;
      if (decoding) waiting = { jpeg, page };
      else draw(jpeg, page);
    },
    stop: () => {
      stopped = true;
      waiting = null;
    },
  };
}

/** tempo: a viewer's canvas and the frame on it, letterboxed by `object-fit: contain`. */
export interface PreviewStreamFrameView {
  /** The canvas's box in client px, as `getBoundingClientRect()` gives it. */
  readonly box: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  /** The painted frame's pixels: the canvas's `width` and `height`. */
  readonly frame: PreviewStreamViewport;
  /** The CSS size of the page the painted frame shows. */
  readonly page: PreviewStreamViewport;
}

const frameRect = ({ box, frame }: PreviewStreamFrameView) => {
  const fit = Math.min(box.width / frame.width, box.height / frame.height);
  const width = frame.width * fit;
  const height = frame.height * fit;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
};

/**
 * tempo: the page point, in CSS px, under a client point. It maps through the
 * frame on screen, not the latest viewport, so a press lands on what the
 * person sees while a resize is still on its way. Null outside the frame
 * unless `clamp`; `scale` is page px per client px.
 */
export function previewStreamPagePoint(
  view: PreviewStreamFrameView,
  clientX: number,
  clientY: number,
  clamp: boolean,
): { readonly x: number; readonly y: number; readonly scale: number } | null {
  const { frame, page } = view;
  if (!(frame.width > 0 && frame.height > 0 && page.width > 0 && page.height > 0)) return null;
  const rect = frameRect(view);
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const scale = page.width / rect.width;
  const x = (clientX - view.box.left - rect.left) * scale;
  const y = (clientY - view.box.top - rect.top) * (page.height / rect.height);
  if (!clamp && !(x >= 0 && y >= 0 && x <= page.width && y <= page.height)) return null;
  return {
    x: Math.min(Math.max(x, 0), page.width),
    y: Math.min(Math.max(y, 0), page.height),
    scale,
  };
}

/** tempo: where a page point shows, relative to the canvas box's top left. */
export function previewStreamBoxPoint(view: PreviewStreamFrameView, x: number, y: number) {
  const rect = frameRect(view);
  return {
    left: rect.left + (x * rect.width) / view.page.width,
    top: rect.top + (y * rect.height) / view.page.height,
  };
}

const decodeHostSetup = (reason: string): PreviewStreamHostSetup => {
  try {
    const value = JSON.parse(reason) as Partial<PreviewStreamHostSetup>;
    if (
      (value.need === "sandbox" || value.need === "libraries") &&
      typeof value.command === "string"
    ) {
      return { need: value.need, command: value.command };
    }
  } catch {}
  return { need: "sandbox", command: `sudo ${TEMPO_CLI_NAME} browser setup` };
};

export const previewStreamHostSetupMessage = (setup: PreviewStreamHostSetup) =>
  setup.need === "sandbox"
    ? "This server's host blocks the sandbox its browser runs in. Run this once on the host, then try again:"
    : "This server's host is missing libraries its browser needs. Run this once on the host, then try again:";
