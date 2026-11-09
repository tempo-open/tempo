import "~/index.css";

import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ThreadIcon } from "./ThreadLogo";

const TITLES = [
  "Fix the checkout button",
  "Stripe webhook retries",
  "Weekly report",
  "Fix this",
  "zero value bug",
  "42 failing tests",
  "Rename 42 files",
  "...",
  "Package the release",
];

/** Rows that got the title model's fallback icon instead of a logo. */
const ICONS: Record<string, string> = {
  "Package the release": "icon:📦",
};

describe("ThreadIcon", () => {
  it("draws a letter on a tile the size of a logo, so titles stay lined up", async () => {
    await render(
      <div data-testid="rows" className="flex w-72 flex-col gap-1 p-2">
        {TITLES.map((title) => (
          <div key={title} data-testid="row" className="flex items-center gap-2.5 text-sm">
            <ThreadIcon title={title} logo={ICONS[title]} />
            <span data-testid="title">{title}</span>
          </div>
        ))}
      </div>,
    );
    await expect.element(page.getByText("Fix this")).toBeVisible();

    const titles = [...document.querySelectorAll<HTMLElement>('[data-testid="title"]')];
    const lefts = new Set(titles.map((title) => title.getBoundingClientRect().left));
    expect(lefts.size).toBe(1);
    for (const row of document.querySelectorAll('[data-testid="row"]')) {
      const { width, height } = row.firstElementChild!.getBoundingClientRect();
      expect([width, height]).toEqual([16, 16]);
    }
    const tile = page.getByText("Fix this").element().previousElementSibling!;
    expect(tile.textContent).toBe("F");
  });
});
