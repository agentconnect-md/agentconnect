import { describe, it, expect } from 'vitest'
import { daemonCommands } from './daemon-commands'

const RUN = 'run --api-url wss://cp.example.com/cp/daemon/ws --api-key test-api-key'
const LOGIN = RUN.replace(/^run\b/, 'login')

describe('daemonCommands', () => {
  it('rewrites the default command to single-step latest-CLI run/login', () => {
    const c = daemonCommands(`npx -y @agentconnect.md/daemon ${RUN}`)
    expect(c.run).toBe(`npx -y @agentconnect.md/cli ${RUN}`)
    expect(c.login).toBe(`npx -y @agentconnect.md/cli ${LOGIN}`)
  })

  it('pins the CLI package to @rc so its first run bootstraps the rc daemon channel', () => {
    const c = daemonCommands(`npx -y @agentconnect.md/daemon@rc ${RUN}`)
    expect(c.run).toBe(`npx -y @agentconnect.md/cli@rc ${RUN}`)
    expect(c.login).toBe(`npx -y @agentconnect.md/cli@rc ${LOGIN}`)
  })

  it('maps stable dist-tag to the latest CLI + stable channel', () => {
    const c = daemonCommands(`npx -y @agentconnect.md/daemon@stable ${RUN}`)
    expect(c.run).toBe(`npx -y @agentconnect.md/cli ${RUN}`)
  })

  it('keeps an exact daemon version as an inline install before connecting', () => {
    const c = daemonCommands(`npx -y @agentconnect.md/daemon@1.4.2 ${RUN}`)
    const install = 'npx -y @agentconnect.md/cli install 1.4.2'
    expect(c.run).toBe(`${install} && npx -y @agentconnect.md/cli ${RUN}`)
    expect(c.login).toBe(`${install} && npx -y @agentconnect.md/cli ${LOGIN}`)
  })

  it('degrades gracefully on an unexpected command shape', () => {
    const c = daemonCommands('weird command without the daemon pkg')
    expect(c.run.startsWith('npx -y @agentconnect.md/cli ')).toBe(true)
  })
})
