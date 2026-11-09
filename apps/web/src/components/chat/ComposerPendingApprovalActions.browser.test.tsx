import { RuntimeRequestId, type ProviderApprovalOption } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

function renderActions(
  onRespond: () => Promise<undefined>,
  options?: ReadonlyArray<ProviderApprovalOption>,
  alwaysAllowLabel?: string,
) {
  return render(
    <ComposerPendingApprovalActions
      requestId={RuntimeRequestId.make("approval-1")}
      canRespond
      isResponding={false}
      options={options}
      alwaysAllowLabel={alwaysAllowLabel}
      onRespondToApproval={onRespond}
    />,
  );
}

const rowLabels = (container: HTMLElement) =>
  [...container.querySelectorAll("button")]
    .map((button) => button.textContent?.trim())
    .filter(Boolean);

async function openMore(container: HTMLElement) {
  await act(async () =>
    container.querySelector<HTMLElement>('[aria-label="More approval options"]')!.click(),
  );
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

describe("ComposerPendingApprovalActions", () => {
  it("says once versus always, with Cancel in the menu", async () => {
    const onRespond = vi.fn(async () => undefined);
    await using screen = await renderActions(onRespond);
    expect(rowLabels(screen.container)).toEqual([
      "Deny",
      "Always allow in this chat",
      "Allow once",
    ]);

    const items = await openMore(screen.container);
    expect(items.map((item) => item.textContent?.trim())).toEqual(["Cancel"]);
    await act(async () => items[0]!.click());
    expect(onRespond).toHaveBeenCalledWith(RuntimeRequestId.make("approval-1"), "cancel");
  });

  it("names what always-allow covers", async () => {
    const onRespond = vi.fn(async () => undefined);
    await using screen = await renderActions(
      onRespond,
      undefined,
      "Always allow Bash in this chat",
    );
    expect(rowLabels(screen.container)).toEqual([
      "Deny",
      "Always allow Bash in this chat",
      "Allow once",
    ]);
  });

  it("sends the always-allow decision from its own button", async () => {
    const onRespond = vi.fn(async () => undefined);
    await using screen = await renderActions(onRespond);
    await act(async () =>
      [...screen.container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Always allow in this chat")!
        .click(),
    );
    expect(onRespond).toHaveBeenCalledWith(RuntimeRequestId.make("approval-1"), "acceptForSession");
  });

  it("keeps provider labels and warnings working", async () => {
    const onRespond = vi.fn(async () => undefined);
    await using screen = await renderActions(onRespond, [
      { decision: "decline", label: "No thanks" },
      { decision: "acceptAlways", label: "Always allow Safari" },
      { decision: "accept", label: "Allow once" },
      { decision: "cancel", label: "Stop the run", warning: "Ends the turn" },
    ]);
    expect(rowLabels(screen.container)).toEqual(["No thanks", "Allow once"]);
    expect((await openMore(screen.container)).map((item) => item.textContent?.trim())).toEqual([
      "Always allow Safari",
      "Stop the run",
    ]);

    await act(async () =>
      [...screen.container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Allow once")!
        .click(),
    );
    expect(onRespond).toHaveBeenCalledWith(RuntimeRequestId.make("approval-1"), "accept");
  });
});
