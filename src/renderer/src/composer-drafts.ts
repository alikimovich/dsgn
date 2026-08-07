import { create } from 'zustand'

/**
 * A pending composer attachment. Images carry base64 bytes + a data URL for the
 * thumbnail (sent as a vision block); files carry only their name + absolute path
 * (folded into the prompt text so the agent reads them itself). An image ALSO
 * carries a path when it came from one — dropped from Finder, that's its real
 * location; pasted from the clipboard, `path` is empty until `send` materializes
 * the bytes (see saveAttachment). Either way the path is named in the prompt, so
 * the agent can copy/move the actual file instead of asking where it lives.
 */
export type Attachment =
  | {
      id: string
      kind: 'image'
      mediaType: string
      data: string
      url: string
      name: string
      path: string
    }
  | { id: string; kind: 'file'; name: string; path: string }

/** What the composer holds for one chat while the user hasn't pressed Enter yet. */
export interface ComposerDraft {
  text: string
  attachments: Attachment[]
}

/** Shared empty values so the selectors below return a STABLE reference for a
 *  chat with nothing pending (a fresh `[]` each read would re-render forever). */
export const NO_ATTACHMENTS: Attachment[] = []
const EMPTY_DRAFT: ComposerDraft = { text: '', attachments: NO_ATTACHMENTS }

/**
 * Unsent composer content, keyed by the same chat key as `useChat.byKey` (a
 * `sessionKey`). ChatPanel is mounted once for the whole app, so holding this in
 * its own component state made a half-written message follow the user from chat
 * to chat. Keying it by chat means switching away parks the text and switching
 * back brings it right there — and a chat you haven't typed in opens blank.
 *
 * Deliberately in-memory only: a draft is scratch state for this app run, and it
 * dies with the chat (`useChat.clearChat` drops it).
 */
interface ComposerDraftState {
  byKey: Record<string, ComposerDraft>
  /** Rewrite one chat's draft (the updater sees its current content). */
  update: (key: string, fn: (draft: ComposerDraft) => ComposerDraft) => void
  /** Forget a chat's draft — it was closed. */
  clear: (key: string) => void
}

export const useComposerDrafts = create<ComposerDraftState>((set) => ({
  byKey: {},
  update: (key, fn) =>
    set((s) => {
      const next = fn(s.byKey[key] ?? EMPTY_DRAFT)
      // Drop a draft that's been emptied (sent, or cleared by hand) so a chat
      // the user never left anything in holds no entry at all.
      if (!next.text && next.attachments.length === 0) {
        if (!(key in s.byKey)) return {}
        const byKey = { ...s.byKey }
        delete byKey[key]
        return { byKey }
      }
      return { byKey: { ...s.byKey, [key]: next } }
    }),
  clear: (key) =>
    set((s) => {
      if (!(key in s.byKey)) return {}
      const byKey = { ...s.byKey }
      delete byKey[key]
      return { byKey }
    })
}))

/** This chat's unsent text (`''` when it has no draft). */
export const draftText = (state: ComposerDraftState, key: string): string =>
  state.byKey[key]?.text ?? ''

/** This chat's pending attachments (a stable empty array when it has none). */
export const draftAttachments = (state: ComposerDraftState, key: string): Attachment[] =>
  state.byKey[key]?.attachments ?? NO_ATTACHMENTS
