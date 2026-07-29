import { Badge } from '@/components/ui/badge'

/**
 * The Styles panel's presentational shells: a titled group, and the two
 * read-only row shapes. Every row in the panel shares the same two-column
 * grid (`name | control`), so it lives here once.
 */

export function StyleGroup({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="stylepanel__group flex flex-col gap-1">
      <h3 className="stylepanel__grouptitle pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
        {title}
      </h3>
      {children}
    </section>
  )
}

/** The shared `name | control` row shell. */
export function RowShell({
  label,
  title,
  className,
  children
}: {
  label: string
  title?: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={`stylepanel__row grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2${
        className ? ` ${className}` : ''
      }`}
    >
      <span
        className="stylepanel__name select-none overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-muted-foreground"
        title={title ?? label}
      >
        {label}
      </span>
      {children}
    </div>
  )
}

/** Read-only value row (mono-ish readout; used for non-numeric text). */
export function ReadoutRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <RowShell label={label} className="stylepanel__row--readonly">
      <span
        className="stylepanel__readout max-w-[128px] justify-self-end overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground/80"
        title={value}
      >
        {value}
      </span>
    </RowShell>
  )
}

/** Read-only chip row (font-family / display). */
export function ChipRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <RowShell label={label} className="stylepanel__row--chip">
      <Badge
        variant="secondary"
        className="stylepanel__chip max-w-[128px] justify-self-end font-normal"
        title={value}
      >
        <span className="truncate">{value}</span>
      </Badge>
    </RowShell>
  )
}
