import { useEffect, useState } from 'react'
import type { PropField, PropInspection, SelectedElement } from '../../../shared/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface Props {
  root: string
  element: SelectedElement
  /** null → no schema (readiness messaging shows instead of fields). */
  inspection: PropInspection | null
  /** Inspection still in flight. */
  inspecting: boolean
  /** Update the canonical inspection (optimistic apply / reload). */
  onChange: (next: PropInspection) => void
  /** Seed a chat prompt for changes that can't be applied as a literal. */
  onSeedPrompt: (text: string) => void
  /** Offer to set the project up for editing (unstamped element). */
  onSetup: () => void
  /** v8 F3a: re-select the owning component instance. */
  onSelectOwner: () => void
  /** Ask the AI to surface a control panel (Custom Controls, v10) — offered
   *  from the "not ready" states as an alternative to prompting. */
  onControls?: () => void
}

/**
 * The Props tab body — content-only (the card chrome + header live in
 * IslandCard, which renders this inside its Props tab). A schema-backed
 * component gets editable fields; anything else gets the readiness message
 * (setup offer / owner jump / prompt-only hint). Simple literal edits write
 * straight to source; non-literal ones go to chat.
 */
export default function PropPanel({
  root,
  element,
  inspection,
  inspecting,
  onChange,
  onSeedPrompt,
  onSetup,
  onSelectOwner,
  onControls
}: Props): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hasSchema = !!inspection?.hasSchema
  const source = inspection?.source ?? element.source ?? ''
  const hasOwner = !!element.componentSource && element.componentSource !== element.source

  const reload = (): void => {
    if (source) window.api.props.inspect(root, source).then((res) => res && onChange(res))
  }

  const apply = async (field: PropField, value: string | number | boolean): Promise<void> => {
    setBusy(field.name)
    setError(null)
    try {
      const res = await window.api.props.apply(root, {
        source,
        name: field.name,
        kind: field.kind,
        value
      })
      if (res.applied) {
        // Only reachable from a rendered PropRow, which implies a schema-backed
        // inspection is present.
        if (inspection) {
          onChange({
            ...inspection,
            fields: inspection.fields.map((f) =>
              f.name === field.name ? { ...f, value, expression: false } : f
            )
          })
        }
      } else if (res.needsAgent) {
        onSeedPrompt(res.agentPrompt ?? `In ${source}, change the ${field.name} prop.`)
      } else {
        setError(res.error ?? 'Could not apply the change.')
        reload()
      }
    } catch {
      setError('The edit could not be sent.')
      reload()
    } finally {
      setBusy(null)
    }
  }

  // Reset-to-default: remove the attribute from source so the value falls back to
  // the component's declared default. Reversible via Cmd+Z (F3b). (v8 F2)
  const reset = async (field: PropField): Promise<void> => {
    setBusy(field.name)
    setError(null)
    try {
      const res = await window.api.props.remove(root, source, field.name)
      if (!res.applied) setError(res.error ?? 'Could not reset the prop.')
    } catch {
      setError('The reset could not be sent.')
    } finally {
      setBusy(null)
      reload() // re-inspect: the attribute is gone, the schema default shows
    }
  }

  return (
    <>
      {hasSchema && inspection ? (
        <>
          {error && (
            <div className="proppanel__error mx-3 mt-1 text-[11.5px] text-red-700">{error}</div>
          )}
          {inspection.note && (
            <div className="proppanel__note mx-3 mt-1 text-[11.5px] text-muted-foreground">
              {inspection.note}
            </div>
          )}
          <div className="proppanel__rows flex flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-3 pt-1.5">
            {inspection.fields.length === 0 && (
              <div className="proppanel__note text-[11.5px] text-muted-foreground">
                No editable props.
              </div>
            )}
            {inspection.fields.map((f) => (
              <PropRow
                key={f.name}
                field={f}
                busy={busy === f.name}
                onApply={(v) => apply(f, v)}
                onReset={() => reset(f)}
                onAskAgent={() => onSeedPrompt(`In ${source}, change the \`${f.name}\` prop.`)}
              />
            ))}
          </div>
        </>
      ) : (
        /* No schema (or still inspecting) — the readiness message lives here
           now, not in the chat area. Same three honest "not ready" cases the
           composer strip used to show. */
        <div className="proppanel__rows flex flex-col gap-2 overflow-y-auto px-3 pb-3 pt-1.5">
          {inspecting ? (
            <div className="proppanel__ready text-[12px] text-muted-foreground">
              Reading props…
            </div>
          ) : !element.source ? (
            <div className="proppanel__ready proppanel__ready--no text-[12px] text-amber-700">
              Not set up for prop editing —{' '}
              <button className="proppanel__link text-blue-600 underline" onClick={onSetup}>
                set up the project
              </button>{' '}
              or ask Praxis below.
            </div>
          ) : hasOwner ? (
            <div className="proppanel__ready proppanel__ready--no text-[12px] text-muted-foreground">
              {`<${element.tag}>`} is a plain element —{' '}
              <button className="proppanel__owner text-blue-600 underline" onClick={onSelectOwner}>
                edit its component
              </button>{' '}
              or ask Praxis below.
            </div>
          ) : (
            <div className="proppanel__ready proppanel__ready--no text-[12px] text-muted-foreground">
              No editable props on {`<${element.tag}>`} — ask Praxis below to change it.
            </div>
          )}
          {/* Custom Controls (v10): when the automatic paths came up empty, the
              AI can instrument the source and surface a panel — needs a stamp. */}
          {!inspecting && element.source && onControls && (
            <button
              type="button"
              className="proppanel__controls self-start text-[11.5px] text-blue-600 underline"
              onClick={onControls}
            >
              Surface controls with AI
            </button>
          )}
        </div>
      )}
    </>
  )
}

