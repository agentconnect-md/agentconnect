export type OutputMode = 'none' | 'minimal' | 'low' | 'medium' | 'high'

export interface OutputModeOption {
  key: OutputMode
  label: string
  description: string
}

/** Product default for newly-created agents. The daemon uses the same fallback. */
export const DEFAULT_AGENT_OUTPUT_MODE: OutputMode = 'low'

/** What each mode keeps visible in the platform channel. The web session always keeps the
 *  full transcript for auditing, independent of this setting. */
export const OUTPUT_MODE_OPTIONS: readonly OutputModeOption[] = [
  {
    key: 'minimal',
    label: 'Minimal',
    description: 'One live-updating reply that settles on the final answer; interstitial steps stay in the status.'
  },
  {
    key: 'low',
    label: 'Low',
    description: 'Replies and the turn’s plan; other activity stays in the temporary status.'
  },
  { key: 'medium', label: 'Medium', description: 'Low plus tool activity.' },
  { key: 'high', label: 'High', description: 'Medium plus reasoning and tool outputs.' },
  {
    key: 'none',
    label: 'None',
    description: 'Nothing reaches the channel; replies are recorded to the web session only.'
  }
]

/**
 * Copy for the two chrome toggles `OutputModeField` renders beside the mode
 * pills. Platform-free by rule, exactly like {@link OUTPUT_MODE_OPTIONS}:
 * output mode is ONE agent-level setting every integration of that agent obeys,
 * and the field is rendered from the Add/Edit agent modals, where no platform is
 * in scope to resolve copy against — a brand-new agent has no integration yet.
 * Both status-bar sentences used to open with "Slack", so an agent installed
 * only on Telegram read about a product it does not touch.
 *
 * WHY THE "ON" SENTENCE IS QUALIFIED rather than promising a row everywhere.
 * The status row IS per-platform behavior, but the axis lives in the daemon, not
 * here: `packages/daemon/src/platforms/turn-chrome.ts` declares
 * `statusSurface: 'turn-bar'` for Slack and `'on-demand'` for Telegram, Discord
 * and Feishu — on those three the emit path records its dedup key and posts
 * nothing, and session state is answered by the `status` command instead
 * (daemon.ts `emitStatusBar`). So the toggle is honored where a platform has a
 * status surface and is inert where none exists; the copy says that, and names
 * no provider while saying it.
 */
export const OUTPUT_CHROME_COPY = {
  footer: {
    on: 'Replies show the agent, runtime, model, and session links.',
    off: 'No footer is added to replies.'
  },
  statusBar: {
    on: 'Threads show model, context, usage, and session controls on platforms with a status row.',
    off: 'Session status rows are hidden.'
  }
} as const

export function isOutputMode(value: string | null | undefined): value is OutputMode {
  return OUTPUT_MODE_OPTIONS.some((mode) => mode.key === value)
}
