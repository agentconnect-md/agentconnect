import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Set by a daemon-run upgrade: `1` when an agent of the running daemon runs in microsandbox, `0` when none does. */
export const MICROSANDBOX_IN_USE_ENV = 'AGENTCONNECT_MICROSANDBOX_IN_USE'

/** Whether an upgrade pre-pulls the next image: the running daemon's agents decide, and without that answer only a machine that pulled before does. */
export function wantsImagePrePull(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const inUse = env[MICROSANDBOX_IN_USE_ENV]
  if (inUse === '1') return true
  if (inUse === '0') return false
  return existsSync(join(root, 'microsandbox', 'pulled-image'))
}
