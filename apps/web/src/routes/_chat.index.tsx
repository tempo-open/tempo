import { workspaceAreaProps } from "../lib/workspaceFocus";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isElectron } from "../env";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  readProject,
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useEnvironmentShellHasSnapshot } from "../state/shell";
import { HostUnreachableState } from "~/tempo/HostUnreachable";
import { useNewWorkEnvironmentId } from "~/tempo/newWorkEnvironment";
import { pickNewWorkProject } from "@t3tools/client-runtime/tempo/new-work-environment";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
    // tempo: a laptop whose local server is off, while its host does not answer.
    const unreachable = unreachableHostLabels(environments);
    if (unreachable !== null) return <HostUnreachableState labels={unreachable} />;
  }

  return <IndexDraftLanding />;
}

function IndexDraftLanding() {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const newWorkEnvironmentId = useNewWorkEnvironmentId();
  const router = useRouter();
  // Read at effect time; this page can stay mounted while the router is already navigating away.
  const isStillOnIndex = useEffectEvent(() => router.state.location.pathname === "/");
  const startedAttemptRef = useRef<number | null>(null);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  // tempo: the most recent project where this device runs new work, else the most recent anywhere.
  // That environment's projects decide, so the pick waits for them unless every shell is in.
  const newWorkShellReady = useEnvironmentShellHasSnapshot(newWorkEnvironmentId);
  const mostRecentProject =
    newWorkEnvironmentId === null || newWorkShellReady || bootstrapped
      ? pickNewWorkProject(
          sortScopedProjectsForSidebar(projects, threads, "updated_at"),
          newWorkEnvironmentId,
        )
      : null;
  const attempt = startState.retryRequest;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts a draft thread in the most recent project and navigates to it while still on the index
  useEffect(() => {
    // Starting a draft after the user has left would replace the page they picked.
    if (mostRecentProject === null || startedAttemptRef.current === attempt || !isStillOnIndex()) {
      return;
    }
    const projectRef = scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id);
    if (readProject(projectRef) === null) {
      return;
    }
    startedAttemptRef.current = attempt;
    void handleNewThread(projectRef, { replace: true })
      .then((opened) => {
        if (opened === null) {
          setStartState((state) => ({ ...state, retryRequest: state.retryRequest + 1 }));
        }
      })
      .catch(() => {
        setStartState((state) => ({ ...state, failed: true }));
      });
  }, [attempt, handleNewThread, mostRecentProject]);

  if (mostRecentProject !== null) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  // A pending environment cannot prove the workspace is empty.
  return bootstrapped ? <NoProjectsHero /> : null;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  const contentArea = workspaceAreaProps("home", 1, "Home");
  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription>
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RefreshIcon size="md" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

/**
 * tempo: the labels of the switched-on environments when every one of them has
 * failed to connect (offline, refused, or retrying after an error); null
 * while any is connected or still making its first attempt.
 */
function unreachableHostLabels(
  environments: ReadonlyArray<{
    readonly label: string;
    readonly entry: { readonly enabled: boolean };
    readonly connection: { readonly phase: string; readonly error: string | null };
  }>,
): ReadonlyArray<string> | null {
  const enabled = environments.filter((environment) => environment.entry.enabled);
  const failed = enabled.filter(
    ({ connection }) =>
      connection.phase === "offline" ||
      connection.phase === "error" ||
      (connection.phase === "reconnecting" && connection.error !== null),
  );
  return enabled.length > 0 && failed.length === enabled.length
    ? failed.map((environment) => environment.label)
    : null;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
