import { describe, expect, it } from "vite-plus/test";

import {
  blockIndexForLine,
  documentTitleFromPath,
  splitMarkdownDocument,
} from "./quickLookDocument.logic";

describe("splitMarkdownDocument", () => {
  it("takes a leading level one heading as the title and keeps every line in place", () => {
    const markdown = "\n# Release notes: `acme-app` v2 #\n\nFirst paragraph.\n# Later heading\n";
    const parts = splitMarkdownDocument(markdown);
    expect(parts.title).toBe("Release notes: `acme-app` v2");
    expect(parts.body.split("\n")).toHaveLength(markdown.split("\n").length);
    expect(parts.body).not.toContain("Release notes");
    expect(parts.body).toContain("# Later heading");
  });

  it("leaves a document that opens with anything else untitled", () => {
    expect(splitMarkdownDocument("Intro\n# Heading").title).toBeNull();
    expect(splitMarkdownDocument("## Section\ntext").title).toBeNull();
    expect(splitMarkdownDocument("    # indented code").title).toBeNull();
  });

  it("reads scalar frontmatter as properties and blanks the block", () => {
    const markdown = [
      "---",
      "name: release-checklist",
      'description: "Step 2, \\"Beta\\" build"',
      "metadata:",
      "  type: project",
      "tags: [a, b]",
      "summary: |",
      "  long text",
      "---",
      "# Release checklist",
      "Body",
    ].join("\n");
    const parts = splitMarkdownDocument(markdown);
    expect(parts.properties).toEqual([
      { key: "name", value: "release-checklist" },
      { key: "description", value: 'Step 2, "Beta" build' },
    ]);
    expect(parts.title).toBe("Release checklist");
    expect(parts.body.split("\n")).toHaveLength(11);
    expect(parts.body.trim()).toBe("Body");
  });
});

describe("documentTitleFromPath", () => {
  it("drops the folder and the markdown extension", () => {
    expect(documentTitleFromPath("/Users/ada/notes/2025-03-14-release-notes.md")).toBe(
      "2025-03-14-release-notes",
    );
    expect(documentTitleFromPath("docs/README.markdown")).toBe("README");
  });
});

describe("blockIndexForLine", () => {
  it("lands on the block that contains the line", () => {
    const starts = [1, 4, 9, 12];
    expect(blockIndexForLine(starts, 1)).toBe(0);
    expect(blockIndexForLine(starts, 10)).toBe(2);
    expect(blockIndexForLine(starts, 40)).toBe(3);
    expect(blockIndexForLine([5], 2)).toBe(-1);
  });
});
