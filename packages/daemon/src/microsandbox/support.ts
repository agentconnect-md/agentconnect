import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SandboxMount } from '../config/config-schema.js'
import { gitcredShimPath } from '../cp/gitcred-server.js'

const GIT_CREDENTIAL_HELPER = '#!/bin/sh\nexec /opt/agentconnect/bin/git-credential "$@"\n'

export function microsandboxSupportMounts(root: string, sessionGitConfigPath?: string): SandboxMount[] {
  const helpers = join(root, 'run', 'microsandbox-helpers')
  mkdirSync(helpers, { recursive: true, mode: 0o700 })
  chmodSync(helpers, 0o700)
  const source = join(helpers, 'git-credential')
  if (!existsSync(source) || readFileSync(source, 'utf8') !== GIT_CREDENTIAL_HELPER) {
    writeFileSync(source, GIT_CREDENTIAL_HELPER, { mode: 0o755 })
  }
  chmodSync(source, 0o755)
  return [
    { source: realpathSync(source), target: gitcredShimPath(root), mode: 'readonly' },
    ...(sessionGitConfigPath && existsSync(sessionGitConfigPath)
      ? [{ source: sessionGitConfigPath, target: sessionGitConfigPath, mode: 'readonly' as const }]
      : [])
  ]
}
