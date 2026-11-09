// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off globalConsoleInEffect:off - A link emulator, a page server and a frame decoder run sockets, timers and Chrome outside Effect, and print what they measured.
/**
 * The server browser in real Chrome behind an emulated LAN or T3 Connect tunnel. Runs only when
 * TEMPO_TEST_CHROME names a full Chrome for Testing, such as Tempo's under `~/.tempo/tools/chrome`. Only a
 * click off the point shown fails; the rest of what it measures prints, or goes to the file
 * TEMPO_STREAM_LINK_REPORT names. TEMPO_STREAM_LINK_DUMP names a folder to write every frame to.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSessionId,
  EnvironmentId,
  PreviewTabId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/http";
import { chromium } from "playwright-core";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Broker from "../../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "../../preview/DesktopBrowserChannel.ts";
import * as Manager from "../../preview/Manager.ts";
import * as PreviewAgentActivity from "../../preview/PreviewAgentActivity.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as ServerBrowser from "../../preview/ServerBrowser.ts";
import { routeLayer } from "../../preview/ServerBrowserStream.ts";

const chrome = process.env.TEMPO_TEST_CHROME;

interface Link {
  readonly name: string;
  readonly rttMs: number;
  readonly mbps: number;
}

/** TEMPO_STREAM_LINKS picks some by name, comma separated. */
const LINKS: ReadonlyArray<Link> = [
  { name: "LAN", rttMs: 2, mbps: 300 },
  { name: "tunnel", rttMs: 40, mbps: 40 },
  { name: "slow tunnel", rttMs: 80, mbps: 10 },
].filter(
  (link) =>
    !process.env.TEMPO_STREAM_LINKS ||
    process.env.TEMPO_STREAM_LINKS.split(",").includes(link.name),
);

// The panel of a MacBook (device pixel ratio 2) the viewer streams into.
const PANEL = { width: 1200, height: 800 } as const;
const PIXEL_RATIO = 2;
const MOVE_INTERVAL_MS = 1000 / 60;
const HOVER_MOVES = 180;
const HOVER_START_X = 100;

const ACK = JSON.stringify({ type: "ack" });

/**
 * A page like a docs site, with a barcode the decoder reads, in CSS px: the last
 * pointer move's x, the last press's x and y, and the page's width and height.
 * Blocks are sized in `vw`, so they sit at the same fraction of every frame
 * whatever its scale or the page's zoom.
 */
