import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { createHistoryReach } from "./historyReach";

function setup() {
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const reach = createHistoryReach(history);
  const stop = reach.subscribe(() => {});
  return { history, reach, [Symbol.dispose]: stop };
}

describe("createHistoryReach", () => {
  it("leads nowhere on the first page", () => {
    using page = setup();
    expect(page.reach.getSnapshot()).toEqual({ back: false, forward: false });
  });

  it("goes back after a push and forward after going back", () => {
    using page = setup();
    page.history.push("/a");
    page.history.push("/b");
    expect(page.reach.getSnapshot()).toEqual({ back: true, forward: false });
    page.history.back();
    page.history.back();
    expect(page.reach.getSnapshot()).toEqual({ back: false, forward: true });
    page.history.forward();
    expect(page.reach.getSnapshot()).toEqual({ back: true, forward: true });
  });

  it("drops the entries ahead when a page is pushed after going back", () => {
    using page = setup();
    page.history.push("/a");
    page.history.push("/b");
    page.history.back();
    page.history.push("/c");
    expect(page.reach.getSnapshot()).toEqual({ back: true, forward: false });
  });

  it("keeps the entries ahead through a replace", () => {
    using page = setup();
    page.history.push("/a");
    page.history.back();
    page.history.replace("/b");
    expect(page.reach.getSnapshot()).toEqual({ back: false, forward: true });
  });
});
