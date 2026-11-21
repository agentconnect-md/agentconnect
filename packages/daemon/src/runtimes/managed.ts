import type { RuntimeDef } from '../config/config-schema.js'

export interface ManagedRuntimeEntry {
  name: string
  version: string
  runtime: RuntimeDef
}

// Reviewed runtime launchers that override the public ACP registry; explicit operator config still wins.
export const MANAGED_RUNTIME_CATALOG: Readonly<Record<string, ManagedRuntimeEntry>> = Object.freeze({
  'antigravity-acp': {
    name: 'Google Antigravity',
    version: '',
    runtime: { command: 'agy', args: ['acp'], env: [] }
  },
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
