import { describe, expect, it } from "vite-plus/test";

import {
  documentPreview,
  pageLinksAlone,
  replyDeliverables,
  replyMarkdownFiles,
  replyPages,
  replyPageUrls,
} from "./replyDeliverables.logic";

const page = (url: string, title: string) => ({
  url,
  title,
  about: null,
  picture: null,
  emoji: null,
  sharedAt: "2025-01-15T10:00:00.000Z",
});

describe("replyDeliverables", () => {
  it("lists the reply's pages the thread holds and no paragraph draws, then its markdown files, each once", () => {
    const text = [
      "The board is up: http://127.0.0.1:5173/board.html and the review at https://style-guide-a1b2c3d4.pages.dev.",
      "Read [Todo list.md](/Users/x/docs/todo.md), [it again](/Users/x/docs/todo.md), [docs/notes.md](docs/notes.md#top) and [main](src/main.ts).",
      "Code stays out: `[x](README.md)`, `https://example.pages.dev/p/hidden`.",
      "```md",
      "See [the guide](docs/guide.md)",
      "```",
      "Not a page: https://github.com/acme/app/pull/8",
      "",
      "[The onboarding steps](https://example.pages.dev/p/onboarding-steps-p7c2xw9dkq4m)",
    ].join("\n");
    const files = replyMarkdownFiles(text, "/Users/x/project");
    expect(files).toEqual([
      { path: "/Users/x/docs/todo.md", name: "Todo list.md" },
      { path: "docs/notes.md", name: "notes.md" },
    ]);
    const pages = [
      page("https://style-guide-a1b2c3d4.pages.dev/", "Style guide"),
      page("https://example.pages.dev/p/hidden", "Hidden"),
      page("https://example.pages.dev/p/onboarding-steps-p7c2xw9dkq4m", "The onboarding steps"),
    ];
    const deliverables = [
      { kind: "page", page: pages[0] },
      { kind: "file", file: files[0] },
      { kind: "file", file: files[1] },
    ];
    const alone = pageLinksAlone(text, false);
    expect(replyDeliverables(replyPageUrls(text), replyPages(pages, alone), files)).toEqual(
      deliverables,
    );
    expect(replyDeliverables(replyPageUrls(text), replyPages(pages, new Map()), files)).toEqual([
      { kind: "page", page: pages[2] },
      ...deliverables,
    ]);
  });
});

describe("pageLinksAlone", () => {
  const guide = "https://example.pages.dev/p/install-guide-q8n4vz2hj6wd";

  it("finds a page link that is a paragraph of its own, at the paragraph's start", () => {
    const text = [
      "### New page: the guide",
      `[Guide: install steps](${guide}/)`,
      "",
      `<${guide}#top>`,
      "",
      "$$",
      "",
      `[Guide: install steps](${guide})`,
      "",
      "$$",
      "",
      `${guide}\r`,
    ].join("\n");
    const lineStart = (line: number) => text.split("\n").slice(0, line).join("\n").length + 1;
    const [named, autolink, inMath, address] = [1, 3, 7, 11].map(lineStart);
    expect(pageLinksAlone(text, false)).toEqual(
      new Map([
        [named, guide],
        [autolink, guide],
        [inMath, guide],
        [address, guide],
      ]),
    );
    expect(pageLinksAlone(text, true)).toEqual(
      new Map([
        [named, guide],
        [autolink, guide],
        [address, guide],
      ]),
    );
  });

  it.each([
    ["in a sentence", `See [the guide page](${guide}).`],
    ["with punctuation after it", `${guide}.`],
    ["in a list", `- [Guide: install steps](${guide})`],
    ["in a quote", `> [Guide: install steps](${guide})`],
    ["in bold", `**[Guide: install steps](${guide})**`],
    ["indented", `    [Guide: install steps](${guide})`],
    ["in code", `\`\`\`\n\n[Guide: install steps](${guide})\n\n\`\`\``],
    ["joined to the line before", `Two notes follow:\n[Guide: install steps](${guide})`],
    ["joined to the line after", `[Guide: install steps](${guide})\nopen it in a browser`],
    ["over a heading's underline", `[Guide: install steps](${guide})\n---`],
    ["to a site that is not a page", "[acme/app](https://github.com/acme/app)"],
    ["around an image", `[![The guide](${guide}/og.png)](${guide})`],
    ["in a comment", `<!--\n\n[Guide: install steps](${guide})\n\n-->`],
    ["in a pre block", `<pre>\n\n[Guide: install steps](${guide})\n\n</pre>`],
    ["in a script", `<script>\n\n${guide}\n\n</script>`],
    [
      "in a longer fence",
      `\`\`\`\`md\n\`\`\`\n\n[Guide: install steps](${guide})\n\n\`\`\`\n\`\`\`\``,
    ],
    ["in math", `$$\n\n[Guide: install steps](${guide})\n\n$$`, true],
  ])("leaves a link %s in its line", (_, text, math = false) => {
    expect(pageLinksAlone(text, math)).toEqual(new Map());
  });
});

describe("documentPreview", () => {
  it.each([
    [
      "---\nstatus: draft\n---\n# The **redesign** plan\n\nEvery item [kept](x.md), `12` of them.\n",
      { title: "The redesign plan", lead: "Every item kept, 12 of them." },
    ],
    [
      "## Todo list\n\n### Shell and sidebar\n- [ ] Sidebar resize\n",
      { title: "todo", lead: "Todo list" },
    ],
    [
      "# Notes\n\n```sh\nvp run dev\n```\n\n| a | b |\n\n- First point\n",
      { title: "Notes", lead: "First point" },
    ],
    ["", { title: "todo", lead: null }],
  ])("reads %j", (markdown, preview) => {
    expect(documentPreview(markdown, "/Users/x/docs/todo.md")).toEqual(preview);
  });
});
