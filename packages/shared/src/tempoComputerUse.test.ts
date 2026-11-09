import { describe, expect, it } from "vite-plus/test";

import { ownAppComputerUseRefusal, isOwnApp, withoutOwnApps } from "./tempoComputerUse.ts";

describe("isOwnApp", () => {
  it("knows Tempo by its bundle id, its names and its path, in any case and spacing", () => {
    for (const app of [
      "local.tempo.app",
      "LOCAL.Tempo.APP",
      "local.tempo.app.dev.main",
      "Tempo",
      "tempo",
      "  Tempo\n",
      "Tempo (Dev)",
      "Tempo (Nightly)",
      "Tempo.app",
      "/Applications/Tempo.app",
      "/Applications/Tempo.app/",
      "/Users/ada/Applications/Tempo (Nightly).app",
      "/Applications/Tempo.app/Contents/MacOS/Tempo",
    ]) {
      expect(isOwnApp(app), app).toBe(true);
    }
  });

  it("leaves other apps alone, Tempo's windowless helpers and look-alike names included", () => {
    for (const app of [
      "Notes",
      "com.apple.Notes",
      "Tempus",
      "Templar",
      "Tempo Helper",
      "Tempo Helper (GPU)",
      "Tempos",
      "Tempo Tools",
      "T3 Code",
      "com.t3tools.t3code",
      "local.tempo.app.helper",
      "local.tempo.app.dev.main.helper.renderer",
      "local.tempo.app.service",
      "/Applications/Notes.app",
      "/Users/ada/Tempo/Notes.app",
      "/Applications/Tempo.app/Contents/Frameworks/Tempo Helper.app",
      "",
    ]) {
      expect(isOwnApp(app), app).toBe(false);
    }
  });
});

describe("ownAppComputerUseRefusal", () => {
  it("refuses a call on Tempo and tells the agent what to use instead", () => {
    const refusal = ownAppComputerUseRefusal({
      app: "Tempo",
      window_placement: "agent_display",
    });
    expect(refusal).toContain("Tempo is the app the user talks to you in");
    expect(refusal).toContain("Tempo's own tools");
    // The laptop's failure text reaches the agent cut to 300 characters.
    expect(refusal?.length).toBeLessThanOrEqual(300);
  });

  it("lets every other call through", () => {
    expect(ownAppComputerUseRefusal({ app: "Notes" })).toBeUndefined();
    expect(ownAppComputerUseRefusal({ app: 7 })).toBeUndefined();
    expect(ownAppComputerUseRefusal({})).toBeUndefined();
  });
});

describe("withoutOwnApps", () => {
  const text = (lines: ReadonlyArray<string>) => ({
    content: [{ type: "text" as const, text: lines.join("\n") }],
  });

  it("drops every Tempo build from list_apps and keeps the rest", () => {
    expect(
      withoutOwnApps(
        "list_apps",
        text([
          "Tempo — local.tempo.app [frontmost, running, last-used=2026-10-21, uses=40]",
          "Notes — com.apple.Notes [running]",
          "Tempo (Dev) — local.tempo.app.dev.main [running]",
          "Google Chrome — com.google.Chrome [last-used=2026-10-20, uses=12]",
        ]),
      ),
    ).toEqual(
      text([
        "Notes — com.apple.Notes [running]",
        "Google Chrome — com.google.Chrome [last-used=2026-10-20, uses=12]",
      ]),
    );
  });

  it("leaves other tools' results as they are", () => {
    const state = text(["Tempo — local.tempo.app [running]"]);
    expect(withoutOwnApps("get_app_state", state)).toBe(state);
  });
});
