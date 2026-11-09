/**
 * tempo: a thread's deliverables, for the side panel's Deliverables tab: the pages its agent shared
 * (tempoThreadPages.ts, read again when a run ends) and its linked pull requests, newest first. A
 * reply's cards (`replies/ReplyDeliverables.tsx`) read the same pages.
 */
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcQueryAtomFamily,
  selectEnvironmentQueryData,
} from "@t3tools/client-runtime/state/runtime";
import { visibleThreadPullRequests } from "@t3tools/client-runtime/thread-pull-requests";
import {
  TEMPO_THREAD_PAGES_WS_METHODS,
  type TempoThreadPage,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import type { MouseEvent } from "react";

import type { LinkOrigin } from "../../browser/browserLinkTarget";
import { useOpenLink } from "../../browser/useOpenLink";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadShell, useServerConfigs } from "../../state/entities";
import { useEnvironmentQuerySelector } from "../../state/query";
import { environmentThreadShells } from "../../state/threads";

/** The thread's last finished run; a run that starts keeps the one before it. */
const latestRunEnd = Atom.family((threadKey: string) => {
  const threadRef = parseScopedThreadKey(threadKey);
  return Atom.make((get): string | null => {
    if (threadRef === null) return null;
    const run = get(environmentThreadShells.quietThreadShellAtom(threadRef))?.latestRun;
    return run?.completedAt
      ? `${run.runId}:${run.completedAt}`
      : Option.getOrNull(get.self<string | null>());
  });
});

const threadPagesQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:tempo:thread-pages",
  tag: TEMPO_THREAD_PAGES_WS_METHODS.list,
  refreshTrigger: ({ environmentId, input }) =>
    latestRunEnd(scopedThreadKey({ environmentId, threadId: input.threadId })),
});

const NO_PAGES: ReadonlyArray<TempoThreadPage> = [];

/** `loading` until the server first answers; `failed` when it answered with an error only. */
export type ThreadPagesStatus = "loading" | "loaded" | "failed";

const selectPagesStatus = (result: AsyncResult.AsyncResult<unknown, unknown>): ThreadPagesStatus =>
  AsyncResult.isInitial(result)
    ? "loading"
    : Option.isSome(AsyncResult.value(result))
      ? "loaded"
      : "failed";

const newestLinkedFirst = (left: ThreadPullRequestLink, right: ThreadPullRequestLink) =>
  right.linkedAt.localeCompare(left.linkedAt) || right.number - left.number;

export interface ThreadPages {
  readonly pages: ReadonlyArray<TempoThreadPage>;
  readonly pagesStatus: ThreadPagesStatus;
}

export interface ThreadDeliverables extends ThreadPages {
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
}

export function useThreadPages(threadRef: ScopedThreadRef | null): ThreadPages {
  const configs = useServerConfigs();
  const serves =
    threadRef !== null &&
    configs.get(threadRef.environmentId)?.environment.capabilities.tempoThreadPages === true;
  const query = serves
    ? threadPagesQuery({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      })
    : null;
  const pages = useEnvironmentQuerySelector(query, selectEnvironmentQueryData);
  const pagesStatus = useEnvironmentQuerySelector(query, selectPagesStatus);
  return {
    pages: pages?.pages ?? NO_PAGES,
    pagesStatus: query === null ? "loaded" : pagesStatus,
  };
}

export function useThreadDeliverables(threadRef: ScopedThreadRef | null): ThreadDeliverables {
  const shell = useQuietThreadShell(threadRef);
  return {
    ...useThreadPages(threadRef),
    pullRequests: visibleThreadPullRequests(shell?.pullRequests ?? []).toSorted(newestLinkedFirst),
  };
}

/** Opens a page where a link clicked at `origin` opens (browserLinkTarget.ts). */
export function useOpenThreadPage(threadRef: ScopedThreadRef, origin: LinkOrigin) {
  const openLink = useOpenLink(threadRef);
  return (event: MouseEvent<HTMLAnchorElement>, url: string) => {
    event.preventDefault();
    void openLink(url, { event, origin }).catch((error: unknown) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open the page",
          description: error instanceof Error ? error.message : undefined,
        }),
      ),
    );
  };
}

/** Opens the thread's Deliverables tab, the first tab of its side panel. */
export function openThreadDeliverables(threadRef: ScopedThreadRef) {
  useRightPanelStore.getState().open(threadRef, "deliverables");
}
