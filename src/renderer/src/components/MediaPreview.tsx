import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { SourceView } from '../../../shared/api'

/**
 * What the code editor shows in place of CodeMirror when the opened file isn't
 * text: an image / video / audio player for previewable media, or a plain
 * placeholder for other binaries (fonts, archives). `view.media.url` is a
 * `praxis-media://` URL main streams from disk — nothing is base64'd over IPC.
 */

/** Human-readable file size for the footer (1.4 MB, 812 KB, 90 B). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** Transparency checkerboard, so a PNG's alpha reads as alpha and not as page. */
const CHECKER: React.CSSProperties = {
  backgroundImage:
    'conic-gradient(from 90deg at 50% 50%, rgba(128,128,128,0.16) 25%, transparent 0 50%, rgba(128,128,128,0.16) 0 75%, transparent 0)',
  backgroundSize: '16px 16px'
}

export default function MediaPreview({ view }: { view: SourceView }): React.JSX.Element {
  const media = view.media
  // Images default to fit-in-view; 1:1 shows real pixels (scrollable when big).
  const [actualSize, setActualSize] = useState(false)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [failed, setFailed] = useState(false)

  const facts = [
    dims ? `${dims.w} × ${dims.h}` : null,
    view.bytes != null ? formatBytes(view.bytes) : null,
    media?.mediaType ?? 'binary'
  ].filter(Boolean)

  const body = ((): React.JSX.Element => {
    if (!media || failed) {
      return (
        <p className="codedrawer__binary px-6 text-center text-[11.5px] text-muted-foreground">
          {failed
            ? 'This file could not be decoded for preview.'
            : 'Binary file — not shown in the editor.'}
        </p>
      )
    }
    if (media.kind === 'image') {
      return (
        <img
          src={media.url}
          alt={view.file}
          className={
            actualSize ? 'max-w-none' : 'max-h-full max-w-full object-contain drop-shadow-sm'
          }
          style={CHECKER}
          onLoad={(e) =>
            setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
          onError={() => setFailed(true)}
        />
      )
    }
    if (media.kind === 'video') {
      return (
        <video
          src={media.url}
          controls
          className="codedrawer__video max-h-full max-w-full"
          onLoadedMetadata={(e) =>
            setDims({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })
          }
          onError={() => setFailed(true)}
        />
      )
    }
    return (
      <audio
        src={media.url}
        controls
        className="codedrawer__audio w-full max-w-md"
        onError={() => setFailed(true)}
      />
    )
  })()

  return (
    <div className="codedrawer__media flex min-h-0 flex-1 flex-col">
      <div
        className={`flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-4 ${
          actualSize ? 'overflow-auto' : 'overflow-hidden'
        }`}
      >
        {body}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t px-3 py-1.5">
        <span className="codedrawer__mediafacts min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-muted-foreground">
          {facts.join(' · ')}
        </span>
        {media?.kind === 'image' && !failed && (
          <Button
            variant="ghost"
            size="sm"
            className="codedrawer__zoom h-6 px-2 text-[11.5px] text-muted-foreground"
            onClick={() => setActualSize((v) => !v)}
            title={actualSize ? 'Fit the image to the view' : 'Show the image at 100%'}
          >
            {actualSize ? 'Fit' : '1:1'}
          </Button>
        )}
      </div>
    </div>
  )
}
