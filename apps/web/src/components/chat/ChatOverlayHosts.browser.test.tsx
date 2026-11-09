import { MessageId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";
import { openRevertConfirm, RevertConfirmHost } from "./ChatOverlayHosts";

const messageId = MessageId.make("message-1");
const dialog = () => document.querySelector('[role="alertdialog"]');
const dialogButtons = () =>
  [...(dialog()?.querySelectorAll("button") ?? [])].map((button) => button.textContent);

describe("RevertConfirmHost", () => {
  const host = (threadKey: string, onConfirm: () => void) => (
    <AppAtomRegistryProvider>
      <RevertConfirmHost threadKey={threadKey} onConfirm={onConfirm} />
    </AppAtomRegistryProvider>
  );

  // tempo: a folder that is not a Git repository saves no files to restore.
  it("offers only to rewind the chat when the turn saved no files", async () => {
    const onConfirm = vi.fn();
    await using _screen = await render(host("env:a", onConfirm));

    await act(() =>
      openRevertConfirm("env:a", { turnCount: 0, messageId, filesRestorable: false }),
    );
    expect(dialogButtons()).toEqual(["Cancel", "Rewind chat"]);
    expect(dialog()?.textContent).toContain("Files stay as they are");
    const rewind = [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Rewind chat",
    );
    await act(() => rewind?.click());
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(0, messageId, false);
  });
});
