import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type TempoLook, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { withLook } from "../../../test/look";
import { render } from "../../../test/render";
import { PreviewPanelShell } from "~/components/preview/PreviewPanelShell";
import { usePreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

import { makeRoomForPage, usePageRoom } from "./pageRoom";

const widthKey = (threadRef: ScopedThreadRef) =>
  `t3code:preview-panel-width:${scopedThreadKey(threadRef)}`;

function Workspace(props: { readonly threadRef: ScopedThreadRef; readonly tabId: string }) {
  return (
    <AppAtomRegistryProvider>
      <Row {...props} />
    </AppAtomRegistryProvider>
  );
}

function Row(props: { readonly threadRef: ScopedThreadRef; readonly tabId: string }) {
  const pageRoom = usePageRoom(props.threadRef, {
    id: `browser:${props.tabId}`,
    kind: "preview",
    resourceId: props.tabId,
  });
  const inlineSize = usePreviewPanelInlineSize({
    widthStorageKey: widthKey(props.threadRef),
    pageRoom,
  });
  return (
    <div className="flex h-screen w-screen">
      <main className="flex-1">Chat</main>
      <PreviewPanelShell mode="inline" inlineSize={inlineSize}>
        Page
      </PreviewPanelShell>
    </div>
  );
}

/** Each test its own thread, so the room one test makes never reaches another. */
function thread(name: string, savedWidth: number | null): ScopedThreadRef & Disposable {
  const threadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(name));
  if (savedWidth !== null) localStorage.setItem(widthKey(threadRef), String(savedWidth));
  return { ...threadRef, [Symbol.dispose]: () => localStorage.removeItem(widthKey(threadRef)) };
}

const panelOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-preview-panel-mode]")!;
const widthOf = (container: HTMLElement) => () => panelOf(container).getBoundingClientRect().width;

describe("page room", () => {
  it.each<[string, TempoLook, number, number | null, boolean, number]>([
    [
      "a page opened from a click gets 40 percent of a MacBook window",
      "tempo",
      1728,
      null,
      true,
      691,
    ],
    ["an ultrawide window gives a page at most 1280 px", "tempo", 3840, null, true, 1280],
    ["a wider width the person set stays", "tempo", 1728, 900, true, 900],
    ["a tab not opened from a click keeps their width", "tempo", 1728, null, false, 540],
    ["the classic look keeps their width", "classic", 1728, null, true, 540],
  ])("%s", async (name, look, windowWidth, savedWidth, fromClick, expected) => {
    await page.viewport(windowWidth, 1080);
    using _look = withLook(look);
    using threadRef = thread(name, savedWidth);
    if (fromClick) makeRoomForPage(threadRef, "tab-a");
    await using screen = await render(<Workspace threadRef={threadRef} tabId="tab-a" />, {
      router: false /* no links or routes */,
    });
    await expect.poll(widthOf(screen.container)).toBe(expected);
  });

  it("keeps the width the person drags to, until the next page opens from a click", async () => {
    await page.viewport(1728, 1080);
    using _look = withLook("tempo");
    using threadRef = thread("drag", null);
    makeRoomForPage(threadRef, "tab-a");
    await using screen = await render(<Workspace threadRef={threadRef} tabId="tab-a" />, {
      router: false /* no links or routes */,
    });
    const width = widthOf(screen.container);
    await expect.poll(width).toBe(691);

    await userEvent.dragAndDrop(
      screen.getByRole("separator"),
      page.elementLocator(panelOf(screen.container)),
      { targetPosition: { x: 250, y: 100 } },
    );
    await expect.poll(width).toBe(441);
    expect(localStorage.getItem(widthKey(threadRef))).toBe("441");

    makeRoomForPage(threadRef, "tab-b");
    await screen.rerender(<Workspace threadRef={threadRef} tabId="tab-b" />);
    await expect.poll(width).toBe(691);
  });
});
