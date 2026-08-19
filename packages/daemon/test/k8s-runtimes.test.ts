import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  K8S_RUNTIMES_ENV,
  k8sRuntimesPath,
  K8sRuntimeTableSchema,
  declaredRuntimeCatalog,
  loadK8sRuntimeTable
} from '../src/runtimes/k8s-runtimes.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'ac-k8s-runtimes-'))
}

function write(dir: string, contents: string, name = 'k8s-runtimes.json'): string {
  const path = join(dir, name)
  writeFileSync(path, contents)
  return path
}

function catalog(): ResolvedRuntimeCatalog {
  const claude = { command: 'claude-code-acp', args: [], env: [] }
  const codex = { command: 'npx', args: ['-y', '@agentconnect.md/codex-acp'], env: [] }
  const hermes = { command: 'hermes', args: ['acp'], env: [] }
  const dsh = { command: 'npx', args: ['-y', '-p', '@openma/deepseek-harness-acp@^0.4', 'dsh-acp'], env: [] }
  return {
    entries: {
      claude: { runtime: claude, source: 'registry', name: 'Claude Code', version: '1.2.3', skillsAgentId: 'claude' },
      'codex-acp': { runtime: codex, source: 'managed', name: 'Codex', version: '', skillsAgentId: null },
      'hermes-agent': { runtime: hermes, source: 'curated', name: 'Hermes Agent', version: '', skillsAgentId: null },
      'dsh-acp': { runtime: dsh, source: 'curated', name: 'DeepSeek Harness', version: '', skillsAgentId: null }
    },
    runtimes: { claude, 'codex-acp': codex, 'hermes-agent': hermes, 'dsh-acp': dsh }
  }
}

describe('k8s runtime table', () => {
  it('takes the probed MCP bridge launch, and drops a malformed one without losing the runtimes', () => {
    const mcpBridge = { command: '/usr/local/bin/node', args: ['/opt/agentconnect/shim/mcp-bridge.js'] }
    const shipped = K8sRuntimeTableSchema.parse({ runtimes: [{ id: 'claude' }], mcpBridge })
    expect(shipped.mcpBridge).toEqual(mcpBridge)
    // The daemon hands this to the pod's runtime to spawn, so a command that is not an absolute
    // path in that image is refused — but refusing it must not fail the parse: the same answer
    // carries the runtimes this member advertises, and losing those takes the member out of
    // service over a tool surface.
    const odd = K8sRuntimeTableSchema.parse({
      runtimes: [{ id: 'claude' }],
      mcpBridge: { command: 'node', args: ['mcp-bridge.js'] }
    })
    expect(odd.mcpBridge).toBeUndefined()
    expect(odd.runtimes).toHaveLength(1)
  })

  it('defaults under the daemon root and honors the env override', () => {
    const dir = root()
    expect(k8sRuntimesPath(dir, {})).toBe(join(dir, 'k8s-runtimes.json'))
    expect(k8sRuntimesPath(dir, { [K8S_RUNTIMES_ENV]: '/etc/ac/runtimes.json' })).toBe('/etc/ac/runtimes.json')
    // A blank override is not a path — fall back rather than reading "".
    expect(k8sRuntimesPath(dir, { [K8S_RUNTIMES_ENV]: '  ' })).toBe(join(dir, 'k8s-runtimes.json'))
  })

  it('returns undefined when no table is present', () => {
    expect(loadK8sRuntimeTable(root(), {})).toBeUndefined()
  })

  it('throws on malformed JSON and on a schema mismatch', () => {
    const dir = root()
    write(dir, '{ not json')
    expect(() => loadK8sRuntimeTable(dir, {})).toThrow(/not valid JSON/)
    write(dir, JSON.stringify({ runtimes: [] }))
    expect(() => loadK8sRuntimeTable(dir, {})).toThrow(/invalid/)
    write(dir, JSON.stringify({ runtimes: [{ version: '1' }] }))
    expect(() => loadK8sRuntimeTable(dir, {})).toThrow(/invalid/)
  })

  it('loads a valid table from the env-pointed path', () => {
    const dir = root()
    const path = write(dir, JSON.stringify({ runtimes: [{ id: 'claude', models: ['a'] }] }), 'pinned.json')
    expect(loadK8sRuntimeTable(dir, { [K8S_RUNTIMES_ENV]: path })).toEqual({
      runtimes: [{ id: 'claude', models: ['a'] }]
    })
  })
})

