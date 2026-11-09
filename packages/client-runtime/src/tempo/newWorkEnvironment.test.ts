import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  newWorkEnvironmentFirstIds,
  newWorkEnvironmentOptions,
  orderNewWorkEnvironmentFirst,
  pickNewWorkProject,
  resolveAnchorEnvironmentId,
  resolveNewWorkEnvironmentId,
} from "./newWorkEnvironment.ts";

const laptop = EnvironmentId.make("laptop");
const mini = EnvironmentId.make("mini");
const vm = EnvironmentId.make("vm");

const environments = [
  { environmentId: mini, label: "Mac mini", enabled: true },
  { environmentId: laptop, label: "This Mac", enabled: true },
  { environmentId: vm, label: "Linux VM", enabled: false },
];

describe("newWorkEnvironmentOptions", () => {
  it("offers the local environment first, then saved ones that are switched on", () => {
    expect(
      newWorkEnvironmentOptions({ primaryEnvironmentId: laptop, environments }).map((option) => [
        option.environmentId,
        option.isPrimary,
      ]),
    ).toEqual([
      [laptop, true],
      [mini, false],
    ]);
  });

  it("offers only saved environments when this device runs no server", () => {
    expect(
      newWorkEnvironmentOptions({ primaryEnvironmentId: null, environments }).map(
        (option) => option.environmentId,
      ),
    ).toEqual([mini, laptop]);
  });

  it("offers T3 Connect machines before other saved environments", () => {
    const studio = EnvironmentId.make("studio");
    expect(
      newWorkEnvironmentOptions({
        primaryEnvironmentId: laptop,
        environments: [
          ...environments,
          { environmentId: studio, label: "Studio", enabled: true, relayManaged: true },
        ],
      }).map((option) => option.environmentId),
    ).toEqual([laptop, studio, mini]);
  });
});

describe("resolveNewWorkEnvironmentId", () => {
  const withLocal = newWorkEnvironmentOptions({ primaryEnvironmentId: laptop, environments });
  const withoutLocal = newWorkEnvironmentOptions({
    primaryEnvironmentId: null,
    environments: environments.filter((environment) => environment.environmentId !== laptop),
  });

  it("keeps the device's choice while it is offered", () => {
    expect(resolveNewWorkEnvironmentId({ choice: mini, options: withLocal })).toBe(mini);
  });

  it("defaults to the local environment when it runs", () => {
    expect(resolveNewWorkEnvironmentId({ choice: null, options: withLocal })).toBe(laptop);
  });

  it("defaults to the first saved environment when the local one is off", () => {
    expect(resolveNewWorkEnvironmentId({ choice: null, options: withoutLocal })).toBe(mini);
  });

  it("falls back when the chosen environment was removed or switched off", () => {
    expect(resolveNewWorkEnvironmentId({ choice: vm, options: withLocal })).toBe(laptop);
    expect(resolveNewWorkEnvironmentId({ choice: laptop, options: withoutLocal })).toBe(mini);
  });

  it("has nowhere to run without any environment", () => {
    expect(resolveNewWorkEnvironmentId({ choice: mini, options: [] })).toBeNull();
  });
});

describe("resolveAnchorEnvironmentId", () => {
  // Saved in this order: the VM first, so "the first saved one" would be wrong twice.
  const saved = [
    { environmentId: vm, enabled: true },
    { environmentId: mini, enabled: true },
  ];

  it("follows the client's own environment when it has one", () => {
    expect(
      resolveAnchorEnvironmentId({
        primaryEnvironmentId: laptop,
        choice: mini,
        savedEnvironments: saved,
      }),
    ).toBe(laptop);
  });

  it("follows Run new work on when the client runs no server, not the first saved environment", () => {
    expect(
      resolveAnchorEnvironmentId({
        primaryEnvironmentId: null,
        choice: mini,
        savedEnvironments: saved,
      }),
    ).toBe(mini);
  });

  it("falls back to the first saved environment that is on", () => {
    expect(
      resolveAnchorEnvironmentId({
        primaryEnvironmentId: null,
        choice: null,
        savedEnvironments: saved,
      }),
    ).toBe(vm);
    expect(
      resolveAnchorEnvironmentId({
        primaryEnvironmentId: null,
        choice: mini,
        savedEnvironments: [
          { environmentId: vm, enabled: true },
          { environmentId: mini, enabled: false },
        ],
      }),
    ).toBe(vm);
    expect(
      resolveAnchorEnvironmentId({
        primaryEnvironmentId: null,
        choice: mini,
        savedEnvironments: [],
      }),
    ).toBeNull();
  });
});

describe("pickNewWorkProject", () => {
  const projects = [
    { id: "a", environmentId: laptop },
    { id: "b", environmentId: mini },
    { id: "c", environmentId: mini },
  ];

  it("starts in the first project on the new-work environment", () => {
    expect(pickNewWorkProject(projects, mini)?.id).toBe("b");
  });

  it("uses the first project anywhere when that environment has none", () => {
    expect(pickNewWorkProject(projects, vm)?.id).toBe("a");
    expect(pickNewWorkProject([], mini)).toBeNull();
  });
});

describe("orderNewWorkEnvironmentFirst", () => {
  it("moves the new-work environment's items first and keeps each side's order", () => {
    const items = [
      { id: 1, environmentId: laptop },
      { id: 2, environmentId: mini },
      { id: 3, environmentId: laptop },
      { id: 4, environmentId: mini },
    ];
    expect(orderNewWorkEnvironmentFirst(items, mini).map((item) => item.id)).toEqual([2, 4, 1, 3]);
    expect(orderNewWorkEnvironmentFirst(items, null)).toBe(items);
  });
});

describe("newWorkEnvironmentFirstIds", () => {
  it("puts the new-work environment ahead of the caller's order, once", () => {
    expect(newWorkEnvironmentFirstIds(mini, [laptop, mini, vm])).toEqual([mini, laptop, vm]);
    expect(newWorkEnvironmentFirstIds(mini, [laptop])).toEqual([mini, laptop]);
    expect(newWorkEnvironmentFirstIds(null, [laptop, vm])).toEqual([laptop, vm]);
  });
});
