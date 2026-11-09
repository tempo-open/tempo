import { describe, expect, it } from "vite-plus/test";

import {
  describePickedAnswer,
  parseRecommendedLabel,
  questionPrimaryActionLabel,
  splitQuestionText,
  truncateForButton,
} from "./questionPicker.ts";

describe("splitQuestionText", () => {
  it("makes the first sentence ending in a question mark the title", () => {
    expect(
      splitQuestionText("Delete ~/Code/old-project now? Frees about 7 GB. Everything is on Drive."),
    ).toEqual({
      title: "Delete ~/Code/old-project now?",
      context: "Frees about 7 GB. Everything is on Drive.",
      hasTitle: true,
    });
  });

  it("still makes a question with no background a title", () => {
    expect(splitQuestionText("Keep the bundle, or move it?")).toEqual({
      title: "Keep the bundle, or move it?",
      context: "",
      hasTitle: true,
    });
  });

  it("keeps background that comes before the question", () => {
    expect(splitQuestionText("Frees 7 GB. Delete it now? Backups exist.")).toEqual({
      title: "Delete it now?",
      context: "Frees 7 GB.\n\nBackups exist.",
      hasTitle: true,
    });
  });

  it("splits on a line break before the question", () => {
    expect(splitQuestionText("Some background\nWhich option should we pick?")).toEqual({
      title: "Which option should we pick?",
      context: "Some background",
      hasTitle: true,
    });
  });

  it("keeps a markdown list intact when it comes before the question", () => {
    expect(splitQuestionText("- one\n- two\n\nWhich option should we pick?")).toEqual({
      title: "Which option should we pick?",
      context: "- one\n- two",
      hasTitle: true,
    });
  });

  it("keeps a question that sits inside a list item in its list", () => {
    const numbered = "Two steps:\n1. Back up the folder.\n2. Which option should we pick?";
    expect(splitQuestionText(numbered)).toEqual({
      title: numbered,
      context: "",
      hasTitle: false,
    });
    expect(splitQuestionText("- Which option should we pick?\n- Or skip it").hasTitle).toBe(false);
  });

  it("still lifts a question from a list item that has text before it", () => {
    expect(splitQuestionText("1. Redis\n2. Back up first. Which option should we pick?")).toEqual({
      title: "Which option should we pick?",
      context: "1. Redis\n2. Back up first.",
      hasTitle: true,
    });
    expect(splitQuestionText("- Pick one: which option should we use?").title).toBe(
      "which option should we use?",
    );
  });

  it("still lifts a question that follows a list", () => {
    expect(splitQuestionText("1. Redis\n2. Postgres\n\nWhich store should we pick?")).toEqual({
      title: "Which store should we pick?",
      context: "1. Redis\n2. Postgres",
      hasTitle: true,
    });
  });

  it("keeps a code fence intact when it comes before the question", () => {
    const fence = "Before:\n```sh\nls -la\n```";
    expect(
      splitQuestionText(`${fence}\nWhich approach should we take? Trade-offs follow.`),
    ).toEqual({
      title: "Which approach should we take?",
      context: `${fence}\n\nTrade-offs follow.`,
      hasTitle: true,
    });
  });

  it("does not split after an abbreviation", () => {
    expect(splitQuestionText("Use a cache, e.g. Redis?")).toEqual({
      title: "Use a cache, e.g. Redis?",
      context: "",
      hasTitle: false,
    });
    expect(
      splitQuestionText("Pick one, i.e. a single option, for the whole rollout? Thanks.").hasTitle,
    ).toBe(false);
  });

  it("does not split on ?? or on a very short title", () => {
    expect(splitQuestionText("Use a ?? b or not?").hasTitle).toBe(false);
    expect(splitQuestionText("Background here. Why?").hasTitle).toBe(false);
  });

  it("returns the whole text when no sentence ends in a question mark", () => {
    expect(splitQuestionText("Pick a database")).toEqual({
      title: "Pick a database",
      context: "",
      hasTitle: false,
    });
  });

  it("ignores a question mark that is not at the end of a sentence", () => {
    expect(splitQuestionText("Open https://a.test/?x=1 and pick one")).toEqual({
      title: "Open https://a.test/?x=1 and pick one",
      context: "",
      hasTitle: false,
    });
  });

  it("ignores a question mark inside a code span", () => {
    expect(splitQuestionText("Run `a ? b` now").context).toBe("");
  });

  it("keeps a very long question whole", () => {
    const long = `${"word ".repeat(80)}?`;
    expect(splitQuestionText(long)).toEqual({ title: long, context: "", hasTitle: false });
  });
});

describe("parseRecommendedLabel", () => {
  it("strips a trailing (Recommended) and flags it", () => {
    expect(parseRecommendedLabel("Delete now (Recommended)")).toEqual({
      label: "Delete now",
      isRecommended: true,
    });
  });

  it("leaves a label without the suffix untouched", () => {
    expect(parseRecommendedLabel("Recommended reading")).toEqual({
      label: "Recommended reading",
      isRecommended: false,
    });
    expect(parseRecommendedLabel("Use (Recommended) mode")).toEqual({
      label: "Use (Recommended) mode",
      isRecommended: false,
    });
  });

  it("keeps a label that is only the suffix", () => {
    expect(parseRecommendedLabel("(Recommended)").isRecommended).toBe(false);
  });
});

describe("describePickedAnswer", () => {
  const options = [{ label: "Delete now (Recommended)", value: "now" }, { label: "Keep it" }];

  it("shows option labels without the suffix", () => {
    expect(describePickedAnswer(options, "now")).toBe("Delete now");
    expect(describePickedAnswer(options, ["now", "Keep it"])).toBe("Delete now, Keep it");
  });

  it("shows typed words as they are and nothing for no answer", () => {
    expect(describePickedAnswer(options, " my own ")).toBe("my own");
    expect(describePickedAnswer(options, null)).toBeNull();
  });
});

describe("questionPrimaryActionLabel", () => {
  it("names the answer for one question", () => {
    expect(
      questionPrimaryActionLabel({
        questionCount: 1,
        isLastQuestion: true,
        answerLabel: "Delete now",
      }),
    ).toBe('Answer "Delete now"');
  });

  it("counts answers on the last of several", () => {
    expect(
      questionPrimaryActionLabel({ questionCount: 2, isLastQuestion: true, answerLabel: "x" }),
    ).toBe("Send both answers");
    expect(
      questionPrimaryActionLabel({ questionCount: 4, isLastQuestion: true, answerLabel: "x" }),
    ).toBe("Send 4 answers");
  });

  it("defers to the existing wording otherwise", () => {
    expect(
      questionPrimaryActionLabel({ questionCount: 2, isLastQuestion: false, answerLabel: "x" }),
    ).toBeNull();
    expect(
      questionPrimaryActionLabel({ questionCount: 1, isLastQuestion: true, answerLabel: null }),
    ).toBeNull();
  });

  it("shortens a long answer", () => {
    expect(truncateForButton("a".repeat(40))).toHaveLength(28);
  });
});

describe("truncateForButton", () => {
  it("never cuts an emoji in half", () => {
    expect(truncateForButton(`${"a".repeat(26)}😀 more`)).toBe(`${"a".repeat(26)}…`);
  });
});
