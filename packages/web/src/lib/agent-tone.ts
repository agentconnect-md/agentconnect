// The accent hue a given agent speaks in. Transcript bubbles are tinted with it so
// a multi-agent thread can be read by colour before it is read by name — the same
// job orgColor() does for org avatars, and the same deterministic-hash approach, so
// an agent keeps its colour across sessions, reloads, and viewers without the CP
// having to store one.
//
// These are ACCENTS, not backgrounds: the consumer mixes them into the current
// surface (see `.abub` in globals.css), which is what lets one hex work in both
// themes. Nothing here may return a ready-made background, or dark mode would need
// a second table.

/** Design-system hues, spaced far enough apart to be told apart at a 7% tint.
 * Deliberately no warm hues: gold and coral tinted a bubble into something that
 * read as a warning/error banner rather than as an agent's colour. */
const AGENT_TONES = [
  'var(--magenta-500)',
  'var(--purple-500)',
  'var(--indigo-500)',
  'var(--blue-500)',
  'var(--teal-500)',
  'var(--green-500)'
] as const

/**
 * The agent's accent, keyed by whatever identity the caller has. Pass the agent id
 * when there is one; a transcript row that predates its agent (or a mock/playground
 * row) can pass the display name instead — stable within that session, which is all
 * the colour is claiming.
 */
export function agentToneColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return AGENT_TONES[h % AGENT_TONES.length]!
}

export const AGENT_TONE_COUNT = AGENT_TONES.length
