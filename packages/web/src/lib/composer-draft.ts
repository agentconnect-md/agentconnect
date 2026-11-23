// A composer's unsent text, kept in this tab's sessionStorage so a full-page round trip (a hosted checkout) does not lose it.
const PREFIX = 'ac.composerDraft.'

/** The storage key for a session's draft: an unsent `pg_<agentId>_<uuid>` page is keyed by its agent, because a reload mints a new id. */
export function composerDraftKey(sessionId: string): string {
  if (sessionId.startsWith('pg_')) {
    const end = sessionId.lastIndexOf('_')
    if (end > 3) return `${PREFIX}pg:${sessionId.slice(3, end)}`
  }
  return `${PREFIX}s:${sessionId}`
}

export function readComposerDraft(sessionId: string): string {
  try {
    return globalThis.sessionStorage?.getItem(composerDraftKey(sessionId)) ?? ''
  } catch {
    return ''
  }
}

/** Store the draft, or forget it when it is empty. */
export function writeComposerDraft(sessionId: string, text: string): void {
  try {
    const storage = globalThis.sessionStorage
    if (!storage) return
    if (text.trim()) storage.setItem(composerDraftKey(sessionId), text)
    else storage.removeItem(composerDraftKey(sessionId))
  } catch {
    /* storage unavailable: the draft stays in memory only */
  }
}

/** Hand a stored draft to the session a page reopened as, unless that session already holds one. */
export function moveComposerDraft(from: string, to: string): void {
  if (composerDraftKey(from) === composerDraftKey(to)) return
  const text = readComposerDraft(from)
  if (!text) return
  if (!readComposerDraft(to)) writeComposerDraft(to, text)
  writeComposerDraft(from, '')
}
