import { useEffect, useState } from 'react'
import type { SessionRecord } from '../../../shared/api'
import { relativeTime, useHistory } from '../store'

interface Props {
  /** The record to review (a header-only summary from the rail list). */
  record: SessionRecord
  onClose: () => void
  /** v9 resume — hand this record's SDK session back to a live query. Only
   *  called when the Resume button is shown (gated on `sdkSessionId`); resolves
   *  once the resume attempt settles (success closes the panel itself). */
  onResume: (record: SessionRecord) => void | Promise<void>
}

/**
 * v5-D "previous agent" review — a read-only look at a finished session: its
 * branch / PR, the files it touched, and its transcript. Re-fetches the full
 * record by id on open (the rail list carries the same shape, but `get` is the
 * authoritative copy and keeps the panel honest if the list is stale).
 *
 * v9: a session captured with a Claude `sdkSessionId` CAN be resumed — the
 * "Resume" button hands it back to a live SDK query via `agent:resume-session`.
 * `sdkSessionId` is Claude-only (Codex/Gemini never set it), so its presence
 * doubles as the "this backend supports resume" check.
 */
export default function SessionReview({ record, onClose, onResume }: Props): React.JSX.Element {
  const [full, setFull] = useState<SessionRecord>(record)
  const [busy, setBusy] = useState<null | 'apply' | 'pr' | 'discard' | 'resume'>(null)
  const [note, setNote] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null)

  useEffect(() => {
    let live = true
    void window.api.sessions.get(record.id).then((r) => {
      if (live && r) setFull(r)
    })
    return () => {
      live = false
    }
  }, [record.id])

  // v8 F1 Phase 2: a finished COMMENT spawn left its work on a branch. Offer to
  // Apply it onto the live tree (preview HMRs), open a PR from it, or Discard it.
  const isComment = full.kind === 'comment' && !!full.branch
  const commentTitle =
    full.transcript.find((t) => t.role === 'user')?.text?.slice(0, 70) || 'Praxis comment edit'

  const apply = async (): Promise<void> => {
    setBusy('apply')
    setNote(null)
    try {
      const r = await window.api.agent.spawnApply(full.projectRoot, full.branch as string)
      if (r.ok) setNote({ kind: 'ok', text: 'Applied to your working tree — the preview should refresh.' })
      else setNote({ kind: r.conflict ? 'warn' : 'err', text: r.error ?? 'Could not apply.' })
    } finally {
      setBusy(null)
    }
  }
  const openPr = async (): Promise<void> => {
    setBusy('pr')
    setNote(null)
    try {
      const r = await window.api.agent.spawnPr(full.projectRoot, full.branch as string, commentTitle, full.id)
      if (r.ok && r.prUrl) {
        setFull({ ...full, prUrl: r.prUrl })
        setNote({ kind: 'ok', text: 'PR opened.' })
      } else {
        setNote({ kind: 'err', text: r.error ?? 'Could not open a PR.' })
      }
    } finally {
      setBusy(null)
    }
  }
  const discard = async (): Promise<void> => {
    setBusy('discard')
    try {
      await window.api.agent.spawnDiscard(full.projectRoot, full.branch as string)
      await useHistory.getState().remove(full.projectRoot, full.id)
      onClose()
    } finally {
      setBusy(null)
    }
  }

  // v9 resume — only Claude sessions carry a `sdkSessionId` (Codex/Gemini never
  // set it), so its presence is both "resumable" AND "Claude-backed" in one check.
  const canResume = !!full.sdkSessionId
  const resume = async (): Promise<void> => {
    setBusy('resume')
    try {
      await onResume(full)
      // On success the parent closes this panel; on failure (logged to the
      // activity console) fall through to re-enable the button below.
    } finally {
      setBusy(null)
    }
  }

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const when = full.endedAt
    ? `${relativeTime(full.startedAt)} · ran ${Math.max(1, Math.round((full.endedAt - full.startedAt) / 1000))}s`
    : relativeTime(full.startedAt)

  return (
    <div className="review__backdrop" onClick={onClose}>
      <div
        className="review"
        role="dialog"
        aria-modal="true"
        aria-label={`Session for ${full.projectName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="review__head">
          <div className="review__title">
            <span className="review__name">{full.projectName}</span>
            <span className="review__when">{when}</span>
          </div>
          <button className="review__x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="review__meta">
          {full.branch && <span className="review__chip">{full.branch}</span>}
          {full.prUrl && (
            <a className="review__chip review__chip--link" href={full.prUrl} target="_blank" rel="noreferrer">
              View PR ↗
            </a>
          )}
          {full.filesTouched.length > 0 && (
            <span className="review__chip">
              {full.filesTouched.length} file{full.filesTouched.length === 1 ? '' : 's'} touched
            </span>
          )}
        </div>

        {full.filesTouched.length > 0 && (
          <ul className="review__files">
            {full.filesTouched.map((f) => (
              <li key={f} title={f}>
                {f}
              </li>
            ))}
          </ul>
        )}

        {(isComment || canResume) && (
          <div className="review__actions">
            {isComment && (
              <>
                <button
                  className="review__action review__action--primary"
                  onClick={apply}
                  disabled={busy !== null}
                  title="Apply this run's changes onto your working tree"
                >
                  {busy === 'apply' ? 'Applying…' : 'Apply'}
                </button>
                <button
                  className="review__action"
                  onClick={openPr}
                  disabled={busy !== null || !!full.prUrl}
                  title="Push the branch and open a PR"
                >
                  {busy === 'pr' ? 'Opening…' : full.prUrl ? 'PR opened' : 'Open PR'}
                </button>
                <button
                  className="review__action review__action--danger"
                  onClick={discard}
                  disabled={busy !== null}
                  title="Delete this run's branch"
                >
                  {busy === 'discard' ? 'Discarding…' : 'Discard'}
                </button>
              </>
            )}
            {canResume && (
              <button
                className="review__action review__action--primary"
                onClick={resume}
                disabled={busy !== null}
                title="Reload this conversation into a live chat and keep going"
              >
                {busy === 'resume' ? 'Resuming…' : 'Resume'}
              </button>
            )}
          </div>
        )}
        {note && <div className={`review__note review__note--${note.kind}`}>{note.text}</div>}

        <div className="review__transcript">
          {full.transcript.length === 0 ? (
            <p className="review__empty">No transcript recorded.</p>
          ) : (
            full.transcript.map((t, i) => (
              <div key={i} className={`review__line review__line--${t.role}`}>
                <span className="review__role">{t.role}</span>
                <span className="review__text">{t.text}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
