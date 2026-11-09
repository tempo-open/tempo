import type { Permission } from "@opencode/client/effect";
import type { RuntimeMode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sessionRules } from "./adapter.ts";

const SERVER = "t3-code-thread_1";

/** OpenCode's evaluation: the last rule whose action and resource match decides. */
const decide = (rules: ReadonlyArray<Permission.Rule>, action: string) => {
  const escape = (part: string) => part.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&");
  const matches = (pattern: string, value: string) =>
    new RegExp(`^${pattern.split("*").map(escape).join(".*")}$`).test(value);
  return rules.findLast((rule) => matches(rule.action, action) && matches(rule.resource, "*"))
    ?.effect;
};

const rulesFor = (runtimeMode: RuntimeMode, grants: ReadonlyArray<Permission.Rule> = []) =>
  sessionRules({ runtimeMode, interactionMode: "default" }, [], grants, SERVER);

describe("OpenCode 2 rules for tempo company service tools", () => {
  it("asks before service writes unless the thread has full access", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      const rules = rulesFor(mode);
      expect(decide(rules, `${SERVER}_openrouter_key_delete`), mode).toBe("ask");
      expect(decide(rules, `${SERVER}_cloudflare_dns_record_upsert`), mode).toBe("ask");
      expect(decide(rules, `${SERVER}_service_request`), mode).toBe("ask");
      // Reads and the rest of this thread's T3 tools stay allowed; other threads' stay denied.
      expect(decide(rules, `${SERVER}_openrouter_credits`), mode).toBe("allow");
      expect(decide(rules, `${SERVER}_delegate_task`), mode).toBe("allow");
      expect(decide(rules, "t3-code-thread_2_openrouter_credits"), mode).toBe("deny");
    }
    expect(decide(rulesFor("full-access"), `${SERVER}_openrouter_key_delete`)).toBe("allow");
  });

  it("keeps an 'Allow this session' answer for a service write", () => {
    const rules = rulesFor("approval-required", [
      { action: `${SERVER}_openrouter_key_delete`, resource: "*", effect: "allow" },
    ]);
    expect(decide(rules, `${SERVER}_openrouter_key_delete`)).toBe("allow");
    expect(decide(rules, `${SERVER}_openrouter_key_create`)).toBe("ask");
  });
});
