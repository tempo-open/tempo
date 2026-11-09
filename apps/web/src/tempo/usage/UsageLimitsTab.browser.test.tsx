import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { limitsFixture } from "../limits/limitsFixture";
import { UsageLimitsTab } from "./UsageLimitsTab";

const renderTab = (presentations: Parameters<typeof UsageLimitsTab>[0]["presentations"]) =>
  render(
    <RegistryProvider>
      <UsageLimitsTab presentations={presentations} cursorPrompt={null} />
    </RegistryProvider>,
    { router: "/usage" },
  );

describe("the Limits tab", () => {
  it("lists each account by its name, with no way to rename it", async () => {
    await using screen = await renderTab(
      limitsFixture(Date.parse("2026-11-07T20:01:00.000Z"), "sample-a", EnvironmentId.make("env")),
    );

    for (const name of ["Work", "Hobby", "Contract", "Main", "Backup", "Client"]) {
      await expect.element(screen.getByText(name, { exact: true })).toBeVisible();
    }
    expect(document.querySelector('[aria-label^="Rename"]')).toBeNull();
  });

  it("says no provider reports limits when there are no accounts", async () => {
    await using screen = await renderTab(new Map());

    await expect
      .element(screen.getByText("No provider on this Mac reports subscription limits."))
      .toBeVisible();
  });
});
