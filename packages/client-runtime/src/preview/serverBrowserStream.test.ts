import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createPreviewStreamClient,
  previewStreamBoxPoint,
  previewStreamPagePoint,
  type PreviewStreamControl,
} from "./serverBrowserStream.ts";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
}

const target = {
  access: {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    query: {},
    credentials: true,
  },
  threadId: "thread",
  tabId: "tab",
  maxWidth: 800,
  maxHeight: 600,
};

describe("preview stream control", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const connect = () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };
  const agent: PreviewStreamControl = {
    canOperate: true,
    controller: "agent",
    generation: 1,
    dialog: null,
  };

  const sent = (socket: FakeSocket) => socket.sent.map((entry) => JSON.parse(entry));
  const hover = {
    type: "mouse",
    action: "move",
    x: 1,
    y: 2,
    button: "none",
    buttons: 0,
    clickCount: 0,
    modifiers: 0,
  } as const;

  // tempo: no take or release control; a viewer's deliberate input claims the tab.
  it("claims the tab once before deliberate input from a viewer that does not hold it", () => {
    const { client, socket } = connect();
    socket.control(agent);
    expect(client.send({ type: "text", text: "typed" })).toBe(true);
    expect(client.send({ type: "key", action: "up", key: "a", code: "KeyA", modifiers: 0 })).toBe(
      true,
    );
    expect(sent(socket)).toEqual([
      { type: "takeControl" },
      { type: "text", text: "typed" },
      { type: "key", action: "up", key: "a", code: "KeyA", modifiers: 0 },
    ]);
    // Another viewer took the tab before the claim landed, so the next input claims again.
    socket.control({ ...agent, controller: "another-viewer", generation: 2 });
    socket.sent.length = 0;
    expect(client.send({ type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: 40, modifiers: 0 })).toBe(
      true,
    );
    expect(sent(socket).map((input) => input.type)).toEqual(["takeControl", "wheel"]);
    // Holding the tab, input goes straight out, and an explicit claim is not repeated.
    socket.control({ ...agent, controller: "you", generation: 3 });
    socket.sent.length = 0;
    expect(client.send({ type: "takeControl" })).toBe(true);
    expect(client.send({ type: "reload" })).toBe(true);
    expect(sent(socket)).toEqual([{ type: "reload" }]);
    client.stop();
  });

  it("keeps hovering, probes, and panel resizes back until this viewer holds the tab", () => {
    const { client, socket } = connect();
    socket.control(agent);
    expect(client.send(hover)).toBe(false);
    expect(client.send({ type: "probe", x: 1, y: 2 })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(socket.sent).toEqual([]);
    // A drag holds a button, so it is deliberate. Passive input may follow its claim,
    // which the server handles first.
    expect(client.send({ ...hover, button: "left", buttons: 1 })).toBe(true);
    expect(client.send(hover)).toBe(true);
    expect(sent(socket).map((input) => [input.type, input.buttons])).toEqual([
      ["takeControl", undefined],
      ["mouse", 1],
      ["mouse", 0],
    ]);
    socket.control({ ...agent, controller: "you", generation: 2 });
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(true);
    // The server's word replaces the claim: once the tab is gone, hovering waits again.
    socket.control({ ...agent, generation: 3 });
    expect(client.send(hover)).toBe(false);
    client.stop();
  });

  it("does not grant control from malformed dialog metadata", () => {
    const { client, socket, onControl } = connect();
    socket.message(
      JSON.stringify({
        type: "control",
        ...agent,
        controller: "you",
        dialog: { type: "prompt", message: 42, defaultValue: "" },
      }),
    );
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", () => {
    const { client, socket, onFrame } = connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame, null);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("exposes a pending dialog that any operator answers, claiming the tab first", () => {
    const { client, socket, onControl } = connect();
    const watched = {
      ...agent,
      dialog: { type: "prompt", message: "Name?", defaultValue: "initial" },
    };
    socket.control(watched);
    expect(onControl).toHaveBeenLastCalledWith(watched);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(sent(socket)).toEqual([
      { type: "takeControl" },
      { type: "dialog", accept: true, promptText: "answer" },
    ]);
    client.stop();
  });
});

