import {
  EnvironmentId,
  LaptopToolServerId,
  RunId,
  ThreadId,
  type DesktopLaptopToolsState,
  type LaptopToolsHostRegistration,
} from "@t3tools/contracts";
import * as Atom from "effect/reactivity/Atom";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  state: null as DesktopLaptopToolsState | null,
  environments: [] as ReadonlyArray<unknown>,
  connect: vi.fn(),
  registerRelay: vi.fn(),
}));
vi.mock(import("./laptopToolsState"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    laptopToolsBridge: {} as never,
    useLaptopToolsState: () => mocks.state,
    registerLaptopToolsRelay: mocks.registerRelay,
    laptopToolsEnvironment: { ...original.laptopToolsEnvironment, connect: mocks.connect as never },
  };
});
vi.mock(import("~/state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironments: (() => ({ environments: mocks.environments })) as never,
}));
vi.mock(import("~/state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadShell: () => null,
}));

import { render } from "../../../test/render";
import { LaptopToolsCoordinator } from "./LaptopToolsCoordinator";

const environmentId = EnvironmentId.make("remote");

function setup() {
  mocks.connect.mockReset().mockImplementation(() => Atom.make(0));
  mocks.registerRelay.mockReset().mockReturnValue(() => undefined);
}

const PASSKEYS_OFF: NonNullable<DesktopLaptopToolsState["passkeys"]> = {
  status: "off",
  pending: [],
};

/** A fresh snapshot each call, as the desktop sends one over IPC on every tool call. */
function push({ browserEnabled = false, inFlight = 0, passkeys = PASSKEYS_OFF } = {}) {
  mocks.state = {
    hostLabel: "Alex's MacBook",
    config: { servers: [], laptopBrowserUsesRealProfile: false },
    servers: [
      {
        id: LaptopToolServerId.make("laptop-browser"),
        name: "Laptop browser",
        enabled: browserEnabled,
        builtIn: true,
        resolvedCommand: "/usr/local/bin/laptop-browser",
        running: false,
        toolCount: null,
      },
    ],
    grants: [
      {
        key: "grant",
        environmentId,
        environmentLabel: "Mac mini",
        threadId: ThreadId.make("thread"),
        threadTitle: "Thread",
        serverId: LaptopToolServerId.make("laptop-browser"),
        serverName: "Laptop browser",
        runId: RunId.make("run"),
        grantedAt: 0,
        lastUsedAt: 0,
        inFlight,
      },
    ],
    passkeys,
  };
  mocks.environments = [
    {
      environmentId,
      label: "Mac mini",
      connection: { phase: "connected" },
      serverConfig: { environment: { capabilities: { tempoLaptopTools: true } } },
    },
  ];
}

const offeredServers = () =>
  mocks.connect.mock.calls.map(
    ([{ input }]) => (input.registration as LaptopToolsHostRegistration).servers,
  );

it("registers once per mount and again only when what it offers changes", async () => {
  setup();
  push();
  await using screen = await render(<LaptopToolsCoordinator />);
  expect(mocks.registerRelay).toHaveBeenCalledTimes(1);

  // A call starting and ending sends new snapshots with nothing new to offer.
  push({ inFlight: 1 });
  await screen.rerender(<LaptopToolsCoordinator />);
  push({ inFlight: 0 });
  await screen.rerender(<LaptopToolsCoordinator />);
  expect(mocks.registerRelay).toHaveBeenCalledTimes(1);
  expect(offeredServers()).toEqual([[]]);

  // Renaming re-renders the connection, whose other dependencies must hold still.
  push();
  mocks.environments = [{ ...(mocks.environments[0] as object), label: "Renamed" }];
  await screen.rerender(<LaptopToolsCoordinator />);
  expect(mocks.registerRelay).toHaveBeenCalledTimes(1);

  push({ browserEnabled: true });
  await screen.rerender(<LaptopToolsCoordinator />);
  push({ browserEnabled: true, inFlight: 1 });
  await screen.rerender(<LaptopToolsCoordinator />);
  expect(mocks.registerRelay).toHaveBeenCalledTimes(2);
  expect(offeredServers()).toEqual([[], [{ id: "laptop-browser", name: "Laptop browser" }]]);
});

const acceptsPasskeys = () =>
  mocks.connect.mock.calls.map(([{ input }]) =>
    (input.registration as LaptopToolsHostRegistration).accepts.includes("passkey"),
  );

it("registers again only when passkeys start or stop being accepted", async () => {
  setup();
  push();
  await using screen = await render(<LaptopToolsCoordinator />);

  push({ passkeys: { status: "available", pending: [] } });
  await screen.rerender(<LaptopToolsCoordinator />);
  // A sheet waiting on this Mac, or a status that still accepts passkeys, offers nothing new.
  push({
    passkeys: {
      status: "available",
      pending: [
        {
          key: "sheet",
          environmentLabel: "Mac mini",
          threadTitle: "Thread",
          rpId: "example.com",
          ceremony: "get",
          requester: "agent",
        },
      ],
    },
  });
  await screen.rerender(<LaptopToolsCoordinator />);
  push({ passkeys: { status: "awaiting-entitlement", pending: [] } });
  await screen.rerender(<LaptopToolsCoordinator />);
  expect(acceptsPasskeys()).toEqual([false, true]);

  push({ passkeys: { status: "not-mac", pending: [] } });
  await screen.rerender(<LaptopToolsCoordinator />);
  expect(acceptsPasskeys()).toEqual([false, true, false]);
});
