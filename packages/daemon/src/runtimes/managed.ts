import type { RuntimeDef } from '../config/config-schema.js'

export interface ManagedRuntimeEntry {
  name: string
  version: string
  runtime: RuntimeDef
}

/** AgentConnect-maintained runtime builds that intentionally override the public ACP registry.
 *  Explicit operator config remains the final authority. The daemon installs each `npx` spec below
 *  into its own runtime store at start and launches from there, never through `npx` (runtime-store.ts). */
export const MANAGED_RUNTIME_CATALOG: Readonly<Record<string, ManagedRuntimeEntry>> = Object.freeze({
  'codex-acp': {
    name: 'Codex',
    // The ACP probe reports the concrete version resolved by this release channel.
    version: '',
    runtime: {
      command: 'npx',
      // This channel returns PromptResponse.usage as the total-token delta for
      // one ACP prompt, rather than upstream codex-acp's latest model response.
      args: ['-y', '@agentconnect.md/codex-acp@agentconnect'],
      env: []
    }
  }
})
