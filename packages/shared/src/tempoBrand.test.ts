import { describe, expect, it } from "vite-plus/test";

import { applyTempoHomeEnv, tempoAgentText } from "./tempoBrand.ts";

describe("tempoAgentText", () => {
  it("names Tempo wherever upstream's wording names T3 or T3 Code, articles included", () => {
    expect(
      tempoAgentText(
        "Needs an agent running inside a T3 thread. A T3-owned task. T3 Code checks it, and T3's browser opens. Ask a T3 Code server, then T3 Code's tools.",
      ),
    ).toBe(
      "Needs an agent running inside a Tempo thread. A Tempo-owned task. Tempo checks it, and Tempo's browser opens. Ask a Tempo server, then Tempo's tools.",
    );
  });

  it("keeps the name of upstream's relay, T3 Connect", () => {
    expect(tempoAgentText("Enable T3 Connect on a T3 host.")).toBe(
      "Enable T3 Connect on a Tempo host.",
    );
  });

  it("leaves identifiers and other words alone", () => {
    const identifiers =
      "Call t3_thread_launch on the `t3-code` server (mcp__t3_code__delegate_task), link t3-thread://v1/x, read $T3_ACP_MCP_NODE and T3CODE_HOME, via MT3 data.";
    expect(tempoAgentText(identifiers)).toBe(identifiers);
  });
});

describe("applyTempoHomeEnv", () => {
  it("lets TEMPO_HOME stand in for T3CODE_HOME and win when both are set", () => {
    const env: Record<string, string | undefined> = {
      TEMPO_HOME: " /data/tempo ",
      T3CODE_HOME: "/data/t3",
    };
    applyTempoHomeEnv(env);
    expect(env.T3CODE_HOME).toBe("/data/tempo");
  });

  it("keeps T3CODE_HOME when TEMPO_HOME is unset or blank", () => {
    const unset: Record<string, string | undefined> = { T3CODE_HOME: "/data/t3" };
    applyTempoHomeEnv(unset);
    expect(unset.T3CODE_HOME).toBe("/data/t3");

    const blank: Record<string, string | undefined> = { TEMPO_HOME: "  " };
    applyTempoHomeEnv(blank);
    expect(blank.T3CODE_HOME).toBeUndefined();
  });
});