function PropRow({
  field,
  busy,
  onApply,
  onReset,
  onAskAgent
}: {
  field: PropField
  busy: boolean
  onApply: (v: string | number | boolean) => void
  onReset: () => void
  onAskAgent: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(field.value ?? '')
  useEffect(() => setDraft(field.value ?? ''), [field.value])

  // The attribute is present on the element (not a pure schema offering) → it can
  // be reset/removed. Never offer it for a required prop (would break the component).
  const isPresent = !field.fromSchema || field.value !== undefined || field.expression === true
  const canReset = isPresent && !field.required

  let control: React.JSX.Element
  if (field.expression || field.kind === 'other') {
    control = (
      <Button
        variant="outline"
        size="sm"
        className="proppanel__agent h-7 justify-self-end px-2 text-[11.5px]"
        onClick={onAskAgent}
        disabled={busy}
      >
        edit via chat
      </Button>
    )
  } else if (field.kind === 'boolean') {
    control = (
      <input
        type="checkbox"
        className="justify-self-end"
        checked={field.value === true}
        disabled={busy}
        onChange={(e) => onApply(e.target.checked)}
      />
    )
  } else if (field.kind === 'enum' && field.options) {
    control = (
      <select
        className="select h-7 w-[128px] justify-self-end rounded-md border bg-transparent px-1.5 text-xs"
        value={String(field.value ?? '')}
        disabled={busy}
        onChange={(e) => onApply(e.target.value)}
      >
        <option value="" disabled>
          —
        </option>
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  } else {
    const isNumber = field.kind === 'number'
    control = (
      <Input
        className="proppanel__input h-7 w-[128px] justify-self-end px-2 text-xs"
        type={isNumber ? 'number' : 'text'}
        value={String(draft)}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
    )
    function commit(): void {
      if (isNumber) {
        const n = Number(draft)
        if (draft !== '' && !Number.isNaN(n) && n !== field.value) onApply(n)
      } else if (draft !== field.value) {
        onApply(String(draft))
      }
    }
  }

  // The compact row keeps details out of the way: description + default live in
  // the label's tooltip.
  const tooltip = [
    field.description,
    field.default !== undefined ? `default: ${String(field.default)}` : null
  ]
    .filter(Boolean)
    .join(' — ')

  return (
    <div className="proppanel__row grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span
          className="proppanel__name overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-muted-foreground"
          title={tooltip || undefined}
        >
          {field.name}
          {field.required && <span className="proppanel__req ml-0.5 text-red-700">*</span>}
        </span>
        {canReset && (
          <button
            type="button"
            className="proppanel__reset shrink-0 text-[10px] text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            onClick={onReset}
            disabled={busy}
            title={
              field.default !== undefined
                ? `Reset to default (${String(field.default)})`
                : 'Remove this prop from source'
            }
          >
            reset
          </button>
        )}
      </span>
      {control}
    </div>
  )
}