const ROW = { moveX: 0, pressX: 1, pressY: 2, width: 3, height: 4 } as const;
const PAGE = (() => {
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const words =
    "stream frame viewer pointer server browser latency tunnel pixel render hover layout panel scale quality network effect schema project thread agent preview canvas socket decode paint input coordinate device".split(
      " ",
    );
  const sentence = () =>
    Array.from(
      { length: 8 + Math.floor(random() * 14) },
      () => words[Math.floor(random() * words.length)],
    )
      .join(" ")
      .replace(/^./, (first) => first.toUpperCase()) + ".";
  const paragraph = () => Array.from({ length: 3 + Math.floor(random() * 4) }, sentence).join(" ");
  const sections = Array.from(
    { length: 8 },
    (_, index) => `<h2>${sentence()}</h2>
<p>${paragraph()}</p>
<div class="cards">${Array.from({ length: 3 }, (_, card) => `<div style="background:linear-gradient(135deg,hsl(${(index * 40 + card * 70) % 360} 70% 60%),hsl(${(index * 40 + card * 70 + 90) % 360} 70% 45%))"><b>${sentence()}</b><span>${sentence()}</span></div>`).join("")}</div>
<p>${paragraph()}</p>
<pre>${Array.from({ length: 6 }, () => `const ${words[Math.floor(random() * words.length)]} = await ${sentence().toLowerCase().replaceAll(" ", ".").slice(0, 60)};`).join("\n")}</pre>
<table>${Array.from({ length: 4 }, () => `<tr>${Array.from({ length: 4 }, () => `<td>${sentence().slice(0, 28)}</td>`).join("")}</tr>`).join("")}</table>`,
  ).join("\n");
  return `<!doctype html>
<meta name="viewport" content="width=device-width">
<style>
  html { font: 16px/1.55 system-ui, sans-serif; color: #1f2328; background: #fff }
  body { margin: 0; padding: 12vw 40px 40px }
  h2 { font-size: 22px; margin: 28px 0 8px }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 16px 0 }
  .cards div { border-radius: 12px; padding: 16px; color: #fff; display: flex; flex-direction: column; gap: 8px; min-height: 110px }
  pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px; font: 13px/1.5 ui-monospace, monospace; overflow: hidden }
  table { border-collapse: collapse; width: 100% }
  td { border: 1px solid #d0d7de; padding: 6px 10px; font-size: 14px }
  #code { position: fixed; left: 0; top: 0; z-index: 2 }
  #code div { display: flex }
  #code i { width: 2vw; height: 2vw; background: #fff }
  #code i:first-child { background: #f00 }
  #dot { position: fixed; left: 0; top: 0; width: 18px; height: 18px; margin: -9px; border-radius: 50%; background: #0969da; z-index: 2; pointer-events: none }
</style>
<div id="code"></div><div id="dot"></div>
<main><h1>${sentence()}</h1>${sections}</main>
<script>
  const rows = [0, 1, 2, 3, 4].map(() => {
    const row = document.createElement("div");
    for (let block = 0; block < 13; block++) row.append(document.createElement("i"));
    code.append(row);
    return row;
  });
  const show = (row, value) => {
    for (let bit = 0; bit < 12; bit++)
      rows[row].children[bit + 1].style.background = (value >> bit) & 1 ? "#000" : "#fff";
  };
  const size = () => {
    show(${ROW.width}, Math.round(innerWidth));
    show(${ROW.height}, Math.round(innerHeight));
  };
  addEventListener("resize", size);
  size();
  // ?busy=N makes every pointer move take N ms, like a heavy app.
  const busy = Number(new URLSearchParams(location.search).get("busy")) || 0;
  addEventListener("mousemove", (event) => {
    const until = performance.now() + busy;
    while (performance.now() < until);
    dot.style.transform = "translate(" + event.clientX + "px, " + event.clientY + "px)";
    show(${ROW.moveX}, Math.round(event.clientX));
  });
  addEventListener("mousedown", (event) => {
    show(${ROW.pressX}, Math.round(event.clientX));
    show(${ROW.pressY}, Math.round(event.clientY));
  });
</script>`;
})();

/** Reads the barcode and times the decode the way the viewer decodes, one frame at a time. */
const DECODE_SCRIPT = `async (frames) => {
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const results = [];
  for (const base64 of frames) {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const started = performance.now();
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    const decodeMs = performance.now() - started;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const at = (block, row) => {
      const x = Math.round(((2 * block + 1) / 100) * canvas.width);
      const y = Math.round(((2 * row + 1) / 100) * canvas.width);
      return context.getImageData(x, y, 1, 1).data;
    };
    const rows = [0, 1, 2, 3, 4].map((row) => {
      const marker = at(0, row);
      if (!(marker[0] > 150 && marker[1] < 110 && marker[2] < 110)) return null;
      let value = 0;
      for (let bit = 0; bit < 12; bit++) {
        const pixel = at(bit + 1, row);
        if (pixel[0] + pixel[1] + pixel[2] < 384) value |= 1 << bit;
      }
      return value;
    });
    results.push({ rows, decodeMs });
  }
  return results;
}`;

interface Size {
  readonly width: number;
  readonly height: number;
}

interface ReceivedFrame extends Size {
  readonly at: number;
  readonly data: Uint8Array;
  /** The CSS size the frame shows, when the server says so. */
  readonly page: Size | null;
}

const jpegSize = (data: Uint8Array): Size => {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1]!;
    const length = (data[offset + 2]! << 8) | data[offset + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: (data[offset + 5]! << 8) | data[offset + 6]!,
        width: (data[offset + 7]! << 8) | data[offset + 8]!,
      };
    }
    offset += 2 + length;
  }
  return { width: 0, height: 0 };
};