// tempo: frames carry the CSS size they show, and acks the time each took to arrive.
describe("preview stream frames", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hands each frame the size sent ahead of it, and acks with the frame's transfer time", () => {
    const onFrame = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    const socket = FakeSocket.current;
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(1_000);
    socket.message(JSON.stringify({ type: "frame", width: 1200, height: 713 }));
    now.mockReturnValueOnce(1_023);
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenLastCalledWith(frame, { width: 1200, height: 713 });
    // A server from before sends no size: a plain ack, and the viewport stands in.
    socket.message(frame);
    expect(onFrame).toHaveBeenLastCalledWith(frame, null);
    expect(socket.sent).toEqual(['{"type":"ack","ms":23}', '{"type":"ack"}']);
    client.stop();
  });

  // tempo: the viewer of a hidden window.
  it("holds a paused viewer's acks until it resumes, keeping its other messages", () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    const socket = FakeSocket.current;
    const frame = new ArrayBuffer(3);
    client.setPaused(true);
    socket.message(frame);
    socket.message(frame);
    socket.control({ canOperate: true, controller: "you", generation: 1, dialog: null });
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onControl).toHaveBeenCalledTimes(1);
    expect(socket.sent).toEqual([]);

    client.setPaused(false);
    expect(socket.sent).toEqual(['{"type":"ack"}', '{"type":"ack"}']);
    socket.message(frame);
    expect(socket.sent).toHaveLength(3);
    client.stop();
  });
});

// tempo: a frame of a 1200×800 page that Chrome cut to its top 1200×713, as the
// full build's new headless mode did before the server pinned each tab's view.
describe("preview stream pointer mapping", () => {
  const box = { left: 100, top: 50, width: 1200, height: 800 };
  const clipped = { box, frame: { width: 2400, height: 1426 }, page: { width: 1200, height: 713 } };

  it("maps a press through the frame on screen, letterbox bars included", () => {
    // The 713 px frame sits 43.5 px below the box's top, so its bottom edge is the
    // page's bottom edge. Mapped through the 800 px viewport, it landed 87 px lower.
    expect(previewStreamPagePoint(clipped, 100 + 900, 50 + 43.5 + 713, false)).toEqual({
      x: 900,
      y: 713,
      scale: 1,
    });
    expect(previewStreamPagePoint(clipped, 100 + 600, 50 + 20, false)).toBeNull();
    expect(previewStreamPagePoint(clipped, 100 + 600, 50 + 20, true)).toEqual({
      x: 600,
      y: 0,
      scale: 1,
    });
  });

  it("scales between canvas pixels and page CSS pixels in both directions", () => {
    // A 1600×1000 page in a 1000 px wide panel: 0.625 client px per page px.
    const view = {
      box: { left: 0, top: 0, width: 1000, height: 700 },
      frame: { width: 2000, height: 1250 },
      page: { width: 1600, height: 1000 },
    };
    const point = previewStreamPagePoint(view, 500, 37.5 + 312.5, false);
    expect(point).toEqual({ x: 800, y: 500, scale: 1.6 });
    expect(previewStreamBoxPoint(view, 800, 500)).toEqual({ left: 500, top: 350 });
  });

  it("maps nothing before a frame is painted", () => {
    expect(
      previewStreamPagePoint({ ...clipped, frame: { width: 0, height: 0 } }, 10, 10, true),
    ).toBeNull();
  });
});

describe("preview stream downloads", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("offers a download at a URL carrying the stream's ticket", () => {
    const onDownload = vi.fn();
    createPreviewStreamClient(
      {
        ...target,
        access: { ...target.access, query: { wsTicket: "ticket" }, credentials: false },
      },
      {
        onFrame: vi.fn(),
        onDownload,
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "download", id: "d1", fileName: "a b.csv", sizeBytes: 3 }),
    );
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({
      fileName: "a b.csv",
      sizeBytes: 3,
      url: "http://preview.test/api/preview-stream/download?threadId=thread&tabId=tab&id=d1&wsTicket=ticket",
    });
  });
});

describe("preview stream agent pointer", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports where the agent moves and clicks, ignoring malformed points", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }),
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }),
    );
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({
      phase: "click",
      x: 140,
      y: 50,
      sequence: 2,
    });
  });
});
