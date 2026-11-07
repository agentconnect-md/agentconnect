import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentHostKey } from '../src/acp/host-key.js'
import { Daemon } from '../src/daemon.js'
import { PLACEHOLDER_PREFIX } from '../src/credential-proxy/placeholder.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'
import { LocalStore } from '../src/store/local-store.js'

// github-app-git-credentials.md, Provider keys: a self-hosted pool's install-wide keys reach its pods only as placeholders.
const ANTHROPIC_KEY = 'example-install-anthropic-key'
const OPENAI_KEY = 'example-install-openai-key'
const QWEN_KEY = 'example-install-qwen-key'
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function catalog(): ResolvedRuntimeCatalog {
  const claude = { command: 'claude-agent-acp', args: [], env: [] }
  const codex = { command: 'codex-acp', args: [], env: [] }
  const qwen = { command: 'qwen', args: ['--acp'], env: [] }
  return {
    entries: {
      claude: { runtime: claude, source: 'registry', name: 'Claude Code', version: '1.0.0', skillsAgentId: 'claude' },
      'codex-acp': { runtime: codex, source: 'registry', name: 'Codex', version: '1.0.0', skillsAgentId: 'codex' },
      'qwen-code': { runtime: qwen, source: 'registry', name: 'Qwen Code', version: '1.0.0', skillsAgentId: null }
    },
    runtimes: { claude, 'codex-acp': codex, 'qwen-code': qwen }
  }
}

async function started(env: Record<string, string>, blockProxy = false) {
  for (const name of Object.keys(process.env).filter((key) => key.startsWith('ANTHROPIC_DEFAULT_')))
    vi.stubEnv(name, '')
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  // Short, so the proxy's sockets fit AF_UNIX.
  const root = realpathSync(mkdtempSync(join('/tmp', 'acpp-')))
  roots.push(root)
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, controlPlane: { enabled: false } }))
  writeFileSync(
    join(root, 'k8s-runtimes.json'),
    JSON.stringify({ runtimes: [{ id: 'claude' }, { id: 'codex-acp' }, { id: 'qwen-code' }] })
  )
  if (blockProxy) writeFileSync(join(root, 'credential-proxy'), 'not a directory')
  const store = await LocalStore.open(':memory:')
  const daemon = new Daemon({
    root,
    k8s: true,
    openDataPlane: (async () => ({ store, transcripts: {}, close: async () => {} })) as never,
    startK8sPlane: (async () => ({
      driver: { claimName: (id: string) => `agent-${id}` },
      memberId: 'member-under-test',
      runtimeImage: async () => 'runtime-sandbox:test',
      listener: { listeningPort: () => 0 },
      workspacesOffDisk: true,
      gitRunnerFor: () => undefined,
      launched: () => [],
      adoptUntracked: async () => [],
      armedIn: async () => false,
      suspendIdle: async () => 'absent',
      suspendStalled: async () => 'absent',
      discardAgent: async () => {},
      spawnFor: () => ({}),
      stop: async () => {}
    })) as never,
    startControlPlane: vi.fn(() => Promise.resolve()) as never,
    resolveCatalog: async () => catalog(),
    probeRuntimes: async () => []
  })
  await daemon.start()
  const d = daemon as any
  return { daemon, d }
}

function agent(runtime: string) {
  return {
    id: 'bot-a',
    name: 'bot-a',
    status: 'active',
    runtime,
    dir: '/agents/bot-a',
    workspace: { mode: 'from-scratch', path: '/agents/bot-a/workspace' },
    integrations: [],
    output: { mode: 'medium' }
  }
}

function build(d: any, runtime: string, modelCredential?: unknown) {
  const loaded = agent(runtime)
  d.agents.set(loaded.id, loaded)
  return d.buildAcpHost(loaded, d.cfg, {
    hostKey: agentHostKey(loaded.id),
    strategy: 'host',
    cwd: loaded.workspace.path,
    ...(modelCredential ? { modelCredential } : {})
  }).host
}

