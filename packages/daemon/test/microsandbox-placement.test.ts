import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentHostKey, hostKeyDirName, hostKeySessionKey, sessionHostKey, type HostKey } from '../src/acp/host-key.js'
import type { StrategyLauncher } from '../src/execution/strategies.js'
import { prepareMicrosandboxLaunch } from '../src/microsandbox/launch.js'
import { localMicrosandboxEnvironment, localMicrosandboxPlacement } from '../src/microsandbox/placement.js'

const AGENT = 'bot-a'
const SESSION = 'session-0123456789abcdef01234567'
const KEY = sessionHostKey(AGENT, 'slack:C1:1700000000.000100:bot-a')
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }

// session-executors.md §11 step 3: identities do not change, so every existing VM, disk and binding is adopted as it is.
describe('the local microsandbox placement', () => {
  const agentDir = join('/srv', 'agents', AGENT)
  const sessionDir = join(agentDir, 'sessions', SESSION)

  it('gives a session-isolated session its own VM over its own directory, ahead of any legacy rule', () => {
    for (const hostKey of [undefined, KEY]) {
      expect(
        localMicrosandboxPlacement({
          agentId: AGENT,
          agentDir,
          cwd: join(sessionDir, 'workspace'),
          hostKey,
          legacy: true
        })
      ).toEqual({ id: `${AGENT}/${SESSION}`, trustedSessionDir: sessionDir })
    }
  })

  it("keeps a retained legacy session on the agent's VM and HOME", () => {
    const cwd = join(agentDir, 'workspace')
    expect(localMicrosandboxPlacement({ agentId: AGENT, agentDir, cwd, hostKey: KEY, legacy: true })).toEqual({
      id: `${AGENT}/agent`,
      homeKey: agentHostKey(AGENT)
    })
  })

  it('puts any other launch on the VM of its host key', () => {
    const cwd = join(agentDir, 'workspace')
    expect(localMicrosandboxPlacement({ agentId: AGENT, agentDir, cwd })).toEqual({ id: `${AGENT}/agent` })
    expect(localMicrosandboxPlacement({ agentId: AGENT, agentDir, cwd, hostKey: agentHostKey(AGENT) })).toEqual({
      id: `${AGENT}/agent`
    })
    expect(localMicrosandboxPlacement({ agentId: AGENT, agentDir, cwd, hostKey: KEY })).toEqual({
      id: `${AGENT}/${hostKeyDirName(KEY)}`
    })
    // A leaf under `sessions/` that is not a session's is no session VM.
    expect(
      localMicrosandboxPlacement({ agentId: AGENT, agentDir, cwd: join(agentDir, 'sessions', 'scratch'), hostKey: KEY })
    ).toEqual({ id: `${AGENT}/${hostKeyDirName(KEY)}` })
  })
})

// VM mount preparation needs POSIX guest paths.
describe.skipIf(process.platform === 'win32')('the local environment descriptor', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function scaffold() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-msp-')))
    roots.push(root)
    const agentDir = join(root, 'agents', AGENT)
    const sessionDir = join(agentDir, 'sessions', SESSION)
    for (const dir of [join(agentDir, 'workspace'), join(sessionDir, 'workspace'), join(root, 'host')])
      mkdirSync(dir, { recursive: true })
    return { agentDir, sessionDir, hostEnv: { HOME: join(root, 'host') } }
  }

  const cases: Array<{
    name: string
    cwd: 'session' | 'workspace'
    hostKey?: HostKey
    legacy?: boolean
    id: string
    writable: (agentDir: string, sessionDir: string) => string
  }> = [
    {
      name: 'a session-isolated session',
      cwd: 'session',
      hostKey: KEY,
      id: `${AGENT}/${SESSION}`,
      writable: (_, sessionDir) => sessionDir
    },
    { name: "the agent's shared host", cwd: 'workspace', id: `${AGENT}/agent`, writable: (dir) => join(dir, 'home') },
    {
      name: 'a session host in the shared workspace',
      cwd: 'workspace',
      hostKey: KEY,
      id: `${AGENT}/${hostKeyDirName(KEY)}`,
      writable: (dir) => join(dir, 'runtime-homes', hostKeyDirName(KEY), 'home')
    },
    {
      name: 'a retained legacy session',
      cwd: 'workspace',
      hostKey: KEY,
      legacy: true,
      id: `${AGENT}/agent`,
      writable: (dir) => join(dir, 'home')
    }
  ]

  it.each(cases)("is today's environment for $name, with the agent's own mounts", (entry) => {
    const { agentDir, sessionDir, hostEnv } = scaffold()
    const cwd = entry.cwd === 'session' ? join(sessionDir, 'workspace') : join(agentDir, 'workspace')
    const placement = localMicrosandboxPlacement({
      agentId: AGENT,
      agentDir,
      cwd,
      ...(entry.hostKey ? { hostKey: entry.hostKey, legacy: entry.legacy === true } : {})
    })
    // The launch composition as the daemon feeds it from the placement.
    const launch = prepareMicrosandboxLaunch({
      runtimeId: 'test',
      scopeDir: agentDir,
      cwd:
        placement.trustedSessionDir ??
        (entry.hostKey && hostKeySessionKey(entry.hostKey) && !placement.homeKey ? cwd : join(agentDir, 'workspace')),
      ...(entry.hostKey ? { hostKey: entry.hostKey } : {}),
      ...(placement.trustedSessionDir ? { trustedSessionDir: placement.trustedSessionDir } : {}),
      ...(placement.homeKey ? { homeKey: placement.homeKey } : {}),
      mounts: [],
      stateSourceEnv: hostEnv
    })
    const environment = localMicrosandboxEnvironment(placement.id, launch.microsandbox)

    // Field for field what the local path built before, since a VM's spec hashes every one of them.
    expect(environment).toStrictEqual({ id: placement.id, ...launch.microsandbox })
    expect(environment.id).toBe(entry.id)
    expect(environment.workspaceRoot).toBe(agentDir)
    const writable = entry.writable(agentDir, sessionDir)
    expect(environment.mounts).toContainEqual({ source: writable, target: writable, mode: 'writable' })
    // Its shim is bound here, never exposed: no local environment is a hosted one.
    expect(environment.hosted).toBeUndefined()
    // The launcher takes it as it is, which is what lets the in-process entry pass it straight through.
    const input: Parameters<StrategyLauncher['start']>[0] = { environment, log: quiet }
    expect(input.environment).toBe(environment)
  })
})