/** Speaks the stream protocol as the client runtime does, keeping every frame it receives. */
class Viewer {
  readonly frames: Array<ReceivedFrame> = [];
  viewport: Size | null = null;
  controller: string | null = null;
  private page: (Size & { readonly at: number }) | null = null;
  private readonly waiters = new Set<() => void>();
  private readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      const at = performance.now();
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.type === "viewport")
          this.viewport = { width: Number(message.width), height: Number(message.height) };
        if (message.type === "control") this.controller = String(message.controller);
        if (message.type === "frame")
          this.page = { width: Number(message.width), height: Number(message.height), at };
      } else {
        // Acked on receipt, before decoding, with the transfer time measured from
        // the frame's size message when the server sends one.
        socket.send(
          this.page ? JSON.stringify({ type: "ack", ms: Math.round(at - this.page.at) }) : ACK,
        );
        const data = new Uint8Array(event.data as ArrayBuffer);
        const dump = process.env.TEMPO_STREAM_LINK_DUMP;
        if (dump) NodeFS.writeFileSync(`${dump}/frame-${this.frames.length}.jpg`, data);
        this.frames.push({
          at,
          data,
          ...jpegSize(data),
          page: this.page && { width: this.page.width, height: this.page.height },
        });
        this.page = null;
      }
      for (const wake of this.waiters) wake();
    });
  }

  send(message: object) {
    this.socket.send(JSON.stringify(message));
  }

  until(what: string, condition: () => boolean, timeoutMs = 15_000) {
    return new Promise<void>((resolve, reject) => {
      if (condition()) return resolve();
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(
          new Error(
            `The viewer waited too long for ${what} (controller ${this.controller}, viewport ${JSON.stringify(this.viewport)}, ${this.frames.length} frames, last ${this.frames.at(-1)?.width}×${this.frames.at(-1)?.height}).`,
          ),
        );
      }, timeoutMs);
      const check = () => {
        if (!condition()) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      this.waiters.add(check);
    });
  }

  /** Resolves once no frame has arrived for `ms`. */
  async quiet(ms: number) {
    for (;;) {
      const count = this.frames.length;
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (this.frames.length === count) return;
    }
  }

  close() {
    this.socket.close();
  }
}

/**
 * A bottleneck queue in each direction: serialized at `mbps` in 16 KB packets,
 * as an HTTP/2 tunnel delivers them, then delayed half the RTT. One timer
 * drains it in order; a timer per packet can fire out of order.
 */
const PACKET_BYTES = 16 * 1024;
const emulateLink = (target: number, link: Link) =>
  new Promise<{ readonly port: number; readonly close: () => void }>((resolve) => {
    const sockets = new Set<NodeNet.Socket>();
    const relay = (from: NodeNet.Socket, to: NodeNet.Socket) => {
      const queue: Array<{ readonly due: number; readonly chunk: Buffer | null }> = [];
      let free = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const drain = () => {
        timer = null;
        const now = performance.now();
        while (queue.length > 0 && queue[0]!.due <= now) {
          const { chunk } = queue.shift()!;
          if (chunk === null) to.destroy();
          else to.write(chunk);
        }
        if (queue.length > 0) timer = setTimeout(drain, queue[0]!.due - now);
      };
      const enqueue = (chunk: Buffer | null) => {
        const now = performance.now();
        const packets: Array<Buffer | null> = chunk === null ? [null] : [];
        if (chunk !== null)
          for (let start = 0; start < chunk.byteLength; start += PACKET_BYTES)
            packets.push(chunk.subarray(start, start + PACKET_BYTES));
        for (const packet of packets) {
          free = Math.max(now, free) + ((packet?.byteLength ?? 0) * 8) / (link.mbps * 1000);
          queue.push({ due: free + link.rttMs / 2, chunk: packet });
        }
        timer ??= setTimeout(drain, queue[0]!.due - now);
      };
      from.on("data", enqueue);
      from.on("close", () => enqueue(null));
      from.on("error", () => to.destroy());
    };
    const server = NodeNet.createServer((client) => {
      const upstream = NodeNet.connect(target, "127.0.0.1");
      for (const socket of [client, upstream]) {
        socket.setNoDelay(true);
        sockets.add(socket);
      }
      relay(client, upstream);
      relay(upstream, client);
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as NodeNet.AddressInfo).port,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      }),
    );
  });

const percentile = (values: ReadonlyArray<number>, fraction: number) => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
};
const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Where a click at a fraction of the shown frame lands, as the viewer maps it:
 * through the CSS size the frame shows when the server sends it, else through
 * the last viewport message.
 */
const mapClick = (frame: ReceivedFrame, latest: Size, fraction: { x: number; y: number }) => {
  const page = frame.page ?? latest;
  const fit = Math.min(PANEL.width / frame.width, PANEL.height / frame.height);
  const width = frame.width * fit;
  const height = frame.height * fit;
  const clientX = (PANEL.width - width) / 2 + width * fraction.x;
  const clientY = (PANEL.height - height) / 2 + height * fraction.y;
  return {
    x: Math.round((clientX - (PANEL.width - width) / 2) * (page.width / width)),
    y: Math.round((clientY - (PANEL.height - height) / 2) * (page.height / height)),
  };
};