describe.skipIf(process.platform === 'win32')("a pool pod's static install keys through the credential proxy", () => {
  it('launches with the real key and swaps a placeholder in at spawn, which decide exchanges for the key', async () => {
    const { daemon, d } = await started({ ANTHROPIC_MODEL_TOKEN: ANTHROPIC_KEY })
    try {
      const host = build(d, 'claude')
      // The real key stays in the launch for a shim that predates `provider`; the swap travels beside it.
      expect(host.opts.env.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY)
      const swap: Record<string, string> = host.opts.provider.env
      expect(swap.ANTHROPIC_API_KEY!.startsWith(PLACEHOLDER_PREFIX)).toBe(true)
      expect(JSON.stringify(swap)).not.toContain(ANTHROPIC_KEY)
      expect(d.providerSlots.get('bot-a').get('install:model:anthropic')).toEqual({
        id: 'install:model:anthropic',
        provider: 'anthropic',
        host: 'api.anthropic.com',
        port: 443,
        saas: true
      })
      // The pod is asked for a provider tunnel to the agent's own socket, with the slot's route.
      expect(d.providerTunnelFor('bot-a')).toEqual(['provider'])
      expect(d.tunnelListenOptions('bot-a', 'provider')).toEqual({
        routes: ['api.anthropic.com:443'],
        ca: d.credentialProxy.ca.certPem
      })
      const decision = await d.credentialProxy.proxy.decide(
        new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': swap.ANTHROPIC_API_KEY! }
        }),
        { scheme: 'https', target: { host: 'api.anthropic.com', port: 443 } }
      )
      expect(decision).toMatchObject({ action: 'allow', setHeaders: [['x-api-key', ANTHROPIC_KEY]] })
    } finally {
      await daemon.stop()
    }
  })

  it("carries the placeholder into Codex's auth request at the configured gateway", async () => {
    const { daemon, d } = await started({
      OPENAI_MODEL_TOKEN: OPENAI_KEY,
      OPENAI_MODEL_BASE_URL: 'https://gateway.example.test/openai/v1'
    })
    try {
      const host = build(d, 'codex-acp')
      const swap: Record<string, string> = host.opts.provider.env
      expect(swap.OPENAI_API_KEY!.startsWith(PLACEHOLDER_PREFIX)).toBe(true)
      expect(JSON.parse(swap.DEFAULT_AUTH_REQUEST!)._meta.gateway).toMatchObject({
        baseUrl: 'https://gateway.example.test/openai/v1',
        headers: { Authorization: `Bearer ${swap.OPENAI_API_KEY}` }
      })
      expect(JSON.stringify(swap)).not.toContain(OPENAI_KEY)
      expect(d.providerSlots.get('bot-a').get('install:model:openai')).toMatchObject({
        host: 'gateway.example.test',
        pathPrefix: 'openai/v1',
        saas: false
      })
    } finally {
      await daemon.stop()
    }
  })

  it('routes a runtime environment key at the base URL the launch names, and reads it again on resolve', async () => {
    const { daemon, d } = await started({
      AC_RUNTIME_ENV_BINDINGS: JSON.stringify({
        'qwen-code': {
          OPENAI_API_KEY: 'AC_RUNTIME_SECRET_0123456789ABCDEF',
          OPENAI_BASE_URL: 'AC_RUNTIME_SECRET_FEDCBA9876543210'
        }
      }),
      AC_RUNTIME_SECRET_0123456789ABCDEF: QWEN_KEY,
      AC_RUNTIME_SECRET_FEDCBA9876543210: 'https://models.example.test/v1'
    })
    try {
      const host = build(d, 'qwen-code')
      expect(host.opts.env.OPENAI_API_KEY).toBe(QWEN_KEY)
      const swap: Record<string, string> = host.opts.provider.env
      expect(Object.keys(swap)).toEqual(['OPENAI_API_KEY'])
      expect(d.providerSlots.get('bot-a').get('install:qwen-code:OPENAI_API_KEY')).toMatchObject({
        provider: 'openai',
        host: 'models.example.test',
        pathPrefix: 'v1'
      })
      await expect(d.resolveProviderSlot('bot-a', 'install:qwen-code:OPENAI_API_KEY')).resolves.toEqual({
        key: QWEN_KEY,
        headers: {}
      })
    } finally {
      await daemon.stop()
    }
  })

  it("seats a token-only pair's slot at the gateway the runtime environment names, never at the provider's default", async () => {
    const bindings = (url: string) => ({
      AC_RUNTIME_ENV_BINDINGS: JSON.stringify({ claude: { ANTHROPIC_BASE_URL: 'AC_RUNTIME_SECRET_FEDCBA9876543210' } }),
      AC_RUNTIME_SECRET_FEDCBA9876543210: url,
      ANTHROPIC_MODEL_TOKEN: ANTHROPIC_KEY
    })
    const https = await started(bindings('https://gateway.example.test/anthropic'))
    try {
      const host = build(https.d, 'claude')
      expect(host.opts.env.ANTHROPIC_BASE_URL).toBe('https://gateway.example.test/anthropic')
      expect(host.opts.provider.env.ANTHROPIC_API_KEY.startsWith(PLACEHOLDER_PREFIX)).toBe(true)
      expect(https.d.providerSlots.get('bot-a').get('install:model:anthropic')).toMatchObject({
        host: 'gateway.example.test',
        pathPrefix: 'anthropic',
        saas: false
      })
      expect(https.d.tunnelListenOptions('bot-a', 'provider').routes).toEqual(['gateway.example.test:443'])
    } finally {
      await https.daemon.stop()
    }
    // A cleartext gateway cannot exchange a placeholder, so the pod keeps the real key.
    const cleartext = await started(bindings('http://gateway.example.test:8080/anthropic'))
    try {
      const host = build(cleartext.d, 'claude')
      expect(host.opts.env.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY)
      expect(host.opts.provider).toBeUndefined()
      expect(cleartext.d.providerSlots.get('bot-a')).toBeUndefined()
    } finally {
      await cleartext.daemon.stop()
    }
  })

  it('keeps a key another launch variable also carries, so no pod holds it beside its placeholder', async () => {
    const { daemon, d } = await started({
      AC_RUNTIME_ENV_BINDINGS: JSON.stringify({
        'qwen-code': {
          OPENAI_API_KEY: 'AC_RUNTIME_SECRET_0123456789ABCDEF',
          EXAMPLE_TOOL_TOKEN: 'AC_RUNTIME_SECRET_0123456789ABCDEF'
        }
      }),
      AC_RUNTIME_SECRET_0123456789ABCDEF: QWEN_KEY
    })
    try {
      const host = build(d, 'qwen-code')
      expect(host.opts.env.OPENAI_API_KEY).toBe(QWEN_KEY)
      expect(host.opts.provider).toBeUndefined()
      expect(d.providerSlots.get('bot-a')).toBeUndefined()
    } finally {
      await daemon.stop()
    }
  })

  it('keeps the real key for a cleartext endpoint, a key-server grant, or a proxy that did not start', async () => {
    const cleartext = await started({
      ANTHROPIC_MODEL_TOKEN: ANTHROPIC_KEY,
      ANTHROPIC_MODEL_BASE_URL: 'http://gateway.example.test:8080/anthropic'
    })
    try {
      const host = build(cleartext.d, 'claude')
      expect(host.opts.env.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY)
      expect(host.opts.provider).toBeUndefined()
      expect(cleartext.d.providerSlots.get('bot-a')).toBeUndefined()
      expect(cleartext.d.providerTunnelFor('bot-a')).toEqual([])
    } finally {
      await cleartext.daemon.stop()
    }
    const granted = await started({ ANTHROPIC_MODEL_TOKEN: ANTHROPIC_KEY })
    try {
      const grant = { target: { provider: 'anthropic', runtime: 'claude' }, credential: { key: 'example-grant' } }
      const host = build(granted.d, 'claude', grant)
      // A grant is short-lived and scoped, so it reaches the pod as it always has.
      expect(host.opts.env.ANTHROPIC_API_KEY).toBe('example-grant')
      expect(host.opts.provider).toBeUndefined()
      expect(granted.d.providerSlots.get('bot-a')).toBeUndefined()
    } finally {
      await granted.daemon.stop()
    }
    const off = await started({ ANTHROPIC_MODEL_TOKEN: ANTHROPIC_KEY }, true)
    try {
      const host = build(off.d, 'claude')
      expect(host.opts.env.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY)
      expect(host.opts.provider).toBeUndefined()
    } finally {
      await off.daemon.stop()
    }
  })
})
