import { EnvironmentId, ScheduledTaskId, ThreadId, type ScheduledTask } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ toggle: vi.fn(), run: vi.fn() }));
vi.mock(import("../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
// The panel reads the run permission through an atom.
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => true) as never,
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
}));
vi.mock(import("../state/use-atom-command"), async (importOriginal) => {
  const { serverEnvironment } = await import("../state/server");
  return {
    ...(await importOriginal()),
    useAtomCommand: ((command: unknown) =>
      command === serverEnvironment.setScheduledTaskEnabled ? state.toggle : state.run) as never,
  };
});
vi.mock(import("../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({ data: { tasks: [watcher] }, error: null })) as never,
}));

import { act, render } from "../../test/render";
import { ThreadAutomationsPanel } from "../components/chat/ThreadAutomationsPanel";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("thread");
const watcher = {
  id: ScheduledTaskId.make("watcher"),
  threadId,
  title: "API recovers",
  enabled: true,
  schedule: { type: "interval", everyMs: 300_000 },
  nextRunAt: null,
  lastRunStatus: "succeeded",
  watcher: {
    command: "curl -fsS https://api.example.com/health",
    wakeWhen: "succeeds",
    expiresAt: "2099-01-01T00:00:00.000Z",
    lastCheck: {
      checkedAt: "2026-01-01T00:00:00.000Z",
      exitCode: 22,
      timedOut: false,
      output: "curl: (22) The requested URL returned error: 429",
    },
  },
} as ScheduledTask;

it("shows what a watcher waits for and its last check, and checks it on demand", async () => {
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });
  await using screen = await render(
    <ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />,
  );
  expect(screen.container.textContent).toMatch(
    /Watching until it succeeds · checked .+ ago, exit 22/,
  );
  const checkNow = screen.container.querySelector<HTMLElement>(
    '[aria-label="Check API recovers now"]',
  );
  expect(checkNow).not.toBeNull();
  await act(async () => checkNow?.click());
  expect(state.run).toHaveBeenCalledWith({
    environmentId,
    input: { id: watcher.id },
  });
});