describe('declaredRuntimeCatalog', () => {
  it('keeps only declared runtimes and reports the image pin as their version', () => {
    const result = declaredRuntimeCatalog(catalog(), {
      runtimes: [{ id: 'claude', version: '9.9.9', models: ['sonnet', 'opus'] }]
    })
    expect(Object.keys(result.catalog.entries)).toEqual(['claude'])
    expect(result.catalog.entries.claude?.version).toBe('9.9.9')
    // Command/args still come from the resolved catalog — the table only declares presence.
    expect(result.catalog.runtimes.claude?.command).toBe('claude-code-acp')
    expect(result.models).toEqual({ claude: ['sonnet', 'opus'] })
    expect(result.unresolved).toEqual([])
  })

  it('takes the command from the IMAGE, which is what makes an npx-distributed runtime usable', () => {
    // The registry distributes both runtimes through `npx`, and --k8s refuses package launchers —
    // so before the image published its executable, every deployment had to restate the mapping in
    // daemon config: a claim about an image, made somewhere the image is not.
    const npxCatalog = {
      entries: {
        claude: {
          id: 'claude',
          name: 'Claude',
          version: '1.2.3',
          source: 'registry' as const,
          runtime: { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'], env: [] }
        }
      },
      runtimes: { claude: { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'], env: [] } }
    }
    const result = declaredRuntimeCatalog(npxCatalog as never, {
      runtimes: [{ id: 'claude', version: '0.66.0', command: 'claude-agent-acp', args: [] }]
    })
    // Accepted, and launched as the image's own executable.
    expect(result.rejectedPackageLaunchers).toEqual([])
    expect(result.catalog.runtimes.claude?.command).toBe('claude-agent-acp')
    expect(result.catalog.entries.claude?.runtime.command).toBe('claude-agent-acp')
    expect(result.catalog.entries.claude?.version).toBe('0.66.0')
  })

  it('still refuses a package launcher when the image names one', () => {
    // The check moved to the EFFECTIVE command rather than being dropped: an image that reported
    // `npx` would fetch its artifact at launch, which the pin cannot describe and a restricted
    // egress cannot reach.
    const result = declaredRuntimeCatalog(catalog(), { runtimes: [{ id: 'claude', command: 'npx' }] })
    expect(result.rejectedPackageLaunchers).toEqual(['claude'])
    expect(Object.keys(result.catalog.entries)).toEqual([])
  })

  it('carries the image ACP snapshot through, rather than dropping it on the floor', () => {
    // The table's whole point in --k8s is reporting what a probe would have found. A schema that
    // strips this field leaves the daemon publishing ids and versions and nothing else — and it
    // fails silently, because the artifact is still internally consistent.
    const result = declaredRuntimeCatalog(catalog(), {
      runtimes: [
        {
          id: 'claude',
          version: '9.9.9',
          acp: {
            protocolVersion: 1,
            agentName: '@agentclientprotocol/claude-agent-acp',
            capabilities: { mcpCapabilities: { http: true, sse: true }, loadSession: true },
            modes: ['default', 'plan'],
            configOptions: [{ id: 'model', category: 'model', type: 'select', values: ['opus', 'sonnet'] }],
            sessionProbe: 'ok'
          }
        }
      ]
    })
    expect(result.acp.claude?.protocolVersion).toBe(1)
    expect(result.acp.claude?.capabilities?.mcpCapabilities).toEqual({ http: true, sse: true })
    expect(result.acp.claude?.configOptions?.[0]?.id).toBe('model')
    expect(result.acp.claude?.sessionProbe).toBe('ok')
  })

  it('parses a table whose entries carry an ACP snapshot, keeping the snapshot intact', () => {
    // Guards the schema itself: zod strips unknown keys, so an `acp` field that is not declared
    // vanishes between the file and the caller with no error anywhere.
    const parsed = K8sRuntimeTableSchema.parse({
      runtimes: [{ id: 'claude', version: '1.0.0', acp: { protocolVersion: 1, modes: ['default'] } }]
    })
    expect(parsed.runtimes[0]?.acp).toEqual({ protocolVersion: 1, modes: ['default'] })
  })

  it('leaves the catalog-declared version alone when the table omits one', () => {
    const result = declaredRuntimeCatalog(catalog(), { runtimes: [{ id: 'claude' }] })
    expect(result.catalog.entries.claude?.version).toBe('1.2.3')
    expect(result.models).toEqual({})
  })

  it('reports declared ids the catalog does not know', () => {
    const result = declaredRuntimeCatalog(catalog(), { runtimes: [{ id: 'claude' }, { id: 'ghost' }] })
    expect(result.unresolved).toEqual(['ghost'])
    expect(Object.keys(result.catalog.entries)).toEqual(['claude'])
  })

  it('drops curated runtimes, which cannot be admitted without a probe', () => {
    const result = declaredRuntimeCatalog(catalog(), { runtimes: [{ id: 'hermes-agent' }] })
    expect(result.rejectedCurated).toEqual(['hermes-agent'])
    expect(result.catalog.entries).toEqual({})
  })

  it('admits a curated runtime the image installed and probed, re-sourced away from curated', () => {
    // The evidence curated admission asks for, taken in the image the runtime runs in — and the
    // source must change, or the host-side admission gate would keep it out awaiting a probe
    // `--k8s` never makes.
    const result = declaredRuntimeCatalog(catalog(), {
      runtimes: [
        {
          id: 'dsh-acp',
          version: '0.4.9',
          command: 'dsh-acp',
          acp: { protocolVersion: 1, agentName: 'dsh-acp', sessionProbe: 'auth-required' }
        }
      ]
    })
    expect(result.rejectedCurated).toEqual([])
    expect(result.rejectedPackageLaunchers).toEqual([])
    expect(result.catalog.entries['dsh-acp']?.source).toBe('image')
    expect(result.catalog.entries['dsh-acp']?.version).toBe('0.4.9')
    expect(result.catalog.runtimes['dsh-acp']).toEqual({ command: 'dsh-acp', args: [], env: [] })
    expect(result.acp['dsh-acp']?.sessionProbe).toBe('auth-required')
  })

  it('still drops a curated runtime the image names but never probed', () => {
    // A command with no `initialize` snapshot is a claim, not evidence: nothing says the image
    // can actually open an ACP session with it.
    const result = declaredRuntimeCatalog(catalog(), { runtimes: [{ id: 'dsh-acp', command: 'dsh-acp' }] })
    expect(result.rejectedCurated).toEqual(['dsh-acp'])
    expect(result.catalog.entries).toEqual({})
  })

  it('drops declared runtimes that would fetch their artifact at launch time', () => {
    const result = declaredRuntimeCatalog(catalog(), { runtimes: [{ id: 'codex-acp', version: '1.0.0' }] })
    expect(result.rejectedPackageLaunchers).toEqual(['codex-acp'])
    // An npx line fetches something the image never built and the version pin never named,
    // and fails outright on a restricted egress — so it is not advertised or launchable.
    expect(result.catalog.entries).toEqual({})
    expect(result.catalog.runtimes).toEqual({})
  })
})
