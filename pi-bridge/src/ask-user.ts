/**
 * Pure mapping between rpiv's `ask_user_question` event contract and the Pi
 * Bridge protocol question dialog.
 *
 * Source of truth for the event contract:
 * ~/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question/events.ts
 * (`rpiv:ask-user:prompt`, `rpiv:ask-user:blocked`, `rpiv:ask-user:answer`,
 * `rpiv:ask-user:answer-result`).
 *
 * The prompt event deliberately omits preview content (only `hasPreview`), so
 * callers pass the tool arguments captured from Pi's `tool_execution_start`
 * event (dist/core/extensions/types.d.ts:853-859) to fill the previews.
 */

export const ASK_USER_TOOL_NAME = "ask_user_question";

export const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";
export const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";
export const ASK_USER_ANSWER_EVENT = "rpiv:ask-user:answer";
export const ASK_USER_ANSWER_RESULT_EVENT = "rpiv:ask-user:answer-result";

export interface AskUserPromptOption {
  label: string;
  description?: string;
  hasPreview?: boolean;
}

export interface AskUserPromptQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskUserPromptOption[];
}

export interface AskUserPromptPayload {
  toolCallId?: string;
  questions?: AskUserPromptQuestion[];
}

export interface AskUserBlockedPayload {
  active?: boolean;
  toolCallId?: string;
}

export interface AskUserAnswerEntry {
  questionIndex: number;
  optionIndexes?: number[];
  text?: string;
  notes?: string;
}

export interface AskUserAnswerPayload {
  toolCallId: string;
  requestId: string;
  answers?: AskUserAnswerEntry[];
  globalNote?: string;
  cancel?: boolean;
}

export interface AskUserAnswerResultPayload {
  ok?: boolean;
  code?: string;
  requestId?: string;
  toolCallId?: string;
}

export interface QuestionOption {
  label: string;
  description: string;
  preview: string;
}

export interface QuestionRecord {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface QuestionDialog {
  id: string;
  kind: "question";
  questions: QuestionRecord[];
  timeout_ms: null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function previewFromArgs(args: unknown, questionIndex: number, optionIndex: number, label: string): string {
  const questions = asRecord(args)?.questions;
  if (!Array.isArray(questions)) {
    return "";
  }
  const options = asRecord(questions[questionIndex])?.options;
  if (!Array.isArray(options)) {
    return "";
  }
  const direct = asRecord(options[optionIndex]);
  const matched =
    direct && typeof direct.label === "string" && direct.label === label
      ? direct
      : options.map(asRecord).find((option) => option?.label === label);
  return typeof matched?.preview === "string" ? matched.preview : "";
}

/** Convert one rpiv prompt into the protocol's question dialog. */
export function questionDialog(
  toolCallId: string,
  prompt: AskUserPromptPayload,
  previewArgs?: unknown,
): QuestionDialog | null {
  if (!Array.isArray(prompt.questions) || prompt.questions.length === 0) {
    return null;
  }
  const questions: QuestionRecord[] = [];
  for (const [questionIndex, question] of prompt.questions.entries()) {
    if (!asRecord(question) || typeof question.question !== "string") {
      return null;
    }
    const options: QuestionOption[] = [];
    for (const [optionIndex, option] of (Array.isArray(question.options) ? question.options : []).entries()) {
      if (!asRecord(option) || typeof option.label !== "string") {
        return null;
      }
      options.push({
        label: option.label,
        description: typeof option.description === "string" ? option.description : "",
        preview: previewFromArgs(previewArgs, questionIndex, optionIndex, option.label),
      });
    }
    questions.push({
      question: question.question,
      header: typeof question.header === "string" ? question.header : "",
      multiSelect: question.multiSelect === true,
      options,
    });
  }
  return { id: toolCallId, kind: "question", questions, timeout_ms: null };
}

function normalizedIndexes(value: unknown): number[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const indexes: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || indexes.includes(item)) {
      return null;
    }
    indexes.push(item);
  }
  return indexes;
}

/**
 * Normalize a `dialog_answer` value into rpiv answer entries. rpiv validates
 * the full questionnaire itself and refuses partial answers, so this only
 * enforces the wire shape and trims text.
 */
export function answerEntries(value: unknown): AskUserAnswerEntry[] | null {
  const answers = asRecord(value)?.answers;
  if (!Array.isArray(answers) || answers.length === 0) {
    return null;
  }
  const entries: AskUserAnswerEntry[] = [];
  for (const item of answers) {
    const answer = asRecord(item);
    if (!answer || typeof answer.questionIndex !== "number" || !Number.isInteger(answer.questionIndex)) {
      return null;
    }
    if (answer.questionIndex < 0) {
      return null;
    }
    const optionIndexes = normalizedIndexes(answer.optionIndexes);
    if (optionIndexes === null) {
      return null;
    }
    const entry: AskUserAnswerEntry = { questionIndex: answer.questionIndex };
    if (optionIndexes && optionIndexes.length > 0) {
      entry.optionIndexes = optionIndexes;
    }
    if (typeof answer.text === "string" && answer.text.trim().length > 0) {
      entry.text = answer.text.trim();
    }
    if (typeof answer.notes === "string" && answer.notes.trim().length > 0) {
      entry.notes = answer.notes.trim();
    }
    if (!entry.optionIndexes && entry.text === undefined) {
      return null;
    }
    entries.push(entry);
  }
  return entries;
}

export function notesFromValue(value: unknown): string | undefined {
  const note = asRecord(value)?.globalNote;
  return typeof note === "string" && note.trim().length > 0 ? note.trim() : undefined;
}
