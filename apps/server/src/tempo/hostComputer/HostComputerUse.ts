// @effect-diagnostics nodeBuiltinImport:off -- Host computer use owns native child processes and its files under the server's tools directory.
/**
 * tempo: computer use on the server's machine, through one Open Computer Use MCP server (npm, pinned
 * integrity, `<baseDir>/tools`), its calls serialized since the screen is shared. The helper
 * (`hostHelperSource.ts`) gives a headless Mac a display and starts Open Computer Use as its own
 * responsible process, so its grants count, not the server's. Both stop after ten idle minutes.
 */
import type { LaptopToolCallResult, LaptopToolDescriptor } from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import { ownAppComputerUseRefusal, withoutOwnApps } from "@t3tools/shared/tempoComputerUse";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  McpClientError,
  McpStdioClient,
  normalizeMcpToolContent,
} from "@t3tools/shared/mcpStdioClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as ServerConfig from "../../config.ts";
import { HOST_HELPER_SOURCE } from "./hostHelperSource.ts";

const OPEN_COMPUTER_USE_VERSION = "1.1.2";
const OPEN_COMPUTER_USE_TARBALL = `https://registry.npmjs.org/open-computer-use/-/open-computer-use-${OPEN_COMPUTER_USE_VERSION}.tgz`;
/** npm's `dist.integrity` for that tarball; a download that differs is refused. */
const OPEN_COMPUTER_USE_INTEGRITY =
  "sha512-xb88Gwf3y0NgRY2qVkC+Ff00lSBOR5tD7vQCIph+YoYaPrZ6FPata7UW9fR5zowGrHF3aK/E0buutXl0TlUvnQ==";
const VIRTUAL_DISPLAY = { width: 1920, height: 1080 } as const;
const LIST_TIMEOUT_MS = 30_000;
const HOST_COMPUTER_CALL_DEFAULT_TIMEOUT_MS = 120_000;
/** Text plus base64 image data; a few full screenshots fit. */
const MAX_RESULT_CHARS = 12 * 1024 * 1024;
const IDLE_MS = 10 * 60_000;

export class HostComputerUseError extends Schema.TaggedError<HostComputerUseError>()(
  "HostComputerUseError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const isHostComputerUseError = Schema.is(HostComputerUseError);

export interface HostComputerTools {
  /** This machine's name, as the person knows it. */
  readonly host: string;
  readonly tools: ReadonlyArray<LaptopToolDescriptor>;
}

export class HostComputerUse extends Context.Service<
  HostComputerUse,
  {
    readonly listTools: Effect.Effect<HostComputerTools, HostComputerUseError>;
    readonly callTool: (input: {
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly timeoutMs?: number | undefined;
    }) => Effect.Effect<LaptopToolCallResult, HostComputerUseError>;
  }
>()("t3/tempo/hostComputer/HostComputerUse") {}

interface Launch {
  readonly command: string;
  /** Arguments before Open Computer Use's own command. */
  readonly prefix: ReadonlyArray<string>;
}

const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs: number; readonly input?: string },
) =>
  new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>(
    (resolve) => {
      const child = NodeChildProcess.execFile(
        command,
        [...args],
        { timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) =>
          resolve({
            code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
            stdout: String(stdout),
            stderr: String(stderr),
          }),
      );
      if (options.input !== undefined) child.stdin?.end(options.input);
    },
  );

const exists = (path: string) =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );

/** The environment Open Computer Use and the helper get: no secrets the server holds. */
const childEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
};

/** What to tell the agent when the machine has not granted Open Computer Use yet. */
export function missingPermissionsReason(host: string, missing: ReadonlyArray<string>): string {
  const names = missing.map((permission) =>
    permission === "screenRecording" ? "Screen Recording" : "Accessibility",
  );
  const list = names.length === 0 ? "Screen Recording and Accessibility" : names.join(" and ");
  return `Open Computer Use is not allowed ${list} on ${host} yet, so computer use cannot see or act on its screen. Ask the user to allow it once on that machine: System Settings → Privacy & Security → ${list} → Open Computer Use. ${TEMPO_APP_BASE_NAME} opened its permission window there; on a machine with no monitor they can reach it over Screen Sharing. Then call computer_use_tools again.`;
}

/** The parts of `open-computer-use doctor --json` this reads. */
export function parseDoctor(stdout: string): {
  readonly allGranted: boolean;
  readonly missing: ReadonlyArray<string>;
} | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.allGranted !== "boolean") return null;
    const missing = Array.isArray(record.missingPermissions)
      ? record.missingPermissions.filter((item): item is string => typeof item === "string")
      : [];
    return { allGranted: record.allGranted, missing };
  } catch {
    return null;
  }
}

