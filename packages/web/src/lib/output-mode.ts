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
  { key: 'low', label: 'Low', description: 'Replies only; activity stays in the temporary status.' },
  { key: 'medium', label: 'Medium', description: 'Low plus tool activity and plans.' },
  { key: 'high', label: 'High', description: 'Medium plus reasoning and tool outputs.' },
  {
    key: 'none',
    label: 'None',
    description: 'Nothing reaches the channel; replies are recorded to the web session only.'
  }
]

export function isOutputMode(value: string | null | undefined): value is OutputMode {
  return OUTPUT_MODE_OPTIONS.some((mode) => mode.key === value)
}
