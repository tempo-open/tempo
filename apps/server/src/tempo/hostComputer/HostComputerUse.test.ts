import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as HostComputerUse from "./HostComputerUse.ts";

const hostComputerUseLayer = HostComputerUse.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "tempo-host-computer-" })),
  Layer.provide(NodeServices.layer),
);
const isHostComputerUseError = Schema.is(HostComputerUse.HostComputerUseError);

describe("parseDoctor", () => {
  it("reads whether Open Computer Use has its permissions, and which are missing", () => {
    expect(
      HostComputerUse.parseDoctor(
        '{"accessibilityTrusted":false,"allGranted":false,"missingPermissions":["accessibility","screenRecording"],"platform":"macos","screenCaptureGranted":false}',
      ),
    ).toEqual({ allGranted: false, missing: ["accessibility", "screenRecording"] });
    expect(HostComputerUse.parseDoctor('{"allGranted":true,"missingPermissions":[]}')).toEqual({
      allGranted: true,
      missing: [],
    });
    expect(HostComputerUse.parseDoctor("Open Computer Use 1.1.2")).toBeNull();
  });
});

describe("missingPermissionsReason", () => {
  it("tells the agent which permissions to ask the user for, and where", () => {
    const reason = HostComputerUse.missingPermissionsReason("studio", ["screenRecording"]);
    expect(reason).toContain("Screen Recording on studio");
    expect(reason).toContain("Privacy & Security → Screen Recording → Open Computer Use");
    expect(reason).toContain("computer_use_tools");
  });
});

describe("callTool", () => {
  it.effect("refuses Tempo itself before starting Open Computer Use", () =>
    Effect.gen(function* () {
      const computer = yield* HostComputerUse.HostComputerUse;
      for (const app of ["Tempo", "  local.tempo.app ", "/Applications/Tempo.app"]) {
        const refused = yield* computer
          .callTool({
            tool: "get_app_state",
            arguments: { app, window_placement: "agent_display" },
          })
          .pipe(Effect.flip);
        expect(refused.message).toContain("Tempo is the app the user talks to you in");
      }
    }).pipe(
      Effect.provide(hostComputerUseLayer),
      // Computer use needs macOS, which is checked first; nothing here starts it.
      Effect.provideService(HostProcess.Platform, "darwin"),
    ),
  );
});

// Downloads Open Computer Use and builds the helper on a real Mac, so it runs only when asked.
// oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- opt-in real-Mac install (TEMPO_TEST_HOST_COMPUTER): minutes of download and build, not a hidden wait
it.effect.skipIf(process.env.TEMPO_TEST_HOST_COMPUTER !== "1")(
  "installs Open Computer Use and checks its permissions on this Mac",
  () =>
    Effect.gen(function* () {
      const computer = yield* HostComputerUse.HostComputerUse;
      const listed = yield* computer.listTools.pipe(Effect.result);
      if (listed._tag === "Success") {
        assert.isAbove(listed.success.tools.length, 0);
        return;
      }
      // A Mac that has not granted Open Computer Use yet says so, after installing it.
      assert.isTrue(isHostComputerUseError(listed.failure));
      expect(listed.failure.message).toContain("Open Computer Use is not allowed");
    }).pipe(Effect.provide(hostComputerUseLayer)),
  300_000,
);
