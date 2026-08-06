import { useState } from 'react'
import type { QuestionAnswers, QuestionRequest, QuestionSpec } from '../../../shared/api'
import { Button } from '@/components/ui/button'

interface Props {
  requests: QuestionRequest[]
  onRespond: (id: string, answers: QuestionAnswers | null) => void
}

// Sentinel option value for the always-available free-text "Other…" choice (the
// AskUserQuestion contract says the host provides it automatically).
const OTHER = '__other__'

/**
 * Interactive multiple-choice cards for questions the agent asks the user (the
 * SDK's AskUserQuestion tool) — distinct from the approve/deny permission cards.
 * Shown above the composer while a turn awaits the answer. A single single-select
 * question submits on click; multi-select collects picks and submits via "Send".
 * A MULTI-question request runs as a step-by-step wizard (one question at a
 * time, "1/3" progress, Back to revisit; a single-select pick auto-advances,
 * multi-select advances via Next, the last step Sends) — all-at-once was a wall
 * of options. "Skip" always dismisses the whole request without answering.
 * Class hooks (`.question*`) drive the test harness.
 */
export default function QuestionCards({ requests, onRespond }: Props): React.JSX.Element | null {
  if (requests.length === 0) return null
  return (
    <div className="questions flex flex-col gap-1.5">
      {requests.map((req) => (
        <QuestionCard key={req.id} req={req} onRespond={onRespond} />
      ))}
    </div>
  )
}

function QuestionCard({
  req,
  onRespond
}: {
  req: QuestionRequest
  onRespond: (id: string, answers: QuestionAnswers | null) => void
}): React.JSX.Element {
  // Per-question chosen option labels (single-select keeps one; multi-select many).
  const [sel, setSel] = useState<Record<number, string[]>>({})
  // Free text typed for the "Other…" choice, per question.
  const [other, setOther] = useState<Record<number, string>>({})
  // Wizard cursor — which question is on screen (always 0 for single-question).
  const [step, setStep] = useState(0)

  const total = req.questions.length
  const wizard = total > 1
  const last = step === total - 1

  const answerFor = (qi: number): string =>
    (sel[qi] ?? [])
      .map((c) => (c === OTHER ? (other[qi] ?? '').trim() : c))
      .filter(Boolean)
      .join(', ')

  const allAnswered = req.questions.every((_q, qi) => answerFor(qi).length > 0)
  // Auto-submit-on-click only applies to the simple single-question single-select
  // case; everything else collects picks and submits with the Send button.
  const oneShot = total === 1 && !req.questions[0].multiSelect

  const submitAll = (): void => {
    const answers: QuestionAnswers = {}
    req.questions.forEach((q, qi) => {
      answers[q.question] = answerFor(qi)
    })
    onRespond(req.id, answers)
  }

  const choose = (qi: number, q: QuestionSpec, value: string): void => {
    setSel((s) => {
      const cur = s[qi] ?? []
      if (q.multiSelect) {
        return { ...s, [qi]: cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value] }
      }
      return { ...s, [qi]: [value] }
    })
    // A concrete pick on the single single-select question answers immediately.
    if (oneShot && value !== OTHER) onRespond(req.id, { [q.question]: value })
    // Wizard: a concrete single-select pick answers this step — flow onward.
    if (wizard && !q.multiSelect && value !== OTHER && qi < total - 1) setStep(qi + 1)
  }

  return (
    <div className="question flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50 p-2.5 dark:border-blue-900/50 dark:bg-blue-950/30">
      {req.questions.map((q, qi) => {
        if (wizard && qi !== step) return null // one question at a time
        const chosen = sel[qi] ?? []
        return (
          <div key={qi} className="question__item flex flex-col gap-1.5" role="group" aria-label={q.header}>
            <div className="question__headrow flex items-center justify-between">
              <div className="question__header w-fit rounded bg-blue-100 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-blue-800 dark:bg-blue-900/50 dark:text-blue-200">
                {q.header}
              </div>
              {wizard && (
                <span className="question__progress text-[10.5px] font-medium tabular-nums text-blue-600 dark:text-blue-300/80">
                  {step + 1}/{total}
                </span>
              )}
            </div>
            <div className="question__text text-[13px] font-medium text-blue-950 dark:text-blue-100">
              {q.question}
            </div>
            <div className="question__options flex flex-col gap-1">
              {q.options.map((o) => {
                const active = chosen.includes(o.label)
                return (
                  <button
                    key={o.label}
                    type="button"
                    className={`question__option flex flex-col items-start rounded-md border px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                      active
                        ? 'border-blue-500 bg-blue-100 text-blue-950 dark:border-blue-500 dark:bg-blue-900/50 dark:text-blue-100'
                        : 'border-blue-200 bg-white text-blue-900 hover:border-blue-400 hover:bg-blue-100/60 dark:border-blue-900/50 dark:bg-transparent dark:text-blue-200 dark:hover:border-blue-700 dark:hover:bg-blue-900/30'
                    } ${active ? 'is-selected' : ''}`}
                    aria-pressed={active}
                    onClick={() => choose(qi, q, o.label)}
                  >
                    <span className="question__option-label font-medium">{o.label}</span>
                    {o.description && (
                      <span className="question__option-desc text-[11px] text-blue-700 dark:text-blue-300/80">
                        {o.description}
                      </span>
                    )}
                  </button>
                )
              })}
              <button
                type="button"
                className={`question__option question__other-toggle flex items-start rounded-md border px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                  chosen.includes(OTHER)
                    ? 'border-blue-500 bg-blue-100 text-blue-950 is-selected dark:border-blue-500 dark:bg-blue-900/50 dark:text-blue-100'
                    : 'border-dashed border-blue-300 bg-white text-blue-700 hover:bg-blue-100/60 dark:border-blue-800 dark:bg-transparent dark:text-blue-300 dark:hover:bg-blue-900/30'
                }`}
                aria-pressed={chosen.includes(OTHER)}
                onClick={() => choose(qi, q, OTHER)}
              >
                Other…
              </button>
              {chosen.includes(OTHER) && (
                <input
                  type="text"
                  className="question__other w-full rounded-md border border-blue-300 bg-white px-2 py-1 text-[12.5px] text-blue-950 outline-none focus:border-blue-500 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100"
                  placeholder="Type your answer"
                  value={other[qi] ?? ''}
                  onChange={(e) => setOther((s) => ({ ...s, [qi]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    // Mid-wizard: Enter on an answered "Other" advances; on the
                    // final (or only) question it sends once everything is in.
                    if (wizard && !last && answerFor(qi).length > 0) setStep(qi + 1)
                    else if (allAnswered) submitAll()
                  }}
                />
              )}
            </div>
          </div>
        )
      })}
      <div className="question__actions flex justify-end gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="question__skip"
          onClick={() => onRespond(req.id, null)}
        >
          Skip
        </Button>
        {wizard && step > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="question__back"
            onClick={() => setStep(step - 1)}
          >
            Back
          </Button>
        )}
        {wizard && !last ? (
          <Button
            size="sm"
            className="question__next"
            disabled={answerFor(step).length === 0}
            onClick={() => setStep(step + 1)}
          >
            Next
          </Button>
        ) : (
          <Button size="sm" className="question__send" disabled={!allAnswered} onClick={submitAll}>
            Send
          </Button>
        )}
      </div>
    </div>
  )
}
