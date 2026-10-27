import { useMemo, useState } from "react";

import type { PiBridgeApi } from "../PiBridgeContext";
import type { PiDialog, PiQuestion } from "../piProtocol";
import "./cards.css";

type AnswerState = { selected: number[]; text: string };

type QuestionCardProps = {
  dialog: PiDialog;
  answerDialog: PiBridgeApi["answerDialog"];
};

function initialAnswers(questions: PiQuestion[]): AnswerState[] {
  return questions.map(() => ({ selected: [], text: "" }));
}

function answerIsComplete(question: PiQuestion, answer: AnswerState): boolean {
  return answer.selected.length > 0 || answer.text.trim().length > 0;
}

function questionLabel(question: PiQuestion): string {
  return question.header || question.question;
}

/**
 * One touch Native Card for an `ask_user_question` questionnaire. Every
 * question accepts its options, a free-text answer, or both when it is a
 * multi-select question. Answers go over the Pi Bridge's `dialog_answer`, so
 * the first surface to answer (this card or the terminal) wins.
 */
export function PiQuestionCard({ dialog, answerDialog }: QuestionCardProps) {
  const questions = useMemo(() => dialog.questions ?? [], [dialog.questions]);
  const [answers, setAnswers] = useState<AnswerState[]>(() => initialAnswers(questions));
  const [sending, setSending] = useState<"answer" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const complete = questions.length > 0 && questions.every((question, index) => answerIsComplete(question, answers[index]));

  function update(index: number, next: AnswerState) {
    setAnswers((current) => current.map((answer, position) => (position === index ? next : answer)));
  }

  function toggleOption(index: number, question: PiQuestion, optionIndex: number) {
    const current = answers[index];
    let selected: number[];
    if (question.multiSelect) {
      selected = current.selected.includes(optionIndex)
        ? current.selected.filter((value) => value !== optionIndex)
        : [...current.selected, optionIndex].sort((a, b) => a - b);
    } else {
      selected = current.selected.includes(optionIndex) ? [] : [optionIndex];
    }
    update(index, { selected, text: question.multiSelect ? current.text : "" });
  }

  function setFreeText(index: number, question: PiQuestion, text: string) {
    const current = answers[index];
    update(index, {
      selected: !question.multiSelect && text.trim().length > 0 ? [] : current.selected,
      text,
    });
  }

  async function settle(kind: "answer" | "cancel") {
    if (sending) {
      return;
    }
    setError(null);
    setSending(kind);
    try {
      const result =
        kind === "cancel"
          ? await answerDialog(dialog.id, { cancel: true })
          : await answerDialog(dialog.id, {
              value: {
                answers: questions.map((question, index) => {
                  const answer = answers[index];
                  const entry: {
                    questionIndex: number;
                    optionIndexes?: number[];
                    text?: string;
                  } = { questionIndex: index };
                  if (answer.selected.length > 0) {
                    entry.optionIndexes = answer.selected;
                  }
                  if (answer.text.trim().length > 0) {
                    entry.text = answer.text.trim();
                  }
                  return entry;
                }),
              },
            });
      if (!result.accepted) {
        setError("Another surface answered this question first.");
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(
        /offline/i.test(message)
          ? "Pi Bridge is offline. Answer from the terminal or retry when it reconnects."
          : message,
      );
    } finally {
      setSending(null);
    }
  }

  return (
    <section className="pi-question-card" data-pi-question-card="true" aria-label="Pi question">
      <div className="pi-question-card-head">
        <h2 className="pi-question-card-title">Pi is asking</h2>
        <span className="pi-question-card-count">
          {questions.length} {questions.length === 1 ? "question" : "questions"}
        </span>
        <button
          className="pi-question-card-cancel"
          type="button"
          disabled={sending !== null}
          onClick={() => void settle("cancel")}
        >
          Cancel
        </button>
      </div>
      {questions.map((question, questionIndex) => {
        const answer = answers[questionIndex];
        return (
          <div className="pi-question-block" key={`${question.question}-${questionIndex}`}>
            {question.header ? <p className="pi-question-header">{question.header}</p> : null}
            <p className="pi-question-text">{question.question}</p>
            <div className="pi-question-options" role="group" aria-label={questionLabel(question)}>
              {question.options.map((option, optionIndex) => {
                const selected = answer.selected.includes(optionIndex);
                return (
                  <button
                    className="pi-question-option"
                    type="button"
                    key={`${option.label}-${optionIndex}`}
                    aria-pressed={selected}
                    onClick={() => toggleOption(questionIndex, question, optionIndex)}
                  >
                    <span className="pi-question-option-label">{option.label}</span>
                    {option.description ? (
                      <span className="pi-question-option-description">{option.description}</span>
                    ) : null}
                    {selected && option.preview ? (
                      <pre className="pi-question-preview">{option.preview}</pre>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <textarea
              className="pi-question-free-text"
              rows={1}
              aria-label={`Free-text answer for ${questionLabel(question)}`}
              placeholder="Type something."
              value={answer.text}
              onChange={(event) => setFreeText(questionIndex, question, event.target.value)}
            />
          </div>
        );
      })}
      {error ? (
        <p className="pi-question-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="pi-question-card-actions">
        <button
          className="pi-question-submit"
          type="button"
          disabled={!complete || sending !== null}
          onClick={() => void settle("answer")}
        >
          Send answer
        </button>
      </div>
    </section>
  );
}
