import { describe, it, expect, vi } from 'vitest'
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  curatedProbeEnvironment,
  probeRuntime,
  probeAllRuntimes,
  probeTimeoutMs,
  sweepStaleProbeRoots,
  type ProbeHostPolicy
} from '../src/runtimes/runtime-prober.js'
import { modelOptionsFrom } from '../src/acp/acp-host.js'
import type { AcpProbeClient } from '../src/acp/probe-client.js'
import type { RuntimeDef } from '../src/config/config-schema.js'

const rt: RuntimeDef = { command: 'npx', args: ['-y', 'pkg'], env: [] }

/** Minimal probe client — only the methods the prober calls. */
function fakeHost(behavior: {
  start?: () => Promise<void>
  newSession?: () => Promise<string>
  models?: ReturnType<AcpProbeClient['modelOptions']>
  acp?: number
  mcp?: ReturnType<NonNullable<AcpProbeClient['mcpCapabilities']>>
  agentInfo?: { name: string; title?: string; version?: string }
  onStop?: () => void
}): AcpProbeClient {
  return {
    start: behavior.start ?? (async () => {}),
    newSession: behavior.newSession ?? (async () => 'sess-1'),
    modelOptions: () => behavior.models ?? null,
    acpProtocolVersion: () => behavior.acp,
    mcpCapabilities: () => behavior.mcp ?? null,
    acpAgentInfo: () => behavior.agentInfo,
    stop: async () => {
      behavior.onStop?.()
    }
  }
}

const successfulHost = (newSession = vi.fn(async () => 'sess-1')) => fakeHost({ newSession })

describe('modelOptionsFrom', () => {
  it('extracts a flat model selector', () => {
    const opts = modelOptionsFrom([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'sonnet',
        options: [
          { value: 'sonnet', name: 'Sonnet' },
          { value: 'opus', name: 'Opus' }
        ]
      } as never
    ])
    expect(opts).toEqual({ current: 'sonnet', models: ['sonnet', 'opus'] })
  })

  it('flattens grouped options', () => {
    const opts = modelOptionsFrom([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'a',
        options: [
          { group: 'g1', name: 'Group 1', options: [{ value: 'a', name: 'A' }] },
          { group: 'g2', name: 'Group 2', options: [{ value: 'b', name: 'B' }] }
        ]
      } as never
    ])
    expect(opts?.models).toEqual(['a', 'b'])
  })

  it('ignores non-model and boolean options, returns null when absent', () => {
    expect(modelOptionsFrom(null)).toBeNull()
    expect(
      modelOptionsFrom([
        { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'x', options: [] } as never
      ])
    ).toBeNull()
    expect(
      modelOptionsFrom([
        { id: 'think', name: 'Think', category: 'model', type: 'boolean', currentValue: true } as never
      ])
    ).toBeNull()
  })
})

