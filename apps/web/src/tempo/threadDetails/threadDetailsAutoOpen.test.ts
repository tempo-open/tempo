import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { threadPanelStatePresentation } from "./threadDetailsAutoOpen";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));

const inlineCardOpen = (autoOpen: boolean) =>
  selectThreadPanelOpen(
    useRightPanelStore.getState().threadPanelVisibilityByThreadKey,
    ref,
    threadPanelStatePresentation("inline", autoOpen),
  );

const pressButton = (autoOpen: boolean) =>
  useRightPanelStore
    .getState()
    .toggleThreadPanel(ref, threadPanelStatePresentation("inline", autoOpen));

beforeEach(() => {
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

describe("tempo: Open thread details automatically", () => {
  it("off, a thread's inline card stays closed until its button opens it", () => {
    expect(inlineCardOpen(false)).toBe(false);
    pressButton(false);
    expect(inlineCardOpen(false)).toBe(true);
    pressButton(false);
    expect(inlineCardOpen(false)).toBe(false);
  });

  it("on, the inline card opens on its own, as in T3", () => {
    expect(inlineCardOpen(true)).toBe(true);
    pressButton(true);
    expect(inlineCardOpen(true)).toBe(false);
  });
});
