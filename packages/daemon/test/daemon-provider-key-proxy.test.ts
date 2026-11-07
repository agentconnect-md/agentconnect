import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentHostKey, sessionHostKey } from '../src/acp/host-key.js'
import { Daemon } from '../src/daemon.js'
import { PLACEHOLDER_PREFIX } from '../src/credential-proxy/placeholder.js'

// github-app-git-credentials.md, Provider keys: a host or srt session's organization key goes through the credential proxy.
const KEY = 'example-org-provider-key'
const HEADER = 'example-workspace-header'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A daemon root; `blockProxy` puts a file where the proxy keeps its key and CA, so it cannot start. */
function scaffold(blockProxy: boolean, runtime: 'claude' | 'codex' = 'claude'): string {
  // Short, so the proxy's sockets fit AF_UNIX.
  const root = realpathSync(mkdtempSync(join('/tmp', 'acpk-')))
  roots.push(root)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: {
        claude: { command: 'node', args: ['claude-agent-acp'] },
        codex: { command: 'node', args: ['codex-acp'] }
      }
    })
  )
  if (blockProxy) writeFileSync(join(root, 'credential-proxy'), 'not a directory')
  const agentDir = join(root, 'agents', 'bot-a')
  mkdirSync(join(agentDir, 'workspace'), { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime,
      modelProvider: runtime === 'claude' ? 'anthropic' : 'openai',
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

async function started(blockProxy = false, runtime: 'claude' | 'codex' = 'claude') {
  const root = scaffold(blockProxy, runtime)
  const daemon = new Daemon({ root, probeRuntimes: async () => [] })
  await daemon.start()
  const d = daemon as any
  return { root, daemon, d, agent: d.agents.get('bot-a') }
}

const credential = (endpoint: string | null) => ({ apiKey: KEY, endpoint, headers: { 'x-workspace': HEADER } })

/** Every file under a directory, as text. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [readFileSync(path, 'utf8')]
  })
}

function build(d: any, agent: any, providerCredential: unknown, strategy = 'host') {
  return d.buildAcpHost(agent, d.cfg, {
    hostKey: strategy === 'host' ? agentHostKey(agent.id) : sessionHostKey(agent.id, 'slack:T1:C1:1700000000.000100'),
    strategy,
    cwd: agent.workspace.path,
    providerCredential
  })
}

describe.skipIf(process.platform === 'win32')('organization Provider keys through the credential proxy', () => {
  it('hands a host session a placeholder and the proxy route, never the key or its headers', async () => {
    const { daemon, d, agent } = await started()
    try {
      const requestProviderCredentials = vi.fn().mockResolvedValue({ credentials: credential(null) })
      d.cpClient = { requestProviderCredentials }
      const { host } = build(d, agent, credential(null))
      const env: Record<string, string> = host.opts.env
      expect(env.ANTHROPIC_API_KEY!.startsWith(PLACEHOLDER_PREFIX)).toBe(true)
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('')
      expect(env.HTTPS_PROXY).toBe(d.credentialProxy.proxy.loopbackUrl())
      expect(env.NODE_USE_ENV_PROXY).toBe('1')
      expect(env.CODEX_CA_CERTIFICATE).toBe(env.SSL_CERT_FILE)
      expect(JSON.stringify(env)).not.toContain(KEY)
      expect(JSON.stringify(env)).not.toContain(HEADER)
      expect(JSON.stringify(host.opts.files)).not.toContain(KEY)
      for (const text of filesUnder(agent.dir)) expect(text).not.toContain(KEY)
      // The proxy resolves the slot through the same CP call and sets the key and headers itself.
      const decision = await d.credentialProxy.proxy.decide(
        new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': env.ANTHROPIC_API_KEY! }
        }),
        { scheme: 'https', target: { host: 'api.anthropic.com', port: 443 } }
      )
      expect(decision).toMatchObject({
        action: 'allow',
        setHeaders: [
          ['x-api-key', KEY],
          ['x-workspace', HEADER]
        ]
      })
      expect(requestProviderCredentials).toHaveBeenCalledWith({ agentId: 'bot-a', provider: 'anthropic' })
      expect(d.credentialProxyIntercepts('bot-a')).toBe(true)
      // A VM's, pod's or executor's tunnel stays a code-host matter.
      expect(d.credentialProxyCodeHosts('bot-a')).toBe(false)
      // An srt environment of the agent routes the provider host to the proxy.
      expect(d.srtMitmProxy({ id: 'bot-a/session-x', workspaceRoot: agent.dir, mounts: [] })?.domains).toContain(
        'api.anthropic.com'
      )
      // An endpoint the organization moved is refused until a new session picks it up.
      requestProviderCredentials.mockResolvedValue({ credentials: credential('https://gateway.example.test') })
      await expect(d.resolveProviderSlot('bot-a', 'org:anthropic')).rejects.toThrow(/endpoint changed/)
    } finally {
      d.cpClient = undefined
      await daemon.stop()
    }
  })

  it("seals a Codex session's placeholder for an operator's endpoint and keeps the headers out of its auth request", async () => {
    const { daemon, d, agent } = await started(false, 'codex')
    try {
      d.cpClient = { requestProviderCredentials: vi.fn() }
      const { host } = build(d, agent, credential('https://gateway.example.test/v1'))
      const env: Record<string, string> = host.opts.env
      expect(env.OPENAI_API_KEY!.startsWith(PLACEHOLDER_PREFIX)).toBe(true)
      const request = JSON.parse(env.DEFAULT_AUTH_REQUEST!)
      expect(request._meta.gateway).toMatchObject({
        baseUrl: 'https://gateway.example.test/v1',
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }
      })
      expect(JSON.stringify(env)).not.toContain(KEY)
      expect(JSON.stringify(env)).not.toContain(HEADER)
      expect(d.providerSlots.get('bot-a').get('org:openai')).toEqual({
        id: 'org:openai',
        provider: 'openai',
        host: 'gateway.example.test',
        port: 443,
        pathPrefix: 'v1',
        saas: false
      })
    } finally {
      d.cpClient = undefined
      await daemon.stop()
    }
  })

  it('keeps the key in env for a cleartext endpoint, and changes nothing when the proxy did not start', async () => {
    const on = await started()
    try {
      const { host } = build(on.d, on.agent, credential('http://gateway.example.test'))
      expect(host.opts.env.ANTHROPIC_API_KEY).toBe(KEY)
      expect(host.opts.env.HTTPS_PROXY).toBeUndefined()
      expect(on.d.providerSlots.get('bot-a')).toBeUndefined()
    } finally {
      await on.daemon.stop()
    }
    const off = await started(true)
    try {
      const { host } = build(off.d, off.agent, credential(null))
      expect(host.opts.env).toMatchObject({
        ANTHROPIC_API_KEY: KEY,
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_CUSTOM_HEADERS: `x-workspace: ${HEADER}`
      })
      expect(host.opts.env.HTTPS_PROXY).toBeUndefined()
    } finally {
      await off.daemon.stop()
    }
  })

  it('offers an executor-placed host session the placeholder at spawn, and its shim a provider tunnel', async () => {
    const { root, daemon, d, agent } = await started()
    const sessionKey = 'slack:T1:C1:1700000000.000100'
    const placed = {
      agentId: agent.id,
      sessionKey,
      leaf: 'leaf-example',
      subject: `${agent.id}/session-example`,
      executorDaemonId: 'executor-example',
      strategy: 'host'
    }
    const realPlane = d.executorPlane
    try {
      d.cpClient = { requestProviderCredentials: vi.fn() }
      // Before any launch the agent has no slot, so its placed sessions ask for no provider tunnel.
      expect(d.tunnelsForPlaced(agent.id, placed)).not.toContain('provider')
      d.executorPlane = {
        placementOf: (key: string) => (key === sessionKey ? placed : undefined),
        homeFor: () => '/home/agent/executor-home',
        rootsFor: () => ({ runtimeRoot: '/home/agent/executor-run', missingHelpers: [] }),
        codexStateFor: () => undefined,
        runtimeDefFor: () => undefined,
        codehostProxyFor: () => undefined,
        spawnFor: () => ({})
      }
      const { host } = d.buildAcpHost(agent, d.cfg, {
        hostKey: sessionHostKey(agent.id, sessionKey),
        strategy: 'host',
        cwd: agent.workspace.path,
        providerCredential: credential(null)
      })
      // The launch keeps the real key until its shim reports a listener; the swap travels beside it.
      expect(host.opts.env.ANTHROPIC_API_KEY).toBe(KEY)
      expect(host.opts.env.HTTPS_PROXY).toBeUndefined()
      const swap: Record<string, string> = host.opts.provider.env
      expect(swap.ANTHROPIC_API_KEY!.startsWith(PLACEHOLDER_PREFIX)).toBe(true)
      expect(swap.ANTHROPIC_CUSTOM_HEADERS).toBe('')
      expect(JSON.stringify(swap)).not.toContain(KEY)
      expect(JSON.stringify(swap)).not.toContain(HEADER)
      // The slot now exists, so the session's shim is asked for a provider tunnel to the agent's own socket.
      expect(d.tunnelsForPlaced(agent.id, placed)).toContain('provider')
      expect(d.tunnelsForPlaced(agent.id, { ...placed, strategy: 'srt' })).not.toContain('provider')
      expect(d.providerTunnelFor(agent.id)).toEqual(['provider'])
      expect(d.tunnelListenOptions(agent.id, 'provider')).toEqual({
        routes: ['api.anthropic.com:443'],
        ca: d.credentialProxy.ca.certPem
      })
      expect(d.tunnelListenOptions(agent.id, 'codehost')).toBeUndefined()
      expect(d.tunnelSocketPath(root, 'provider', agent.id)).toBe(
        d.credentialProxy.proxy.providerTunnelSocketFor(agent.id)
      )
      expect(d.tunnelSocketPath(root, 'codehost', agent.id)).toBeUndefined()
    } finally {
      d.executorPlane = realPlane
      d.cpClient = undefined
      await daemon.stop()
    }
  })

  it('routes an srt session to the proxy for the provider host with the placeholder in env', async () => {
    const { daemon, d, agent } = await started()
    try {
      d.cpClient = { requestProviderCredentials: vi.fn() }
      d.assertStrategyRunnable = () => undefined
      d.sandboxMechanism = 'bwrap'
      const { host } = build(d, agent, credential(null), 'srt')
      const env: Record<string, string> = host.opts.env
      expect(env.ANTHROPIC_API_KEY!.startsWith(PLACEHOLDER_PREFIX)).toBe(true)
      // srt routes the host itself, so no proxy variable.
      expect(env.HTTPS_PROXY).toBeUndefined()
      expect(env.SSL_CERT_FILE).toBeDefined()
      expect(JSON.stringify(env)).not.toContain(KEY)
      const environment = d.localSrtEnvironment(agent, sessionHostKey(agent.id, 'slack:T1:C1:1700000000.000100'), 'srt')
      expect(d.srtMitmProxy({ id: environment.id, workspaceRoot: agent.dir, mounts: [] }).domains).toEqual([
        'api.anthropic.com'
      ])
    } finally {
      d.cpClient = undefined
      await daemon.stop()
    }
  })
})
