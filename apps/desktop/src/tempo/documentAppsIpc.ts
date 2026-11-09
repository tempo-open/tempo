// @effect-diagnostics nodeBuiltinImport:off -- the page is written to a temp file and handed to `open`, which only a file path reaches.
/**
 * tempo: the reading card's "Open in" target. The browser gets the card's own
 * rendering as an HTML file, since browsers show markdown as plain text.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as TempoChannels from "./channels.ts";

const MAX_PAGE_BYTES = 32 * 1024 * 1024;

const defaultBrowser = () =>
  Effect.promise(() =>
    Electron.app.getApplicationInfoForProtocol("https://").then(
      (info) => ({ name: info.name.replace(/\.app$/i, ""), path: info.path }),
      () => null,
    ),
  );

const openWith = (args: ReadonlyArray<string>) =>
  Effect.callback<boolean>((resume) => {
    NodeChildProcess.execFile("/usr/bin/open", [...args], (error) =>
      resume(Effect.succeed(error === null)),
    );
  });

/** A file name a person would recognize in the browser's tab and history. */
function pageFileName(name: string): string {
  const base = name
    .replace(/\.(?:md|mdx|markdown|mdown|mkd)$/i, "")
    .replace(/[^\p{L}\p{N} ._()-]+/gu, " ")
    .trim()
    .slice(0, 120);
  return `${base || "Document"}.html`;
}

export const documentApps = DesktopIpc.makeIpcMethod({
  channel: TempoChannels.TEMPO_DOCUMENT_APPS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Struct({ browser: Schema.NullOr(Schema.String) }),
  handler: Effect.fn("desktop.ipc.tempo.documentApps")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin") return { browser: null };
    const browser = yield* defaultBrowser();
    return { browser: browser?.name || null };
  }),
});

export const openDocument = DesktopIpc.makeIpcMethod({
  channel: TempoChannels.TEMPO_OPEN_DOCUMENT_CHANNEL,
  payload: Schema.Struct({
    target: Schema.Literal("browser"),
    name: Schema.String,
    html: Schema.String,
  }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.tempo.openDocument")(function* (input) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin") return false;
    if (Buffer.byteLength(input.html, "utf8") > MAX_PAGE_BYTES) return false;
    const directory = NodePath.join(NodeOS.tmpdir(), "Tempo documents");
    const file = NodePath.join(directory, pageFileName(input.name));
    const written = yield* Effect.promise(() =>
      NodeFSP.mkdir(directory, { recursive: true })
        .then(() => NodeFSP.writeFile(file, input.html, "utf8"))
        .then(
          () => true,
          () => false,
        ),
    );
    if (!written) return false;
    const browser = yield* defaultBrowser();
    return yield* openWith(browser ? ["-a", browser.path, file] : [file]);
  }),
});
