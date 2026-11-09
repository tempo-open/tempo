import { describe, expect, it } from "vite-plus/test";

import { cn } from "./utils";

describe("cn", () => {
  it("keeps a background color next to a composer seam background image", () => {
    expect(cn("dark:before:bg-transparent dark:before:bg-composer-seam-below")).toBe(
      "dark:before:bg-transparent dark:before:bg-composer-seam-below",
    );
  });

  it("keeps a tempo look font size next to a text color", () => {
    expect(cn("tempo:text-tempo-note", "tempo:text-secondary-label")).toBe(
      "tempo:text-tempo-note tempo:text-secondary-label",
    );
  });
});
