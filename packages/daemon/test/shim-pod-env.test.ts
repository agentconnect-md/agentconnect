import { describe, expect, it } from 'vitest'
import { AcpRunner } from '../src/shim/acp-runner.js'

// The sandbox spawns with what the daemon sent PLUS the pod's own filesystem basics. The daemon
// composes the agent's configuration but describes a different machine: it was sending its own
// HOME, and codex then failed with "failed to initialize sqlite state runtime under
// /var/lib/agentconnect/.codex" — a path that exists only on the daemon.

describe('sandbox spawn environment', () => {
  it('takes HOME from the POD when the daemon does not name one', async () => {
    const seen: Array<Record<string, string>> = []
    const runner = new AcpRunner({
      emit: () => {},
      podEnv: { HOME: '/agent', PATH: '/usr/local/bin:/usr/bin', TMPDIR: '/tmp', SANDBOX_SECRET: 'must-not-leak' },
      resolveCommand: (command, env) => {
        seen.push({ ...env })
        return command
      },
      log: { info: () => {}, warn: () => {} }
    } as never)
    await runner.open({ op: 'open', command: 'true', args: [], env: { AC_AGENT_ID: 'a' } } as never).catch(() => {})
    const env = seen.at(-1) ?? {}
    expect(env.HOME).toBe('/agent')
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin')
    // An allowlist, not all of process.env: the pod env can carry provider credentials from the
    // SandboxTemplate, which are forwarded deliberately elsewhere rather than in bulk.
    expect(env.SANDBOX_SECRET).toBeUndefined()
    await runner.close(1_000).catch(() => {})
  })

  it('lets the daemon override a pod value it deliberately set', async () => {
    const seen: Array<Record<string, string>> = []
    const runner = new AcpRunner({
      emit: () => {},
      podEnv: { HOME: '/agent', PATH: '/usr/bin' },
      resolveCommand: (command, env) => {
        seen.push({ ...env })
        return command
      },
      log: { info: () => {}, warn: () => {} }
    } as never)
    await runner
      .open({ op: 'open', command: 'true', args: [], env: { HOME: '/agent/private' } } as never)
      .catch(() => {})
    expect(seen.at(-1)?.HOME).toBe('/agent/private')
    await runner.close(1_000).catch(() => {})
  })
})
