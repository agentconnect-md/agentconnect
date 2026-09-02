import { describe, expect, it } from 'vitest'
import { AcpRunner, ghWrapperPath, type ResolveCommand } from '../src/shim/acp-runner.js'
import { SANDBOX_BROWSER_EXECUTABLE_ENV, SANDBOX_GH_WRAPPER_DIR } from '../src/shim/sandbox-paths.js'

// The sandbox spawns with what the daemon sent PLUS the pod's own filesystem basics. The daemon
// composes the agent's configuration but describes a different machine: it was sending its own
// HOME, and codex then failed with "failed to initialize sqlite state runtime under
// /var/lib/agentconnect/.codex" — a path that exists only on the daemon.

/** The runner's own open path, which is private: these tests drive it directly rather than over a channel. */
const openOf = (runner: AcpRunner): ((payload: unknown) => Promise<void>) =>
  (runner as unknown as { open(payload: unknown): Promise<void> }).open.bind(runner)

describe('sandbox spawn environment', () => {
  it('takes HOME from the POD when the daemon does not name one', async () => {
    const seen: Array<Record<string, string>> = []
    const runner = new AcpRunner({
      emit: () => {},
      podEnv: { HOME: '/agent', PATH: '/usr/local/bin:/usr/bin', TMPDIR: '/tmp', SANDBOX_SECRET: 'must-not-leak' },
      resolveCommand: ((command, env) => {
        seen.push({ ...env })
        return command
      }) satisfies ResolveCommand,
      log: { info: () => {}, warn: () => {} }
    } as never)
    await openOf(runner)({ op: 'open', command: 'true', args: [], env: { AC_AGENT_ID: 'a' } }).catch(() => {})
    const env = seen.at(-1) ?? {}
    expect(env.HOME).toBe('/agent')
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin')
    // An allowlist, not all of process.env: the pod env can carry provider credentials from the
    // SandboxTemplate, which are forwarded deliberately elsewhere rather than in bulk.
    expect(env.SANDBOX_SECRET).toBeUndefined()
    await runner.close(1_000).catch(() => {})
  })

  // The image bakes Chrome and names it in the pod env, but the child is spawned from an allowlist — so without
  // this projection agent-browser sees no browser and downloads its own onto the workspace volume.
  it("projects the pod's baked-browser path onto the child", async () => {
    const seen: Array<Record<string, string>> = []
    const runner = new AcpRunner({
      emit: () => {},
      podEnv: {
        HOME: '/agent',
        PATH: '/usr/bin',
        [SANDBOX_BROWSER_EXECUTABLE_ENV]: '/opt/agentconnect/browser/chrome'
      },
      resolveCommand: ((command, env) => {
        seen.push({ ...env })
        return command
      }) satisfies ResolveCommand,
      log: { info: () => {}, warn: () => {} }
    } as never)
    await openOf(runner)({ op: 'open', command: 'true', args: [], env: {} }).catch(() => {})
    expect(seen.at(-1)?.[SANDBOX_BROWSER_EXECUTABLE_ENV]).toBe('/opt/agentconnect/browser/chrome')
    await runner.close(1_000).catch(() => {})
  })

  // An image that ships no baked browser must not gain an env naming one, and a daemon that named a browser
  // deliberately stays authoritative — the same fill-in rule the provider pairs follow.
  it('leaves the baked-browser path alone when the image ships none or the daemon sent one', async () => {
    const seen: Array<Record<string, string>> = []
    const runnerOf = (podEnv: Record<string, string>) =>
      new AcpRunner({
        emit: () => {},
        podEnv,
        resolveCommand: ((command, env) => {
          seen.push({ ...env })
          return command
        }) satisfies ResolveCommand,
        log: { info: () => {}, warn: () => {} }
      } as never)
    const bare = runnerOf({ HOME: '/agent', PATH: '/usr/bin' })
    await openOf(bare)({ op: 'open', command: 'true', args: [], env: {} }).catch(() => {})
    expect(seen.at(-1)?.[SANDBOX_BROWSER_EXECUTABLE_ENV]).toBeUndefined()
    await bare.close(1_000).catch(() => {})
    const both = runnerOf({ HOME: '/agent', PATH: '/usr/bin', [SANDBOX_BROWSER_EXECUTABLE_ENV]: '/opt/baked' })
    await openOf(both)({
      op: 'open',
      command: 'true',
      args: [],
      env: { [SANDBOX_BROWSER_EXECUTABLE_ENV]: '/sent/by/daemon' }
    }).catch(() => {})
    expect(seen.at(-1)?.[SANDBOX_BROWSER_EXECUTABLE_ENV]).toBe('/sent/by/daemon')
    await both.close(1_000).catch(() => {})
  })

  it('lets the daemon override a pod value it deliberately set', async () => {
    const seen: Array<Record<string, string>> = []
    const runner = new AcpRunner({
      emit: () => {},
      podEnv: { HOME: '/agent', PATH: '/usr/bin' },
      resolveCommand: ((command, env) => {
        seen.push({ ...env })
        return command
      }) satisfies ResolveCommand,
      log: { info: () => {}, warn: () => {} }
    } as never)
    await openOf(runner)({ op: 'open', command: 'true', args: [], env: { HOME: '/agent/private' } }).catch(() => {})
    expect(seen.at(-1)?.HOME).toBe('/agent/private')
    await runner.close(1_000).catch(() => {})
  })

  // `gh` reads a static GH_TOKEN fixed at spawn, so a pod agent gets per-repo tokens only when the image's
  // wrapper is what PATH resolves first. The dir is the IMAGE's, so the decision is made here rather than sent
  // by a daemon that would be naming a path on a machine it is not on.
  it('puts the image gh wrapper first on PATH when this image ships one', () => {
    expect(ghWrapperPath('/usr/local/bin:/usr/bin', () => true)).toBe(
      `${SANDBOX_GH_WRAPPER_DIR}:/usr/local/bin:/usr/bin`
    )
    // A PATH the daemon already sent may name it; the wrapper must still be first, and only once.
    expect(ghWrapperPath(`/usr/bin:${SANDBOX_GH_WRAPPER_DIR}`, () => true)).toBe(`${SANDBOX_GH_WRAPPER_DIR}:/usr/bin`)
    expect(ghWrapperPath(undefined, () => true)).toBe(SANDBOX_GH_WRAPPER_DIR)
  })

  it('leaves PATH exactly as it was on an image with no wrapper', () => {
    expect(ghWrapperPath('/usr/local/bin:/usr/bin', () => false)).toBe('/usr/local/bin:/usr/bin')
    expect(ghWrapperPath(undefined, () => false)).toBeUndefined()
  })
})
