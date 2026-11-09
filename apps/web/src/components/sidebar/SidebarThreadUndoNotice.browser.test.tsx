import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { commitThreadUndosNow, showThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { act, render } from "../../../test/render";
import { toastManager } from "../ui/toast";
import { ThreadUndoToast } from "./SidebarThreadUndoNotice";

const mocks = vi.hoisted(() => ({ sidebarVisible: true, pathname: "/env/thread" }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: mocks.pathname }),
}));
vi.mock("../ui/sidebar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/sidebar")>()),
  useSidebarVisibility: () => mocks.sidebarVisible,
}));

const undo = vi.fn(async () => AsyncResult.success(undefined));
const showDeleted = () =>
  act(() =>
    showThreadUndoNotice({
      action: "Deleted",
      failureTitle: "Failed to restore thread",
      undo,
      claim: ThreadUndo.begin("delete", `env/thread-${Math.random()}`),
    }),
  );

async function mountToast(input: { readonly sidebarVisible: boolean; readonly pathname: string }) {
  mocks.sidebarVisible = input.sidebarVisible;
  mocks.pathname = input.pathname;
  const add = vi.spyOn(toastManager, "add");
  const close = vi.spyOn(toastManager, "close");
  const view = await render(<ThreadUndoToast />);
  return {
    add,
    close,
    [Symbol.asyncDispose]: async () => {
      await view[Symbol.asyncDispose]();
      await act(() => commitThreadUndosNow());
      add.mockRestore();
      close.mockRestore();
      undo.mockClear();
    },
  };
}

describe("ThreadUndoToast", () => {
  it("stays out of the way while the sidebar shows the notice", async () => {
    await using toast = await mountToast({ sidebarVisible: true, pathname: "/env/thread" });
    await showDeleted();
    expect(toast.add).not.toHaveBeenCalled();
  });

  it("carries the notice while the sidebar is hidden, and its button undoes", async () => {
    await using toast = await mountToast({ sidebarVisible: false, pathname: "/env/thread" });
    await showDeleted();
    expect(toast.add).toHaveBeenCalledOnce();
    const shown = toast.add.mock.calls[0]![0];
    expect(shown.title).toBe("Deleted 1 thread");

    await act(async () => (shown.actionProps as { onClick: () => void }).onClick());
    expect(undo).toHaveBeenCalledOnce();
    expect(toast.close).toHaveBeenCalled();
  });

  it("carries the notice over Settings, which covers the sidebar", async () => {
    await using toast = await mountToast({ sidebarVisible: true, pathname: "/settings/archived" });
    await showDeleted();
    expect(toast.add).toHaveBeenCalledOnce();
  });
});
