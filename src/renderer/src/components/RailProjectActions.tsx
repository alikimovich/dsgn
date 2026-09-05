import { Brain, Ellipsis, SquarePen, X } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/dropdown-menu'

const actionClass =
  'flex size-6 shrink-0 items-center justify-center rounded border-0 bg-transparent text-inherit opacity-0 pointer-events-none transition-opacity group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto data-[state=open]:opacity-100 data-[state=open]:pointer-events-auto hover:bg-accent focus-visible:outline focus-visible:outline-2 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto'

export default function RailProjectActions({
  name,
  onMemory,
  onRemove,
  onNewChat
}: {
  name: string
  onMemory: () => void
  onRemove: () => void
  onNewChat: () => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-0.5 pr-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={`rail__project-menu ${actionClass}`}
            aria-label={`Actions for ${name}`}
            title="Project actions"
          >
            <Ellipsis className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onMemory}>
            <Brain aria-hidden="true" />
            Memory
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onRemove}>
            <X aria-hidden="true" />
            Remove project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        className={`rail__new-chat ${actionClass}`}
        onClick={onNewChat}
        aria-label={`Start another chat for ${name}`}
        title="New chat"
      >
        <SquarePen className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}
