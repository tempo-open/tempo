import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");
const MODEL = "claude-opus-5-5";
const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-tempo"),
  ThreadId.make("tempo-thread"),
);

const options = (
  entries: Record<string, string | boolean>,
): ReadonlyArray<ProviderOptionSelection> =>
  Object.entries(entries).map(([id, value]) => ({ id, value }));

describe("ultracode and sticky composer options", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      stickyModelSelectionByProvider: {},
      stickyOptionsByModelByProvider: {},
      stickyActiveProvider: null,
    });
  });

  it("keeps ultracode on the thread but never in what new threads inherit", () => {
    const store = useComposerDraftStore.getState();
    // Ultracode is on for this thread, then the effort changes in the traits menu.
    store.setProviderModelOptions(threadRef, CLAUDE, options({ effort: "max", ultracode: true }), {
      instanceId: CLAUDE_INSTANCE,
      model: MODEL,
      persistSticky: true,
    });
    const state = useComposerDraftStore.getState();
    expect(state.stickyModelSelectionByProvider[CLAUDE_INSTANCE]).toEqual(
      createModelSelection(CLAUDE_INSTANCE, MODEL, options({ effort: "max" })),
    );
    expect(state.stickyOptionsByModelByProvider[CLAUDE_INSTANCE]?.[MODEL]).toEqual(
      options({ effort: "max" }),
    );
    const draft = Object.values(state.draftsByThreadKey)[0];
    expect(draft?.modelSelectionByProvider[CLAUDE_INSTANCE]?.options).toEqual(
      options({ effort: "max", ultracode: true }),
    );
  });

  it("drops the legacy ultracode effort from sticky options too", () => {
    useComposerDraftStore
      .getState()
      .setProviderModelOptions(
        threadRef,
        CLAUDE,
        options({ effort: "ultracode", thinking: true }),
        {
          instanceId: CLAUDE_INSTANCE,
          model: MODEL,
          persistSticky: true,
        },
      );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CLAUDE_INSTANCE]?.options,
    ).toEqual(options({ thinking: true }));
  });
});