describe('probeRuntime', () => {
  it('reports models on success and tears the host down', async () => {
    const onStop = vi.fn()
    const host = fakeHost({ models: { current: 'sonnet', models: ['sonnet', 'opus'] }, acp: 1, onStop })
    const res = await probeRuntime('claude-acp', rt, '/tmp/x', { hostFactory: () => host })
    expect(res).toEqual({
      runtime: 'claude-acp',
      ok: true,
      models: ['sonnet', 'opus'],
      currentModel: 'sonnet',
      acpProtocolVersion: 1
    })
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('captures the probed adapter version from agentInfo', async () => {
    const host = fakeHost({
      models: { current: 'sonnet', models: ['sonnet'] },
      acp: 1,
      agentInfo: { name: '@agentclientprotocol/claude-agent-acp', title: 'Claude Agent', version: '0.59.0' }
    })
    const res = await probeRuntime('claude-acp', rt, '/tmp/x', { hostFactory: () => host })
    expect(res.ok).toBe(true)
    expect(res.probedVersion).toBe('0.59.0')
  })

  it('leaves probedVersion undefined when the agent reports no agentInfo', async () => {
    const host = fakeHost({ models: { current: 'sonnet', models: ['sonnet'] }, acp: 1 })
    const res = await probeRuntime('claude-acp', rt, '/tmp/x', { hostFactory: () => host })
    expect(res.probedVersion).toBeUndefined()
  })

  it('surfaces a runtime-advertised literal "default" model verbatim (never synthesized, never dropped)', async () => {
    const host = fakeHost({ models: { current: 'default', models: ['default', 'gpt-5.3-codex', 'gpt-5.3'] } })
    const res = await probeRuntime('codex-acp', rt, '/tmp/x', { hostFactory: () => host })
    expect(res.ok).toBe(true)
    expect(res.models).toEqual(['default', 'gpt-5.3-codex', 'gpt-5.3'])
  })

  it('captures the MCP transport caps advertised at initialize', async () => {
    const host = fakeHost({ models: null, mcp: { http: true, sse: false } })
    const res = await probeRuntime('claude-acp', rt, '/tmp/x', { hostFactory: () => host })
    expect(res.ok).toBe(true)
    expect(res.mcpCapabilities).toEqual({ http: true, sse: false })
  })

  it('omits MCP caps when the host reports none (older fake hosts)', async () => {
    const res = await probeRuntime('bare', rt, '/tmp/x', { hostFactory: () => fakeHost({}) })
    expect(res.ok).toBe(true)
    expect(res.mcpCapabilities).toBeUndefined()
  })

  it('treats a session with no model selector as ok with empty models', async () => {
    const res = await probeRuntime('deepagents', rt, '/tmp/x', { hostFactory: () => fakeHost({ models: null }) })
    expect(res.ok).toBe(true)
    expect(res.models).toEqual([])
  })

  it('captures a launch failure without throwing, still tearing down', async () => {
    const onStop = vi.fn()
    const host = fakeHost({
      start: async () => {
        throw new Error('spawn ENOENT')
      },
      onStop
    })
    const res = await probeRuntime('broken', rt, '/tmp/x', { hostFactory: () => host })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('ENOENT')
    expect(res.models).toEqual([])
    expect(res.authRequired).toBeUndefined()
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('flags an ACP auth-required rejection (-32000) as authRequired', async () => {
    const host = fakeHost({
      // Exactly what claude-acp / codex-acp reject session/new with when logged
      // out: the SDK's RequestError.authRequired (JSON-RPC -32000).
      newSession: async () => {
        throw Object.assign(new Error('Authentication required'), { code: -32000 })
      }
    })
    const res = await probeRuntime('codex-acp', rt, '/tmp/x', { hostFactory: () => host })
    expect(res.ok).toBe(false)
    expect(res.authRequired).toBe(true)
    expect(res.error).toContain('Authentication required')
  })

  it('keeps other JSON-RPC failures (e.g. -32603) out of authRequired', async () => {
    const host = fakeHost({
      newSession: async () => {
        throw Object.assign(new Error('Internal error'), { code: -32603 })
      }
    })
    const res = await probeRuntime('codex-acp', rt, '/tmp/x', { hostFactory: () => host })
    expect(res.ok).toBe(false)
    expect(res.authRequired).toBeUndefined()
  })

  it('always cancels permissions, declines elicitation, and supplies no MCP servers', async () => {
    const start = vi.fn(async () => {})
    const newSession = vi.fn(async () => 'sess-1')
    let policy: ProbeHostPolicy | undefined
    const res = await probeRuntime('safe', rt, '/tmp/probe/workspace', {
      hostFactory: (_runtime, _id, _cwd, supplied) => {
        policy = supplied
        return fakeHost({ start, newSession })
      }
    })

    expect(res.ok).toBe(true)
    expect(await policy!.onPermission()).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(await policy!.onElicit()).toEqual({ action: 'decline' })
    expect(policy!.suppressChildStderr).toBe(true)
    expect(start).toHaveBeenCalledOnce()
    expect(newSession).toHaveBeenCalledWith('/tmp/probe/workspace', [])
  })

  it('sanitizes credential values and filesystem paths from failures and logs', async () => {
    const warn = vi.fn()
    const secret = 'sk-probe-super-secret'
    const res = await probeRuntime('broken', rt, '/private/probe/workspace', {
      hostEnv: { PATH: '/usr/bin', OPENAI_API_KEY: secret },
      log: { warn } as never,
      hostFactory: () =>
        fakeHost({
          start: async () => {
            throw new Error(`failed ${secret} at /Users/person/.hermes/auth.json`)
          }
        })
    })

    expect(res.error).toContain('[REDACTED]')
    expect(res.error).toContain('<path>')
    expect(res.error).not.toContain(secret)
    expect(res.error).not.toContain('/Users/person')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
  })

  it('redacts credentials seeded from private auth files', async () => {
    const hostHome = mkdtempSync(join(tmpdir(), 'ac-probe-auth-'))
    const hostHermes = join(hostHome, '.hermes')
    const secret = 'file-only-oauth-secret'
    mkdirSync(hostHermes)
    writeFileSync(join(hostHermes, 'auth.json'), JSON.stringify({ token: secret }))

    const results = await probeAllRuntimes(
      { 'hermes-agent': { command: 'hermes', args: ['acp'], env: [] } },
      {
        curated: true,
        hostEnv: { HOME: hostHome, PATH: '/usr/bin' },
        hostFactory: () =>
          fakeHost({
            start: async () => {
              throw new Error(`ACP rejected token ${secret}`)
            }
          })
      }
    )

    expect(results[0]?.error).toContain('[REDACTED]')
    expect(results[0]?.error).not.toContain(secret)
  })

  it('captures private launch preparation failures', async () => {
    const res = await probeRuntime('broken-home', rt, '/tmp/x', {
      hostFactory: () => successfulHost(),
      launchFor: () => {
        throw new Error('runtime HOME unavailable')
      }
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('runtime HOME unavailable')
  })

  it('times out a hung probe', async () => {
    const host = fakeHost({ newSession: () => new Promise<string>(() => {}) }) // never resolves
    const res = await probeRuntime('slow', rt, '/tmp/x', { hostFactory: () => host, timeoutMs: 20 })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('timed out')
  })
})

describe('curatedProbeEnvironment', () => {
  it('canonicalizes case-insensitive Windows process environment keys', () => {
    expect(curatedProbeEnvironment({ Path: 'C:\\bin', PathExt: '.EXE;.CMD', SYSTEMROOT: 'C:\\Windows' })).toEqual({
      PATH: 'C:\\bin',
      PATHEXT: '.EXE;.CMD',
      SystemRoot: 'C:\\Windows'
    })
  })

  it('allows only process/proxy/certificate essentials and scalar provider keys', () => {
    const env = curatedProbeEnvironment({
      PATH: '/usr/bin',
      PATHEXT: '.EXE',
      SystemRoot: 'C:\\Windows',
      HTTPS_PROXY: 'https://proxy.example',
      no_proxy: 'localhost',
      SSL_CERT_FILE: '/etc/certs.pem',
      NODE_EXTRA_CA_CERTS: '/etc/extra.pem',
      OPENAI_API_KEY: 'openai-key',
      ANTHROPIC_API_KEY: 'anthropic-key',
      KIRO_API_KEY: 'kiro-key',
      AWS_SHARED_CREDENTIALS_FILE: '/host/aws',
      GOOGLE_APPLICATION_CREDENTIALS: '/host/google.json',
      KUBECONFIG: '/host/kube',
      HERMES_HOME: '/host/hermes',
      INTERPRETER_HOME: '/host/interpreter',
      PI_CODING_AGENT_DIR: '/host/omp',
      RANDOM_AMBIENT_VALUE: 'do-not-pass'
    })

    expect(env).toEqual({
      PATH: '/usr/bin',
      PATHEXT: '.EXE',
      SystemRoot: 'C:\\Windows',
      HTTPS_PROXY: 'https://proxy.example',
      no_proxy: 'localhost',
      SSL_CERT_FILE: '/etc/certs.pem',
      NODE_EXTRA_CA_CERTS: '/etc/extra.pem',
      OPENAI_API_KEY: 'openai-key',
      ANTHROPIC_API_KEY: 'anthropic-key',
      KIRO_API_KEY: 'kiro-key'
    })
  })
})

describe('probeAllRuntimes', () => {
  it('probes every runtime and keys results by id', async () => {
    const runtimes: Record<string, RuntimeDef> = { a: rt, b: rt, c: rt }
    const results = await probeAllRuntimes(runtimes, {
      concurrency: 2,
      hostFactory: () => fakeHost({ models: { current: 'm', models: ['m'] } })
    })
    expect(results.map((r) => r.runtime).sort()).toEqual(['a', 'b', 'c'])
    expect(results.every((r) => r.ok && r.models[0] === 'm')).toBe(true)
  })

  it('returns [] for no runtimes', async () => {
    expect(await probeAllRuntimes({}, { hostFactory: () => fakeHost({}) })).toEqual([])
  })

  // The sweep used to apply every result at one barrier, so a runtime whose package
  // launcher spends minutes building its install tree also held back the runtimes that
  // answered in seconds. Each result must surface as it lands.
  it('reports each result as it resolves, before the slow ones finish', async () => {
    let releaseSlow = (): void => {}
    const slow = new Promise<string>((resolve) => {
      releaseSlow = () => resolve('sess-slow')
    })
    const reported: string[] = []
    const sweep = probeAllRuntimes(
      { fast: rt, slow: rt },
      {
        concurrency: 2,
        hostFactory: (_rt, id) => fakeHost(id === 'slow' ? { newSession: () => slow } : {}),
        onResult: (result) => reported.push(result.runtime)
      }
    )
    await vi.waitFor(() => expect(reported).toEqual(['fast']))
    releaseSlow()
    const results = await sweep
    expect(reported).toEqual(['fast', 'slow'])
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('keeps probing when a result callback throws', async () => {
    const warn = vi.fn()
    const results = await probeAllRuntimes(
      { a: rt, b: rt },
      {
        concurrency: 1,
        hostFactory: () => fakeHost({}),
        log: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
        onResult: () => {
          throw new Error('cp write failed')
        }
      }
    )
    expect(results.map((r) => r.runtime).sort()).toEqual(['a', 'b'])
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('probeTimeoutMs', () => {
  // A package launcher resolves and links its whole tree on first use (~210s measured
  // for a 700-package harness), so 30s could never admit one: the deadline is a
  // hang reaper for those, not a latency budget.
  it.each(['npx', 'uvx'])('gives %s launchers a hang-reaper deadline', (command) => {
    expect(probeTimeoutMs({ command, args: [], env: [] })).toBe(6 * 60_000)
  })

  it('keeps the tight 30s budget for a real binary distribution', () => {
    expect(probeTimeoutMs({ command: 'qodercli', args: ['--acp'], env: [] })).toBe(30_000)
  })

  // Models the real leak: omp's own daemon escapes the adapter's process group, so it
  // is still writing when stop() resolves and its next write restores the tree rmSync
  // just deleted. Both delays matter: 50ms lands before the first observation point
  // (250ms), 500ms lands AFTER it — the case an early return on a momentarily-clean
  // stat would leak, since cleanup would already have declared success.
  it.each([50, 500])(
    'removes its temp root when a runtime re-creates it %dms after teardown',
    async (delayMs) => {
      let probeRoot = ''
      const results = await probeAllRuntimes(
        { a: rt },
        {
          hostFactory: (_runtime, _id, cwd) => {
            probeRoot = dirname(dirname(cwd))
            return fakeHost({
              onStop: () => {
                setTimeout(() => mkdirSync(join(cwd, 'late-write'), { recursive: true }), delayMs).unref()
              }
            })
          }
        }
      )
      expect(results.map((r) => r.ok)).toEqual([true])
      expect(probeRoot).not.toBe('')

      // Wait for the re-creation to actually land first — asserting before it does would
      // pass against any implementation, including one that never looks again.
      await new Promise((resolve) => setTimeout(resolve, delayMs + 150))
      expect(existsSync(probeRoot)).toBe(true)

      // Then let the background watch reclaim it. Polling rather than hardcoding which
      // observation point catches this delay; a cleanup that stopped early never removes
      // the root again, so it is still there when the deadline expires.
      const deadline = Date.now() + 8_000
      while (existsSync(probeRoot) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(existsSync(probeRoot)).toBe(false)
    },
    15_000
  )

  it('uses a disposable protected curated launch and leaves host state unchanged', async () => {
    const hostHome = mkdtempSync(join(tmpdir(), 'ac-probe-host-'))
    const hostHermes = join(hostHome, '.hermes')
    mkdirSync(hostHermes)
    const hostConfig = join(hostHermes, 'config.yaml')
    const hostDotEnv = join(hostHermes, '.env')
    const original = 'model: test\nmemory:\n  memory_enabled: true\n'
    writeFileSync(hostConfig, original)
    writeFileSync(hostDotEnv, 'OPENAI_API_KEY=scalar-key\nGOOGLE_APPLICATION_CREDENTIALS=/host/google.json\n')

    let privateHome = ''
    let privateConfig = ''
    const results = await probeAllRuntimes(
      { 'hermes-agent': { command: 'hermes', args: ['acp'], env: [] } },
      {
        curated: true,
        hostEnv: {
          HOME: hostHome,
          PATH: '/usr/bin',
          OPENAI_API_KEY: 'scalar-key',
          GOOGLE_APPLICATION_CREDENTIALS: '/host/google.json',
          RANDOM_AMBIENT_VALUE: 'nope'
        },
        hostFactory: (_runtime, _id, cwd, policy) => {
          privateHome = policy.env!.HOME!
          privateConfig = join(policy.env!.HERMES_HOME!, 'config.yaml')
          expect(dirname(cwd)).toBe(dirname(privateHome))
          expect(policy.inheritProcessEnv).toBe(false)
          expect(policy.env).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS')
          expect(policy.env).not.toHaveProperty('RANDOM_AMBIENT_VALUE')
          expect(readFileSync(privateConfig, 'utf8')).toContain('memory_enabled: false')
          expect(readFileSync(join(policy.env!.HERMES_HOME!, '.env'), 'utf8')).toBe('OPENAI_API_KEY=scalar-key\n')
          return successfulHost()
        }
      }
    )

    expect(results[0]?.ok).toBe(true)
    expect(readFileSync(hostConfig, 'utf8')).toBe(original)
    expect(readFileSync(hostDotEnv, 'utf8')).toContain('GOOGLE_APPLICATION_CREDENTIALS=/host/google.json')
    expect(existsSync(privateHome)).toBe(false)
    expect(existsSync(privateConfig)).toBe(false)
  })

  it('removes copied Maki MCP declarations from disposable probes', async () => {
    const hostHome = mkdtempSync(join(tmpdir(), 'ac-probe-maki-'))
    const hostConfig = join(hostHome, '.config', 'maki')
    mkdirSync(hostConfig, { recursive: true })
    writeFileSync(join(hostConfig, 'init.lua'), 'maki.setup({})')
    writeFileSync(join(hostConfig, 'mcp.toml'), '[servers.host]\ncommand = "unsafe"\n')

    const results = await probeAllRuntimes(
      { maki: { command: 'maki', args: ['acp'], env: [] } },
      {
        curated: true,
        hostEnv: { HOME: hostHome, PATH: '/usr/bin' },
        hostFactory: (_runtime, _id, _cwd, policy) => {
          const privateConfig = join(policy.env!.HOME!, '.config', 'maki')
          expect(existsSync(join(privateConfig, 'init.lua'))).toBe(true)
          expect(existsSync(join(privateConfig, 'mcp.toml'))).toBe(false)
          return successfulHost()
        }
      }
    )

    expect(results[0]?.ok).toBe(true)
    expect(readFileSync(join(hostConfig, 'mcp.toml'), 'utf8')).toContain('unsafe')
  })
})

describe('sweepStaleProbeRoots', () => {
  const probeRootAged = (tmpRoot: string, name: string, ageMs: number): string => {
    const path = join(tmpRoot, name)
    mkdirSync(join(path, 'runtime', 'home'), { recursive: true })
    writeFileSync(join(path, 'runtime', 'home', 'natives.bin'), 'x')
    const when = new Date(Date.now() - ageMs)
    utimesSync(path, when, when)
    return path
  }

  it('removes abandoned roots past the age cutoff and keeps fresh ones', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'ac-probe-sweeptest-'))
    const abandoned = probeRootAged(tmpRoot, 'ac-probe-oldone', 2 * 60 * 60_000)
    // A live sweep by a concurrent daemon must survive, as must unrelated temp dirs.
    const fresh = probeRootAged(tmpRoot, 'ac-probe-freshy', 30_000)
    const unrelated = probeRootAged(tmpRoot, 'ac-sm-something', 2 * 60 * 60_000)

    expect(sweepStaleProbeRoots({ tmpRoot })).toBe(1)
    expect(existsSync(abandoned)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('removes a fresh PID-tagged root once its owning probe is no longer live', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'ac-probe-sweeptest-'))
    const completed = probeRootAged(tmpRoot, `ac-probe-${process.pid}-completed`, 30_000)

    expect(sweepStaleProbeRoots({ tmpRoot })).toBe(1)
    expect(existsSync(completed)).toBe(false)
  })

  it('preserves a PID-tagged root owned by another live process regardless of age', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'ac-probe-sweeptest-'))
    const concurrent = probeRootAged(tmpRoot, `ac-probe-${process.ppid}-concurrent`, 2 * 60 * 60_000)

    expect(sweepStaleProbeRoots({ tmpRoot })).toBe(0)
    expect(existsSync(concurrent)).toBe(true)
  })

  it('skips a symlink planted under the probe prefix instead of following it', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'ac-probe-sweeptest-'))
    const victim = mkdtempSync(join(tmpdir(), 'ac-probe-sweepvictim-'))
    writeFileSync(join(victim, 'keep.txt'), 'keep')
    const link = join(tmpRoot, 'ac-probe-evilink')
    symlinkSync(victim, link)
    const when = new Date(Date.now() - 2 * 60 * 60_000)
    lutimesSync(link, when, when)

    expect(sweepStaleProbeRoots({ tmpRoot })).toBe(0)
    expect(existsSync(join(victim, 'keep.txt'))).toBe(true)
  })

  it('returns 0 when the temp root cannot be read', () => {
    expect(sweepStaleProbeRoots({ tmpRoot: join(tmpdir(), 'ac-probe-absent-xyz') })).toBe(0)
  })
})
