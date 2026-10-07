// A place's effective trust level (assistant-mode.md §5.3): a detected external outranks any declaration, else the editor's word, else the platform's.
import type { PlaceTrustLevel } from '@agentconnect.md/protocol'

/** The stored halves of a place's trust level. */
export interface PlaceTrustState {
  trustDeclared?: PlaceTrustLevel | null
  trustDetected?: PlaceTrustLevel | null
}

/** The effective level, or null when nobody declared and nothing was detected (read as external downstream). */
export function effectivePlaceTrust(row: PlaceTrustState): PlaceTrustLevel | null {
  if (row.trustDetected === 'external') return 'external'
  return row.trustDeclared ?? row.trustDetected ?? null
}

/** Which half the effective level comes from. */
export function placeTrustSource(row: PlaceTrustState): 'declared' | 'detected' | null {
  if (row.trustDetected === 'external') return 'detected'
  if (row.trustDeclared) return 'declared'
  return row.trustDetected ? 'detected' : null
}
