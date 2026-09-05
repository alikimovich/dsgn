import { useEffect } from 'react'
import { useComposer, useSession } from './store'

/** Keep preview-originated moves available even when the Layers panel is closed. */
export function usePreviewReorder(
  onError: (status: { kind: 'error'; message: string }) => void
): void {
  useEffect(
    () =>
      window.api.layers.onMoveRequest((request) => {
        const root = useSession.getState().projectRoot
        if (!root) return
        void window.api.layers
          .move(root, request)
          .then((result) => {
            if (useSession.getState().projectRoot !== root) return
            if (result.needsAgent) useComposer.getState().setSeed(result.agentPrompt ?? null)
            else if (result.error) onError({ kind: 'error', message: result.error })
          })
          .catch((error: unknown) => {
            if (useSession.getState().projectRoot === root)
              onError({ kind: 'error', message: String(error) })
          })
      }),
    [onError]
  )
}
