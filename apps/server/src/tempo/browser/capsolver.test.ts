import { describe, expect, it } from "@effect/vitest";

import { capsolverConfig, isCapsolverKey } from "./capsolver.ts";

/**
 * How CapSolver 1.17.1 reads `assets/config.js` (`background.js`): it strips
 * comments, flattens the object body, splits it on commas and colons, and
 * types values by key name. Kept verbatim in behaviour, so these tests check
 * what the extension itself will see.
 */
const readLikeCapsolver = (text: string): Record<string, unknown> => {
  const numbers = ["DelayTime", "RepeatTimes", "port"];
  const booleans = ["enabledFor", "useCapsolver", "manualSolving", "useProxy", "showSolveButton"];
  const source = text.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "");
  const body = source.slice(source.indexOf("{") + 1, source.lastIndexOf("}"));
  const flat = JSON.stringify(body)
    .replaceAll('\\"', "'")
    .replaceAll("\\n", "")
    .replaceAll('"', "")
    .replaceAll(" ", "");
  const list = flat.slice(flat.indexOf("blackUrlList"));
  const listEntry = list.slice(0, list.indexOf("],") + 1);
  const config: Record<string, unknown> = {};
  for (const entry of flat.replace(listEntry, "").split(",")) {
    const [key, raw] = entry.split(":");
    if (!key || !raw) continue;
    let value: unknown = raw.replaceAll("'", "").replaceAll('"', "");
    if (numbers.some((suffix) => key.endsWith(suffix))) value = Number(value);
    if (booleans.some((prefix) => key.startsWith(prefix))) value = value === "true";
    config[key] = value;
  }
  return config;
};

describe("capsolverConfig", () => {
  it("gives CapSolver the key and turns every captcha type on, with no proxy", () => {
    expect(readLikeCapsolver(capsolverConfig("CAP-0123456789ABCDEF"))).toEqual({
      apiKey: "CAP-0123456789ABCDEF",
      useCapsolver: true,
      manualSolving: false,
      useProxy: false,
      enabledForBlacklistControl: false,
      enabledForRecaptcha: true,
      enabledForRecaptchaV3: true,
      enabledForHCaptcha: true,
      enabledForCloudflare: true,
      enabledForAwsCaptcha: true,
      enabledForGeetestV4: true,
      enabledForDataDome: true,
      enabledForImageToText: true,
    });
  });

  it("leaves the key empty without one, and never writes a malformed one", () => {
    expect(readLikeCapsolver(capsolverConfig(null)).apiKey).toBe("");
    const injected = capsolverConfig("CAP-1,useCapsolver:false");
    expect(readLikeCapsolver(injected)).toMatchObject({ apiKey: "", useCapsolver: true });
  });

  it("accepts CapSolver's key shape only", () => {
    expect(isCapsolverKey(`CAP-${"0A".repeat(32)}`)).toBe(true);
    expect(isCapsolverKey("CAP-12")).toBe(false);
    expect(isCapsolverKey("CAP-1234'5678")).toBe(false);
    expect(isCapsolverKey("CAP-1234 5678")).toBe(false);
  });
});
