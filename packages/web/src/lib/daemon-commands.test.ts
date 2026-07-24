import { describe, it, expect } from 'vitest'
import { daemonCommands } from './daemon-commands'

const RUN = 'run --cp-url wss://cp.example.com/cp/daemon/ws --cp-key test-api-key'
const LOGIN = RUN.replace(/^run\b/, 'login')

describe('daemonCommands', () => {
  it('rewrites the default (untagged) command to latest-CLI install + run/login', () => {
    const c = daemonCommands(`npx -y @agentconnect.md/daemon ${RUN}`)
    expect(c.install).toBe('npx -y @agentconnect.md/cli install --channel stable')
    expect(c.run).toBe(`npx -y @agentconnect.md/cli ${RUN}`)
    expect(c.login).toBe(`npx -y @agentconnect.md/cli ${LOGIN}`)
  })

  it('pins the CLI package to @rc AND the daemon install to the rc channel', () => {
    const c = daemonCommands(`npx -y @agentconnect.md/daemon@rc ${RUN}`)
    // Every command must run the rc CLI so it contains rc-only behavior (install).
    expect(c.install).toBe('npx -y @agentconnect.md/cli@rc install --channel rc')
    expect(c.run).toBe(`npx -y @agentconnect.md/cli@rc ${RUN}`)
    expect(c.login).toBe(`npx -y @agentconnect.md/cli@rc ${LOGIN}`)
  })

  it('maps stable dist-tag to the latest CLI + stable channel', () => {
    const c = daemonCommands(`npx -y @agentconnect.md/daemon@stable ${RUN}`)
    expect(c.install).toBe('npx -y @agentconnect.md/cli install --channel stable')
    expect(c.run).toBe(`npx -y @agentconnect.md/cli ${RUN}`)
  })

  it('treats an exact version pin as `install <version>` and never pins the CLI to it', () => {
    const c = daemonCommands(`npx -y @agentconnect.md/daemon@1.4.2 ${RUN}`)
    expect(c.install).toBe('npx -y @agentconnect.md/cli install 1.4.2')
    // CLI resolves from latest — it is never pinned to a daemon version.
    expect(c.run).toBe(`npx -y @agentconnect.md/cli ${RUN}`)
    expect(c.run).not.toContain('1.4.2')
  })

  it('degrades gracefully on an unexpected command shape', () => {
    const c = daemonCommands('weird command without the daemon pkg')
    // Falls back to a stable install and does not throw.
    expect(c.install).toBe('npx -y @agentconnect.md/cli install --channel stable')
    expect(c.run.startsWith('npx -y @agentconnect.md/cli ')).toBe(true)
  })
})
