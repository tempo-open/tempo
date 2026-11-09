/**
 * tempo: the connectors list `/mcp` opens: the MCP servers the thread's Claude has, with a sign in for
 * the ones that ask for it. Sign in opens the server's page in the browser of the Mac Claude runs on.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type TempoMcpConnector,
  TempoMcpConnectorsError,
  type TempoMcpConnectorsList,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Spinner } from "../../components/ui/spinner";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  closeMcpConnectors,
  type McpConnectorsRequest,
  mcpConnectorsCancelSignIn,
  mcpConnectorsList,
  mcpConnectorsReconnect,
  mcpConnectorsSignIn,
  useMcpConnectorsRequest,
} from "./mcpConnectorsState";

const isConnectorsError = Schema.is(TempoMcpConnectorsError);

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  if (isConnectorsError(error) && error.reason === "cancelled") return null;
  return error instanceof Error ? error.message : "The request failed.";
}

function statusText(connector: TempoMcpConnector): string {
  switch (connector.status) {
    case "connected":
      return connector.toolCount === 1
        ? "Connected, 1 tool"
        : `Connected, ${connector.toolCount} tools`;
    case "needs-auth":
      return "Needs sign in";
    case "failed":
      return connector.error ?? "Could not connect";
    case "pending":
      return "Connecting";
    case "disabled":
      return "Turned off";
  }
}

export function McpConnectorsDialogHost() {
  const request = useMcpConnectorsRequest((state) => state.request);
  return request ? (
    <McpConnectorsDialog key={`${request.environmentId}:${request.threadId}`} request={request} />
  ) : null;
}

function McpConnectorsDialog({ request }: { readonly request: McpConnectorsRequest }) {
  const { environmentId, threadId } = request;
  const list = useAtomCommand(mcpConnectorsList, { reportFailure: false });
  const signIn = useAtomCommand(mcpConnectorsSignIn, { reportFailure: false });
  const cancelSignIn = useAtomCommand(mcpConnectorsCancelSignIn, { reportFailure: false });
  const reconnect = useAtomCommand(mcpConnectorsReconnect, { reportFailure: false });
  const canManage = useAtomValue(mcpConnectorsSignIn.permissionAtom(environmentId));
  const [connectors, setConnectors] = useState<TempoMcpConnectorsList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The server a sign in or retry from this dialog is working on. */
  const [working, setWorking] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ name: string; message: string } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the environment once, when the dialog opens
  useEffect(() => {
    let current = true;
    void list({ environmentId, input: { threadId } }).then((result) => {
      if (!current) return;
      if (result._tag === "Success") setConnectors(result.value);
      else setLoadError(failureMessage(result));
    });
    return () => {
      current = false;
    };
  }, [environmentId, threadId, list]);

  const run = async (
    name: string,
    action: (input: {
      readonly threadId: typeof threadId;
      readonly name: string;
    }) => Promise<AtomCommandResult<TempoMcpConnectorsList, unknown>>,
  ) => {
    setWorking(name);
    setRowError(null);
    const result = await action({ threadId, name });
    setWorking(null);
    if (result._tag === "Success") {
      setConnectors(result.value);
      return;
    }
    const message = failureMessage(result);
    if (message !== null) setRowError({ name, message });
  };

  const signingIn = working ?? connectors?.signingIn ?? null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeMcpConnectors();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connectors</DialogTitle>
          <DialogDescription>
            {threadId === null
              ? "The MCP servers Claude can use on this Mac."
              : "The MCP servers this thread's Claude can use."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {connectors === null ? (
            loadError === null ? (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            ) : (
              <p className="text-sm text-destructive-foreground">{loadError}</p>
            )
          ) : !connectors.live ? (
            <p className="text-sm text-muted-foreground">
              No Claude is running on this Mac right now. Send a message in a Claude thread, then
              type /mcp again.
            </p>
          ) : connectors.connectors.length === 0 ? (
            <p className="text-sm text-muted-foreground">This Claude has no MCP servers.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {connectors.connectors.map((connector) => {
                const isSigningIn = signingIn === connector.name;
                const error = rowError?.name === connector.name ? rowError.message : null;
                return (
                  <li key={connector.name} className="flex flex-col gap-1 py-2.5">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">
                          {connector.name}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {isSigningIn
                            ? "Finish signing in in your browser"
                            : statusText(connector)}
                        </div>
                      </div>
                      {isSigningIn ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void cancelSignIn({ environmentId, input: {} })}
                        >
                          Cancel
                        </Button>
                      ) : connector.status === "needs-auth" ? (
                        <Button
                          size="sm"
                          disabled={!canManage || signingIn !== null}
                          onClick={() =>
                            void run(connector.name, (input) => signIn({ environmentId, input }))
                          }
                        >
                          Sign in
                        </Button>
                      ) : connector.status === "failed" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canManage || working !== null}
                          onClick={() =>
                            void run(connector.name, (input) => reconnect({ environmentId, input }))
                          }
                        >
                          {working === connector.name ? "Retrying" : "Retry"}
                        </Button>
                      ) : null}
                    </div>
                    {error === null ? null : (
                      <p className="text-xs text-destructive-foreground">{error}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