/** Characters a result carries, compared with `MAX_RESULT_CHARS`. */
function resultSize(result: LaptopToolCallResult): number {
  let size = 0;
  for (const block of result.content) {
    size += block.type === "text" ? block.text.length : block.data.length;
  }
  return size;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const permit = yield* Semaphore.make(1);
  const platform = yield* HostProcess.Platform;
  const host = (yield* HostProcess.Hostname).replace(/\.local$/u, "");
  const toolsDir = NodePath.join(config.baseDir, "tools");
  const ocuRoot = NodePath.join(toolsDir, "open-computer-use", OPEN_COMPUTER_USE_VERSION);
  const ocuNative = NodePath.join(
    ocuRoot,
    "package",
    "dist",
    "Open Computer Use.app",
    "Contents",
    "MacOS",
    "OpenComputerUse",
  );
  const helperHash = NodeCrypto.createHash("sha256")
    .update(HOST_HELPER_SOURCE)
    .digest("hex")
    .slice(0, 16);
  const helperPath = NodePath.join(toolsDir, "tempo-host-helper", helperHash, "tempo-host-helper");

  let client: McpStdioClient | null = null;
  let display: NodeChildProcess.ChildProcess | null = null;
  let lastUsedAt = 0;
  let onboardingOpened = false;

  const fail = (reason: string) => new HostComputerUseError({ reason });

  /** Downloads Open Computer Use once, refusing a tarball that is not the pinned one. */
  const installOpenComputerUse = async () => {
    if (await exists(ocuNative)) return;
    await NodeFSP.mkdir(NodePath.dirname(ocuRoot), { recursive: true });
    const staging = await NodeFSP.mkdtemp(`${ocuRoot}.partial-`);
    try {
      const archive = NodePath.join(staging, "package.tgz");
      const downloaded = await run(
        "/usr/bin/curl",
        ["-fsSL", "--max-time", "300", "-o", archive, OPEN_COMPUTER_USE_TARBALL],
        { timeoutMs: 310_000 },
      );
      if (downloaded.code !== 0)
        throw new Error(`the download failed: ${downloaded.stderr.trim()}`);
      const tarball = await NodeFSP.readFile(archive);
      const integrity = `sha512-${NodeCrypto.createHash("sha512").update(tarball).digest("base64")}`;
      if (integrity !== OPEN_COMPUTER_USE_INTEGRITY) {
        throw new Error("the download did not match the pinned version");
      }
      const extracted = await run("/usr/bin/tar", ["-xzf", archive, "-C", staging], {
        timeoutMs: 120_000,
      });
      if (extracted.code !== 0) throw new Error(`tar failed: ${extracted.stderr.trim()}`);
      await NodeFSP.rm(archive);
      await NodeFSP.rename(staging, ocuRoot);
    } catch (error) {
      await NodeFSP.rm(staging, { recursive: true, force: true });
      // Another server process may have finished the same install first.
      if (!(await exists(ocuNative))) throw error;
    }
  };

  /** The helper, built with clang once per source version; null where it cannot be built. */
  const buildHelper = async (): Promise<string | null> => {
    if (await exists(helperPath)) return helperPath;
    // `clang` on a Mac without the Command Line Tools opens Apple's installer prompt instead.
    if ((await run("/usr/bin/xcode-select", ["-p"], { timeoutMs: 10_000 })).code !== 0) return null;
    await NodeFSP.mkdir(NodePath.dirname(helperPath), { recursive: true });
    const staging = `${helperPath}.partial-${process.pid}`;
    const built = await run(
      "/usr/bin/clang",
      [
        "-fobjc-arc",
        "-O2",
        "-framework",
        "Foundation",
        "-framework",
        "CoreGraphics",
        "-x",
        "objective-c",
        "-o",
        staging,
        "-",
      ],
      { timeoutMs: 120_000, input: HOST_HELPER_SOURCE },
    );
    if (built.code !== 0) {
      await NodeFSP.rm(staging, { force: true });
      return null;
    }
    await NodeFSP.rename(staging, helperPath);
    return helperPath;
  };

  /** A Mac with no monitor gets a virtual display for as long as computer use runs. */
  const ensureDisplay = async (helper: string) => {
    if (display !== null) return;
    const counted = await run(helper, ["displays"], { timeoutMs: 10_000 });
    if (counted.code !== 0 || Number(counted.stdout.trim()) > 0) return;
    const child = NodeChildProcess.spawn(
      helper,
      ["virtual-display", String(VIRTUAL_DISPLAY.width), String(VIRTUAL_DISPLAY.height)],
      { stdio: ["ignore", "pipe", "pipe"], env: childEnvironment() },
    );
    const ready = await new Promise<boolean>((resolve) => {
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.startsWith("ready")) resolve(true);
      });
      child.once("exit", () => resolve(false));
      child.once("error", () => resolve(false));
    });
    if (!ready) {
      child.kill("SIGTERM");
      throw new Error("macOS did not create a virtual display");
    }
    child.once("exit", () => {
      if (display === child) display = null;
    });
    display = child;
  };

  const stop = () => {
    client?.close();
    client = null;
    display?.kill("SIGTERM");
    display = null;
  };
  yield* Effect.addFinalizer(() => Effect.sync(stop));

  /** Everything a call needs, started in order; the permit keeps it to one fiber at a time. */
  const start = Effect.tryPromise({
    try: async (): Promise<McpStdioClient> => {
      if (client !== null && !client.closed) return client;
      client = null;
      await installOpenComputerUse();
      const helper = await buildHelper();
      if (helper !== null) await ensureDisplay(helper);
      const launch: Launch =
        helper === null
          ? { command: ocuNative, prefix: [] }
          : { command: helper, prefix: ["disclaim", ocuNative] };
      const doctor = parseDoctor(
        (await run(launch.command, [...launch.prefix, "doctor", "--json"], { timeoutMs: 30_000 }))
          .stdout,
      );
      if (doctor !== null && !doctor.allGranted) {
        if (!onboardingOpened) {
          onboardingOpened = true;
          // Without a command, Open Computer Use opens its permission window on this Mac.
          NodeChildProcess.spawn(launch.command, [...launch.prefix], {
            detached: true,
            stdio: "ignore",
            env: childEnvironment(),
          }).unref();
        }
        throw fail(missingPermissionsReason(host, doctor.missing));
      }
      const started = await McpStdioClient.start({
        command: launch.command,
        args: [...launch.prefix, "mcp"],
        env: childEnvironment(),
        clientVersion: OPEN_COMPUTER_USE_VERSION,
        startTimeoutMs: 60_000,
      });
      started.onExit(() => {
        if (client === started) client = null;
      });
      client = started;
      return started;
    },
    catch: (cause) =>
      isHostComputerUseError(cause)
        ? cause
        : fail(
            `Computer use could not start on ${host}: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
  });

  const unsupported =
    platform === "darwin"
      ? null
      : fail(`Computer use on this machine needs macOS; ${host} runs ${platform}.`);

  const used = Clock.currentTimeMillis.pipe(
    Effect.tap((now) => Effect.sync(() => (lastUsedAt = now))),
  );

  const listTools: HostComputerUse["Service"]["listTools"] = Effect.gen(function* () {
    if (unsupported !== null) return yield* unsupported;
    yield* used;
    const started = yield* start;
    const tools = yield* Effect.tryPromise({
      try: () => started.listTools({ timeoutMs: LIST_TIMEOUT_MS }),
      catch: (cause) =>
        fail(
          `Could not list computer use tools on ${host}: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    });
    return {
      host,
      tools: tools.map((tool) => ({
        name: tool.name.slice(0, 128),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
      })),
    };
  }).pipe(permit.withPermits(1), Effect.withSpan("HostComputerUse.listTools"));

  const callTool: HostComputerUse["Service"]["callTool"] = Effect.fn("HostComputerUse.callTool")(
    function* (input) {
      if (unsupported !== null) return yield* unsupported;
      const refusal = ownAppComputerUseRefusal(input.arguments);
      if (refusal !== undefined) return yield* fail(refusal);
      yield* used;
      const started = yield* start;
      const raw = yield* Effect.tryPromise({
        try: (signal) =>
          started.callTool(input.tool, input.arguments, {
            timeoutMs: input.timeoutMs ?? HOST_COMPUTER_CALL_DEFAULT_TIMEOUT_MS,
            signal,
          }),
        catch: (cause) =>
          fail(
            cause instanceof McpClientError && cause.kind === "timeout"
              ? `${input.tool} on ${host} did not finish in time.`
              : `${input.tool} on ${host} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      });
      const result = withoutOwnApps(input.tool, {
        content: normalizeMcpToolContent(raw.content),
        ...(raw.isError === undefined ? {} : { isError: raw.isError }),
        ...(raw.structuredContent === undefined
          ? {}
          : { structuredContent: raw.structuredContent }),
      });
      if (resultSize(result) > MAX_RESULT_CHARS) {
        return yield* fail(
          `${input.tool} on ${host} returned more than computer use sends back. Ask for less, such as one app or a smaller region.`,
        );
      }
      return result;
    },
    permit.withPermits(1),
    // Tags the call's span with its tool before the call waits for the permit.
    (effect, input) => Effect.andThen(Effect.annotateCurrentSpan("tool", input.tool), effect),
  );

  // Idle machines give their screen back: the next call starts everything again.
  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if ((client !== null || display !== null) && now - lastUsedAt >= IDLE_MS) {
      yield* Effect.sync(stop);
    }
  }).pipe(permit.withPermits(1), Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);

  return HostComputerUse.of({ listTools, callTool });
});

export const layer = Layer.effect(HostComputerUse, make);
