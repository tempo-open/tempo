// Tempo question picker: named tabs per question and radio-card options for the multiple-choice
// card that ComposerPendingUserInputPanel shows. State, timers and shortcuts stay in that panel.
import type { ScopedThreadRef, UserInputQuestion } from "@t3tools/contracts";
import {
  describePickedAnswer,
  parseRecommendedLabel,
  questionPrimaryActionLabel,
  splitQuestionText,
} from "@t3tools/client-runtime/tempo/question-picker";
import { CheckIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../components/ChatMarkdown";
import { Badge } from "../components/ui/badge";
import { Kbd } from "../components/ui/kbd";
import { useTempoLook } from "./look/useTempoLook";
import {
  resolvePendingUserInputAnswer,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";

/** The composer's primary button text for the active question, or null to keep its own wording. */
export function pendingPrimaryLabel(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): string | null {
  const question = questions[questionIndex];
  if (question === undefined) return null;
  return questionPrimaryActionLabel({
    questionCount: questions.length,
    isLastQuestion: questionIndex >= questions.length - 1,
    answerLabel: describePickedAnswer(
      question.options,
      resolvePendingUserInputAnswer(question, answers[question.id]),
    ),
  });
}

export const QUESTION_OPTION_ATTRIBUTE = "data-question-option";

/** A tab is open once every question before it has an answer, so nobody skips ahead. */
function canOpenQuestionTab(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: Record<string, PendingUserInputDraftAnswer>,
  activeIndex: number,
  index: number,
): boolean {
  if (index <= activeIndex) return true;
  return questions
    .slice(0, index)
    .every((question) => resolvePendingUserInputAnswer(question, answers[question.id]) !== null);
}

export function QuestionTabs(props: {
  questions: ReadonlyArray<UserInputQuestion>;
  answers: Record<string, PendingUserInputDraftAnswer>;
  activeIndex: number;
  disabled: boolean;
  onSelectQuestion: (index: number) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Questions"
      className="mb-3 flex gap-1 border-b border-border/60"
    >
      {props.questions.map((question, index) => {
        const isActive = index === props.activeIndex;
        const answer = resolvePendingUserInputAnswer(question, props.answers[question.id]);
        const answerLabel = describePickedAnswer(question.options, answer);
        const isAnswered = answer !== null && !isActive;
        const isDisabled =
          props.disabled ||
          !canOpenQuestionTab(props.questions, props.answers, props.activeIndex, index);
        return (
          <button
            key={question.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={isDisabled}
            onClick={() => {
              if (!isActive) props.onSelectQuestion(index);
            }}
            className={cn(
              "-mb-px flex min-w-0 items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25",
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
              isDisabled && "cursor-not-allowed opacity-50 hover:text-muted-foreground",
              !isDisabled && "cursor-pointer",
            )}
          >
            {isAnswered ? <CheckIcon className="size-3 shrink-0 text-success-foreground" /> : null}
            <span className="max-w-40 truncate">
              {question.header}
              {isAnswered && answerLabel !== null ? (
                <>
                  : <span className="font-semibold text-foreground">{answerLabel}</span>
                </>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function QuestionHeading(props: {
  question: UserInputQuestion;
  showHeaderChip: boolean;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
}) {
  const { title, context, hasTitle } = splitQuestionText(props.question.question);
  return (
    <div className="flex flex-col gap-1" data-question-heading="">
      {props.showHeaderChip ? (
        <span className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
          {props.question.header}
        </span>
      ) : null}
      {hasTitle ? (
        <>
          <ChatMarkdown
            text={title}
            cwd={props.cwd}
            threadRef={props.threadRef}
            className="text-base font-semibold text-foreground"
          />
          {context.length > 0 ? (
            <ChatMarkdown
              text={context}
              cwd={props.cwd}
              threadRef={props.threadRef}
              className="text-xs text-muted-foreground"
            />
          ) : null}
        </>
      ) : (
        <ChatMarkdown
          text={props.question.question}
          cwd={props.cwd}
          threadRef={props.threadRef}
          className="text-foreground/85"
        />
      )}
      {props.question.multiSelect ? (
        <p className="text-secondary-label text-xs">Select one or more options.</p>
      ) : null}
    </div>
  );
}

export function QuestionOptionCards(props: {
  question: UserInputQuestion;
  isDisabled: boolean;
  isSelected: (optionValue: string, index: number) => boolean;
  onPick: (optionValue: string) => void;
}) {
  const { question } = props;
  const isMulti = question.multiSelect === true;
  // tempo: the tempo look keys each option at its left and names the recommended one in blue.
  const tempo = useTempoLook() === "tempo";
  return (
    <div
      role={isMulti ? "group" : "radiogroup"}
      aria-label={question.header}
      className="mt-3 flex flex-col gap-1.5 tempo:mt-2"
    >
      {question.options.map((option, index) => {
        const optionValue = option.value ?? option.label;
        const isSelected = props.isSelected(optionValue, index);
        const parsed = parseRecommendedLabel(option.label);
        const shortcutKey = index < 9 ? index + 1 : null;
        return (
          <button
            key={`${question.id}:${optionValue}`}
            type="button"
            role={isMulti ? "checkbox" : "radio"}
            aria-checked={isSelected}
            {...{ [QUESTION_OPTION_ATTRIBUTE]: "" }}
            disabled={props.isDisabled}
            onClick={() => {
              props.onPick(optionValue);
            }}
            className={cn(
              tempo
                ? "flex min-h-9.5 w-full items-center gap-2.5 px-3 py-1.5 text-left text-foreground text-sm outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                : "flex w-full items-start gap-3 rounded-xl border px-3 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40",
              tempo
                ? !isSelected && "hover:bg-muted"
                : isSelected
                  ? "border-primary bg-primary/8 text-foreground"
                  : "border-border/60 bg-transparent text-foreground/85 hover:bg-muted/30",
              props.isDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
            )}
          >
            {tempo ? (
              shortcutKey === null ? null : (
                <span
                  aria-hidden="true"
                  className="flex size-5 shrink-0 items-center justify-center rounded-md bg-accent font-semibold text-muted-foreground text-xs tabular-nums"
                >
                  {shortcutKey}
                </span>
              )
            ) : (
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center border-2",
                  isMulti ? "rounded" : "rounded-full",
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/60",
                )}
              >
                {isSelected ? (
                  isMulti ? (
                    <CheckIcon className="size-3" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-primary-foreground" />
                  )
                ) : null}
              </span>
            )}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <span className={tempo ? undefined : "text-sm font-semibold"}>{parsed.label}</span>
                {parsed.isRecommended && !tempo ? (
                  <Badge variant="success" size="sm">
                    Recommended
                  </Badge>
                ) : null}
              </span>
              {option.description && option.description !== option.label ? (
                <span className="text-secondary-label text-xs">{option.description}</span>
              ) : null}
            </span>
            {tempo ? (
              parsed.isRecommended ? (
                <span className="shrink-0 font-medium text-tempo-accent text-xs">Recommended</span>
              ) : null
            ) : shortcutKey !== null ? (
              <Kbd>{shortcutKey}</Kbd>
            ) : null}
          </button>
        );
      })}
      {question.allowCustomAnswer === false || tempo ? null : (
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
          <span
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 border-2 border-dashed border-muted-foreground/60",
              isMulti ? "rounded" : "rounded-full",
            )}
          />
          <span>
            Something else…{" "}
            <span className="text-xs text-muted-foreground/80">type in the composer</span>
          </span>
        </div>
      )}
    </div>
  );
}

export function QuestionHint(props: {
  optionCount: number;
  isMultiSelect: boolean;
  allowsCustomAnswer: boolean;
}) {
  const maxKey = Math.min(props.optionCount, 9);
  const verb = props.isMultiSelect ? "toggle" : "pick";
  if (useTempoLook() === "tempo") {
    return (
      <p className="mt-2.5 text-secondary-label" data-question-hint="">
        {maxKey > 1 ? `Press 1 to ${maxKey}` : "Press 1"}
        {props.isMultiSelect ? " to toggle" : ""}
        {props.allowsCustomAnswer ? ", or type something else" : ""}
      </p>
    );
  }
  return (
    <p className="mt-3 text-2xs text-muted-foreground">
      {maxKey > 1 ? `↑↓ or 1–${maxKey} to ${verb}` : `↑↓ or 1 to ${verb}`}
    </p>
  );
}
