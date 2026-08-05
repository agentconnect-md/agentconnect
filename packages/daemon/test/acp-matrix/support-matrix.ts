// The support matrix: for each (feature, profile) cell, what the daemon is expected
// to do. Derived from the profile's declared capabilities so it can never drift out
// of sync with profiles.ts.
//
//   'run'     — the capability is present; assert the feature works.
//   'degrade' — the capability is ABSENT; assert the daemon no-ops gracefully
//               (never throws, never hangs) rather than crashing.
import type { Profile } from './profiles.js'

export type Verdict = 'run' | 'degrade'

export type FeatureId =
  | 'capabilities'
  | 'lifecycle'
  | 'model-switch'
  | 'permission-mode-switch'
  | 'load-resume'
  | 'interactive-permission'
  | 'usage-fold'
  | 'memory'
  | 'sandbox'
  | 'mcp'
  | 'skills'

export function verdictFor(feature: FeatureId, p: Profile): Verdict {
  switch (feature) {
    // Universal features: every ACP agent must handle these.
    case 'capabilities':
    case 'lifecycle':
    case 'interactive-permission':
    case 'sandbox':
    case 'memory':
      return 'run'
    case 'model-switch':
      return (p.caps.models?.length ?? 0) >= 2 ? 'run' : 'degrade'
    case 'permission-mode-switch':
      return (p.caps.permissionModes?.length ?? 0) >= 2 ? 'run' : 'degrade'
    case 'load-resume':
      return p.caps.loadSession ? 'run' : 'degrade'
    case 'usage-fold':
      return p.caps.usage ? 'run' : 'degrade'
    case 'mcp':
      return p.caps.mcp.http || p.caps.mcp.sse ? 'run' : 'degrade'
    case 'skills':
      return p.caps.skillsAgentId ? 'run' : 'degrade'
  }
}

export const FEATURES: FeatureId[] = [
  'capabilities',
  'lifecycle',
  'model-switch',
  'permission-mode-switch',
  'load-resume',
  'interactive-permission',
  'usage-fold',
  'memory',
  'sandbox',
  'mcp',
  'skills'
]
