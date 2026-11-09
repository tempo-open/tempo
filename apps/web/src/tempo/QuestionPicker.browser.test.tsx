import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import { derivePendingUserInputProgress } from "../pendingUserInput";

vi.mock(import("../components/ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { withLook } from "../../test/look";
import { act, fakeTimers, render } from "../../test/render";
import { ComposerPendingUserInputPanel } from "../components/chat/ComposerPendingUserInputPanel";
import { ComposerPrimaryActions } from "../components/chat/ComposerPrimaryActions";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const questions = [
  {
    id: "dir",
    header: "Delete dir",
    question: "Delete the folder now? It frees 7 GB.",
    options: [
      { label: "Delete now (Recommended)", description: "Deletes it." },
      { label: "Keep it", description: "Leaves it." },
    ],
    multiSelect: false,
  },
  {
    id: "archive",
    header: "Archive",
    question: "Keep the bundle on this Mac, or move it to Drive?",
    options: [
      { label: "Move to Drive", description: "Frees 3 GB." },
      { label: "Keep here", description: "Stays put." },
    ],
    multiSelect: false,
  },
];

function makePrompt(overrides: Partial<(typeof questions)[number]> = {}, count = 2) {
  return {
    requestId: RuntimeRequestId.make("picker"),
    createdAt: "2026-10-20T00:00:00.000Z",
    dismissible: false,
    responseCapability: "live" as const,
    questions: questions.slice(0, count).map((question) => ({ ...question, ...overrides })),
  };
}

function Picker(props: {
  prompt: ReturnType<typeof makePrompt>;
  onSent?: (answers: unknown) => void;
  onToggle?: (questionId: string, value: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const progress = derivePendingUserInputProgress(props.prompt.questions, answers, questionIndex);
  const advance = () => {
    if (progress.isLastQuestion) {
      props.onSent?.(buildPendingUserInputAnswers(props.prompt.questions, answers));
      return;
    }
    setQuestionIndex(progress.questionIndex + 1);
  };
  return (
    <>
      <input aria-label="typing" />
      <textarea aria-label="area" />
      <div contentEditable suppressContentEditableWarning aria-label="editable" tabIndex={0} />
      <ComposerPendingUserInputPanel
        pendingUserInputs={[props.prompt]}
        cwd="/repo"
        threadRef={threadRef}
        disabled={false}
        respondingRequestIds={[]}
        answers={answers}
        questionIndex={questionIndex}
        onAdvance={advance}
        onGoToQuestion={setQuestionIndex}
        onToggleOption={(questionId, value) => {
          props.onToggle?.(questionId, value);
          const question = props.prompt.questions.find((entry) => entry.id === questionId)!;
          setAnswers((existing) => ({
            ...existing,
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[questionId],
              value,
            ),
          }));
        }}
        onDismiss={() => {}}
      />
    </>
  );
}

async function press(target: Element, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(() => target.dispatchEvent(event));
  return event;
}

function options() {
  return [...document.querySelectorAll<HTMLElement>('[role="radio"]')];
}

it("keeps digits and arrows quiet while typing in an input, a textarea or a contenteditable", async () => {
  using _timers = fakeTimers();
  const onToggle = vi.fn();
  await using screen = await render(<Picker prompt={makePrompt()} onToggle={onToggle} />);
  for (const label of ["typing", "area", "editable"]) {
    const field = screen.container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
    field.focus();
    expect((await press(field, "1")).defaultPrevented).toBe(false);
    expect((await press(field, "ArrowDown")).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(field);
  }
  await act(async () => vi.runAllTimers());
  expect(onToggle).not.toHaveBeenCalled();
});

it("moves focus with arrows from an option, but leaves arrows alone on the page body", async () => {
  using _timers = fakeTimers();
  await using _screen = await render(<Picker prompt={makePrompt()} />);
  expect((await press(document.body, "ArrowDown")).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(document.body);

  const [first, second] = options();
  first!.focus();
  expect((await press(first!, "ArrowDown")).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(second);
  await press(second!, "ArrowUp");
  expect(document.activeElement).toBe(first);
});

it.each([
  { look: "classic", offer: "Something else" },
  { look: "tempo", offer: "or type something else" },
] as const)(
  "hides Something else when custom answers are not allowed in the $look look",
  async ({ look, offer }) => {
    using _look = withLook(look);
    using _timers = fakeTimers();
    await using screen = await render(
      <Picker prompt={makePrompt({ allowCustomAnswer: false } as never)} />,
    );
    expect(screen.container.textContent).not.toContain(offer);
    await screen.rerender(<Picker prompt={makePrompt({ allowCustomAnswer: true } as never)} />);
    expect(screen.container.textContent).toContain(offer);
  },
);

const shortcutHints = [
  { look: "classic", hint: "1–2 to pick", anyHint: "to pick" },
  { look: "tempo", hint: "Press 1 to 2", anyHint: "Press 1" },
] as const;

it.each(shortcutHints)(
  "shows the shortcut hint only when there are options in the $look look",
  async ({ look, hint, anyHint }) => {
    using _look = withLook(look);
    using _timers = fakeTimers();
    await using screen = await render(<Picker prompt={makePrompt()} />);
    expect(screen.container.textContent).toContain(hint);
    await screen.rerender(<Picker prompt={makePrompt({ options: [] } as never)} />);
    expect(screen.container.textContent).not.toContain(anyHint);
  },
);

it.each(shortcutHints)(
  "hides the shortcut hint when the question can no longer be answered in the $look look",
  async ({ look, anyHint }) => {
    using _look = withLook(look);
    using _timers = fakeTimers();
    const prompt = { ...makePrompt(), responseCapability: "not_resumable" as never };
    await using screen = await render(<Picker prompt={prompt} />);
    expect(screen.container.textContent).not.toContain(anyHint);
  },
);

it("replaces the earlier answer when you go back by tab and change it", async () => {
  using _timers = fakeTimers();
  const onSent = vi.fn();
  await using screen = await render(<Picker prompt={makePrompt()} onSent={onSent} />);
  await act(async () => options()[0]!.click());
  await act(async () => vi.advanceTimersByTime(200));
  const tabs = () => [...screen.container.querySelectorAll<HTMLElement>('[role="tab"]')];
  expect(tabs()[0]!.textContent).toBe("Delete dir: Delete now");

  await act(async () => tabs()[0]!.click());
  await act(async () => options()[1]!.click());
  await act(async () => vi.advanceTimersByTime(200));
  expect(tabs()[0]!.textContent).toBe("Delete dir: Keep it");

  await act(async () => options()[0]!.click());
  await act(async () => vi.advanceTimersByTime(200));
  expect(onSent).toHaveBeenCalledTimes(1);
  expect(onSent).toHaveBeenCalledWith({ dir: "Keep it", archive: "Move to Drive" });
});

const pendingAction = {
  questionIndex: 0,
  isLastQuestion: true,
  canAdvance: true,
  isResponding: false,
  isComplete: true,
  primaryLabel: 'Answer "Delete now"',
};

function actions(compact: boolean) {
  return (
    <ComposerPrimaryActions
      compact={compact}
      canOperateThread
      pendingAction={pendingAction}
      isRunning={false}
      canInterrupt={false}
      showPlanFollowUpPrompt={false}
      promptHasText={false}
      isSendBusy={false}
      sendDisabledReason={null}
      isEnvironmentUnavailable={false}
      isPreparingWorktree={false}
      hasSendableContent={false}
      onPreviousPendingQuestion={() => {}}
      onInterrupt={() => {}}
      onImplementPlanInNewThread={() => {}}
    />
  );
}

it.each([
  { look: "classic", compactLabel: "Submit" },
  { look: "tempo", compactLabel: 'Answer "Delete now"' },
] as const)(
  "says what it sends on a wide composer, and on a compact one in the $look look",
  async ({ look, compactLabel }) => {
    using _look = withLook(look);
    using _timers = fakeTimers();
    await using screen = await render(actions(false));
    const submit = () => screen.container.querySelector("button[type=submit]")!.textContent;
    expect(submit()).toBe('Answer "Delete now"');
    await screen.rerender(actions(true));
    expect(submit()).toBe(compactLabel);
  },
);