const environmentId = EnvironmentId.make("stream-link-environment");
const threadId = ThreadId.make("stream-link-thread");

const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
  authenticateWebSocketUpgrade: () =>
    Effect.succeed({
      sessionId: AuthSessionId.make("stream-link"),
      subject: "stream-link",
      method: "bearer-access-token",
      scopes: [AuthOrchestrationReadScope, AuthPreviewOperateScope],
    }),
});

const browserLayer = ServerBrowser.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Broker.layer,
      Manager.layer,
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("unused descriptor"),
      }),
      Layer.succeed(PreviewBrowser.PreviewBrowser, {
        executable: Effect.sync(() => chrome!),
        installed: Effect.sync(() => Option.some(chrome!)),
      }),
      Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
        available: false,
        awaitAttached: () => Effect.succeed(false),
        detached: Stream.never,
        attached: Stream.never,
        isAttached: () => Effect.succeed(false),
        endpoint: () => Effect.die("no desktop"),
        pointer: () => Effect.void,
        turn: () => Effect.void,
        agentDrove: () => Effect.void,
      }),
      PreviewAgentActivity.layer,
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "tempo-stream-link-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

it.live.skipIf(chrome === undefined)(
  "measures frame bytes, frame rate, input-to-frame latency and click error across links",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(
        HttpRouter.serve(routeLayer, { disableListenLog: true }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(auth),
          Layer.provideMerge(browserLayer),
          Layer.provide(NodeHttpPlatform.layer),
        ),
      );
      const manager = Context.get(services, Manager.PreviewManager);
      const server = Context.get(services, HttpServer.HttpServer);
      const serverPort = (server.address as { readonly port: number }).port;

      const site = NodeHttp.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(PAGE);
      });
      yield* Effect.acquireRelease(
        Effect.promise(() => new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve))),
        () => Effect.sync(() => site.close()),
      );
      const siteUrl = `http://127.0.0.1:${(site.address() as NodeNet.AddressInfo).port}/`;
      const dump = process.env.TEMPO_STREAM_LINK_DUMP;
      if (dump) NodeFS.writeFileSync(`${dump}/page.html`, PAGE);
      const decoder = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ executablePath: chrome!, headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const decodePage = yield* Effect.promise(() => decoder.newPage());
      const decode = async (frames: ReadonlyArray<ReceivedFrame>) => {
        const results: Array<{ rows: Array<number | null>; decodeMs: number }> = [];
        for (let start = 0; start < frames.length; start += 40) {
          const batch = frames
            .slice(start, start + 40)
            .map((frame) => Buffer.from(frame.data).toString("base64"));
          results.push(
            ...((await decodePage.evaluate(
              `(${DECODE_SCRIPT})(${JSON.stringify(batch)})`,
            )) as typeof results),
          );
        }
        return results;
      };

      const report: Array<Record<string, string | number>> = [];
      for (const link of LINKS) {
        const proxy = yield* Effect.acquireRelease(
          Effect.promise(() => emulateLink(serverPort, link)),
          (proxy) => Effect.sync(() => proxy.close()),
        );
        const snapshot = yield* manager.open({ threadId, url: siteUrl, runtime: "server" });
        const tabId = PreviewTabId.make(snapshot.tabId);
        const viewer = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new Viewer(
                new WebSocket(
                  `ws://127.0.0.1:${proxy.port}/api/preview-stream/ws?${new URLSearchParams({
                    threadId,
                    tabId,
                    maxWidth: String(PANEL.width * PIXEL_RATIO),
                    maxHeight: String(PANEL.height * PIXEL_RATIO),
                    wsTicket: "stream-link",
                  }).toString()}`,
                ),
              ),
          ),
          (viewer) => Effect.sync(() => viewer.close()),
        );
        const resize = (size: Size, cssWidth: number) => {
          viewer.send({ type: "resize", ...size });
          return viewer.until("the panel size", () => viewer.viewport?.width === cssWidth);
        };
        /** A pointer sweeping right at 60 Hz, as a person moves a mouse. */
        const sweep = async (moves: number) => {
          const first = viewer.frames.length;
          const sentAt: Array<number> = [];
          const started = performance.now();
          for (let move = 0; move < moves; move++) {
            const wait = started + move * MOVE_INTERVAL_MS - performance.now();
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
            sentAt.push(performance.now());
            viewer.send({
              type: "mouse",
              action: "move",
              x: HOVER_START_X + move,
              y: 400,
              button: "none",
              buttons: 0,
              clickCount: 0,
              modifiers: 0,
            });
          }
          const ended = performance.now();
          await viewer.quiet(1500);
          return { frames: viewer.frames.slice(first), sentAt, started, ended };
        };
        // A press low on the right of the shown frame, against the CSS point the frame
        // shows there. Frames start at the page's top left, at frame.width / innerWidth
        // px per CSS px.
        const click = async () => {
          await viewer.quiet(600);
          const shown = viewer.frames.at(-1)!;
          const fraction = { x: 0.75, y: 0.9 };
          const point = mapClick(shown, viewer.viewport!, fraction);
          const frame = viewer.frames.length;
          const at = { ...point, modifiers: 0 };
          viewer.send({
            type: "mouse",
            action: "move",
            ...at,
            button: "none",
            buttons: 0,
            clickCount: 0,
          });
          viewer.send({
            type: "mouse",
            action: "down",
            ...at,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
          viewer.send({
            type: "mouse",
            action: "up",
            ...at,
            button: "left",
            buttons: 0,
            clickCount: 1,
          });
          await viewer.until("a frame after a click", () => viewer.frames.length > frame);
          await viewer.quiet(600);
          const [decoded] = await decode([viewer.frames.at(-1)!]);
          const rows = decoded!.rows;
          const cssPerPixel = rows[ROW.width]! / shown.width;
          return Math.hypot(
            rows[ROW.pressX]! - fraction.x * shown.width * cssPerPixel,
            rows[ROW.pressY]! - fraction.y * shown.height * cssPerPixel,
          );
        };

        const measured = yield* Effect.promise(async () => {
          // The first tab waits for Chrome to start.
          await viewer.until("control", () => viewer.controller === "you", 60_000);
          await resize(PANEL, PANEL.width);
          await viewer.until("a frame at the panel size", () =>
            viewer.frames.some((frame) => frame.width === PANEL.width * PIXEL_RATIO),
          );
          await viewer.quiet(600);
          const hover = await sweep(HOVER_MOVES);

          // Single moves on a settled page.
          const singles: Array<{ sentAt: number; x: number; frame: number }> = [];
          for (let sample = 0; sample < 8; sample++) {
            await viewer.quiet(400);
            const x = 500 + sample * 9;
            const frame = viewer.frames.length;
            singles.push({ sentAt: performance.now(), x, frame });
            viewer.send({
              type: "mouse",
              action: "move",
              x,
              y: 420,
              button: "none",
              buttons: 0,
              clickCount: 0,
              modifiers: 0,
            });
            await viewer.until("a frame after a single move", () => viewer.frames.length > frame);
          }

          // Scrolling: a trackpad flick down, then back to the top.
          await viewer.quiet(400);
          const singlesEnd = viewer.frames.length;
          const firstScrollFrame = viewer.frames.length;
          const scrollStarted = performance.now();
          for (let tick = 0; tick < 120; tick++) {
            const wait = scrollStarted + tick * MOVE_INTERVAL_MS - performance.now();
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
            viewer.send({ type: "wheel", x: 600, y: 400, deltaX: 0, deltaY: 24, modifiers: 0 });
          }
          const scrollEnded = performance.now();
          await viewer.quiet(800);
          const scrollFrames = viewer.frames.slice(firstScrollFrame);
          viewer.send({ type: "wheel", x: 600, y: 400, deltaX: 0, deltaY: -100_000, modifiers: 0 });
          await viewer.quiet(600);
          const clickError = await click();
          return {
            hover,
            singles,
            singlesEnd,
            scrollFrames,
            scrollStarted,
            scrollEnded,
            clickError,
          };
        });
        // Zoomed in, then the panel resized.
        yield* manager.adjust({ threadId, tabId, zoomFactor: 1.5 });
        const result = yield* Effect.promise(async () => {
          const {
            hover,
            singles,
            singlesEnd,
            scrollFrames,
            scrollStarted,
            scrollEnded,
            clickError,
          } = measured;
          await resize({ width: 1000, height: 700 }, Math.round(1000 / 1.5));
          const zoomedClickError = await click();

          // A page whose pointer handler takes 40 ms, longer than moves come apart.
          viewer.send({ type: "navigate", url: `${siteUrl}?busy=40` });
          await viewer.quiet(800);
          const busy = await sweep(120);

          /** For each move, how long until a frame showed it or a later one. */
          const moveLatency = async (
            frames: ReadonlyArray<ReceivedFrame>,
            sent: ReadonlyArray<number>,
          ) => {
            const decoded = await decode(frames);
            const reflected = decoded.map((frame) => (frame.rows[ROW.moveX] ?? -1) - HOVER_START_X);
            return {
              decoded,
              latency: sent.flatMap((at, move) => {
                const shown = frames.findIndex(
                  (frame, index) => reflected[index]! >= move && frame.at >= at,
                );
                return shown === -1 ? [] : [frames[shown]!.at - at];
              }),
            };
          };
          const { decoded: decodedHover, latency: hoverLatency } = await moveLatency(
            hover.frames,
            hover.sentAt,
          );
          const { latency: busyLatency } = await moveLatency(busy.frames, busy.sentAt);
          // A single move's first frame can be a restart's, showing the page from before it.
          const singleLatency: Array<number> = [];
          for (const [index, single] of singles.entries()) {
            const frames = viewer.frames.slice(
              single.frame,
              singles[index + 1]?.frame ?? singlesEnd,
            );
            const decoded = await decode(frames);
            const shown = decoded.findIndex((frame) => frame.rows[ROW.moveX] === single.x);
            if (shown !== -1) singleLatency.push(frames[shown]!.at - single.sentAt);
          }
          const motion = (frames: ReadonlyArray<ReceivedFrame>, started: number, ended: number) => {
            const during = frames.filter((frame) => frame.at >= started && frame.at <= ended + 100);
            const gaps = during.slice(1).map((frame, index) => frame.at - during[index]!.at);
            return {
              fps: during.length / ((ended + 100 - started) / 1000),
              kb: percentile(
                during.map((frame) => frame.data.byteLength / 1024),
                0.5,
              ),
              gap: percentile(gaps, 0.95),
              mbps:
                (during.reduce((sum, frame) => sum + frame.data.byteLength, 0) * 8) /
                ((ended + 100 - started) * 1000),
            };
          };
          const hoverStats = motion(hover.frames, hover.started, hover.ended);
          const scrollStats = motion(scrollFrames, scrollStarted, scrollEnded);
          // What shows once the pointer stops: the settled still, if one came.
          const settled = hover.frames.at(-1)!;
          return {
            link: `${link.name} (${link.rttMs} ms, ${link.mbps} Mbps)`,
            "hover fps": round(hoverStats.fps),
            "hover p95 gap ms": round(hoverStats.gap),
            "hover frame KB": round(hoverStats.kb),
            "hover Mbps": round(hoverStats.mbps),
            "move→frame p50 ms": round(percentile(hoverLatency, 0.5)),
            "move→frame p95 ms": round(percentile(hoverLatency, 0.95)),
            "single move→frame ms": round(percentile(singleLatency, 0.5)),
            "busy page move→frame p50 ms": round(percentile(busyLatency, 0.5)),
            "busy page move→frame p95 ms": round(percentile(busyLatency, 0.95)),
            "scroll fps": round(scrollStats.fps),
            "scroll frame KB": round(scrollStats.kb),
            "settled KB": round(settled.data.byteLength / 1024),
            "settled px": `${settled.width}×${settled.height}`,
            "decode ms": round(
              percentile(
                decodedHover.map((frame) => frame.decodeMs),
                0.5,
              ),
            ),
            "click error px": round(clickError),
            "zoom+resize click error px": round(zoomedClickError),
            moves: hoverLatency.length,
          };
        });
        report.push(result);
        yield* manager.close({ threadId, tabId });
      }
      const table = report
        .map((row) =>
          Object.entries(row)
            .map(([key, value]) => `${key}: ${value}`)
            .join(" | "),
        )
        .join("\n");
      // The reporter hides a passing test's output, so TEMPO_STREAM_LINK_REPORT names a file for it.
      const reportPath = process.env.TEMPO_STREAM_LINK_REPORT;
      if (reportPath) NodeFS.writeFileSync(reportPath, `${table}\n`);
      else console.log(table);
      for (const row of report) {
        expect(row.moves).toBeGreaterThan(0);
        // Rounding to whole CSS px leaves under a pixel either way.
        expect(row["click error px"]).toBeLessThanOrEqual(2);
        expect(row["zoom+resize click error px"]).toBeLessThanOrEqual(2);
      }
    }).pipe(Effect.scoped),
  { timeout: 600_000 },
);
