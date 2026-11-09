// Pure text helpers for the question picker (Tempo's multiple-choice question card).

export interface SplitQuestionText {
  /** The first sentence that ends in "?", or the whole text when there is none. */
  readonly title: string;
  /** Everything else, in order; empty when the title is the whole text. */
  readonly context: string;
  /** False when no sentence ends in "?", so the caller shows the text as it always did. */
  readonly hasTitle: boolean;
}

const MAX_TITLE_LENGTH = 240;
const MIN_TITLE_LENGTH = 12;
// A sentence "boundary" after one of these is not a boundary.
const ABBREVIATION_BEFORE = /\b(?:e\.g|i\.e|etc|vs|cf|approx|incl)\.\s*$/i;
const LIST_ITEM_START = /^\s*(?:\d+[.)]|[-*+])\s/;

function isInsideCodeSpan(text: string, index: number): boolean {
  let ticks = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === "`") ticks += 1;
  }
  return ticks % 2 === 1;
}

/** Splits a question into a bold title and the background text. No "?" sentence keeps it whole. */
export function splitQuestionText(text: string): SplitQuestionText {
  const whole: SplitQuestionText = { title: text, context: "", hasTitle: false };
  // "a ?? b" is an operator, not a sentence end.
  if (text.includes("??")) return whole;
  let questionMark = text.indexOf("?");
  while (questionMark !== -1) {
    const next = text[questionMark + 1];
    if ((next === undefined || /\s/.test(next)) && !isInsideCodeSpan(text, questionMark)) break;
    questionMark = text.indexOf("?", questionMark + 1);
  }
  if (questionMark === -1) return whole;

  const head = text.slice(0, questionMark);
  const boundaries = [...head.matchAll(/[.!?:]\s+|\n+/g)];
  const lastBoundary = boundaries.at(-1);
  const start = lastBoundary === undefined ? 0 : lastBoundary.index + lastBoundary[0].length;
  // Lifting a whole list item's text would leave an empty "2." behind.
  const lineStart = head.lastIndexOf("\n") + 1;
  const listMarker = LIST_ITEM_START.exec(head.slice(lineStart));
  if (listMarker !== null && start <= lineStart + listMarker[0].length) return whole;
  const title = text.slice(start, questionMark + 1).trim();
  if (title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) return whole;
  if (ABBREVIATION_BEFORE.test(text.slice(0, start))) return whole;

  // Blank-line joins keep markdown lists and code fences intact.
  const context = [text.slice(0, start), text.slice(questionMark + 1)]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
  return { title, context, hasTitle: true };
}

export interface ParsedOptionLabel {
  readonly label: string;
  readonly isRecommended: boolean;
}

const RECOMMENDED_SUFFIX = /\s*\(Recommended\)\s*$/i;

/** Strips a trailing "(Recommended)" and reports it. A label without the suffix is untouched. */
export function parseRecommendedLabel(label: string): ParsedOptionLabel {
  const match = RECOMMENDED_SUFFIX.exec(label);
  if (match === null) return { label, isRecommended: false };
  const stripped = label.slice(0, match.index).trim();
  if (stripped.length === 0) return { label, isRecommended: false };
  return { label: stripped, isRecommended: true };
}

interface AnswerableOption {
  readonly label: string;
  readonly value?: string | undefined;
}

/** The text a person would recognise for a stored answer: option labels, or their own words. */
export function describePickedAnswer(
  options: ReadonlyArray<AnswerableOption>,
  answer: string | ReadonlyArray<string> | null,
): string | null {
  if (answer === null) return null;
  const values = typeof answer === "string" ? [answer] : answer;
  const names = values
    .map((value) => {
      const option = options.find((candidate) => (candidate.value ?? candidate.label) === value);
      return option === undefined ? value.trim() : parseRecommendedLabel(option.label).label;
    })
    .filter((name) => name.length > 0);
  return names.length > 0 ? names.join(", ") : null;
}

export function truncateForButton(text: string, maxLength = 28): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= maxLength) return single;
  // Step back one unit so an emoji's surrogate pair stays whole.
  const lastCode = single.charCodeAt(maxLength - 2);
  const end = lastCode >= 0xd800 && lastCode <= 0xdbff ? maxLength - 2 : maxLength - 1;
  return `${single.slice(0, end).trimEnd()}…`;
}

/** What the composer's primary button says it will do, or null to keep the existing wording. */
export function questionPrimaryActionLabel(input: {
  readonly questionCount: number;
  readonly isLastQuestion: boolean;
  readonly answerLabel: string | null;
}): string | null {
  if (!input.isLastQuestion) return null;
  if (input.questionCount === 1) {
    return input.answerLabel === null ? null : `Answer "${truncateForButton(input.answerLabel)}"`;
  }
  return input.questionCount === 2 ? "Send both answers" : `Send ${input.questionCount} answers`;
}
