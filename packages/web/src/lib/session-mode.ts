// Which session modes a conversation row may take (channel-session-mode.md, auto-session-mode.md §3).

/** The daemon runs `auto` conversations (protocol `SESSION_MODE_AUTO_V1_FEATURE`). */
export const SESSION_MODE_AUTO_FEATURE = 'session-mode-auto-v1'

/** Whether a daemon advertising `features` reads `auto`; the Control Plane refuses it otherwise (409 `SESSION_MODE_UNSUPPORTED`). */
export function autoSessionModeSupported(features: readonly string[] | undefined): boolean {
  return features?.includes(SESSION_MODE_AUTO_FEATURE) === true
}
