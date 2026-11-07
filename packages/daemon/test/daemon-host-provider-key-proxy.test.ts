import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionHostKey } from '../src/acp/host-key.js'
import { Daemon } from '../src/daemon.js'
import { PLACEHOLDER_PREFIX } from '../src/credential-proxy/placeholder.js'
import { RUNTIME_KEY_FIXTURES } from './runtime-key-files-support.js'

// github-app-git-credentials.md, Provider keys: this machine's own provider keys reach an srt session only as placeholders.
const ENV_KEY = 'fixture-host-anthropic-key'
const CODEX_KEY = 'fixture-host-codex-key'
const ROTATED_KEY = 'fixture-host-codex-rotated'
const OAUTH = { auth_mode: 'chatgpt', tokens: { access_token: 'fixture-oauth-access', refresh_token: 'fixture-oauth' } }
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A short temp dir, so the proxy's sockets fit AF_UNIX. */
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join('/tmp', prefix)))
  roots.push(dir)
  return dir
}

/** A fake host HOME the daemon reads sign-ins from, and nothing of this machine's own. */
function hostEnv(env: Record<string, string> = {}): string {
  const home = tempDir('acph-')
  vi.stubEnv('HOME', home)
  for (const name of [
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'CODEX_CONFIG',
    'HTTPS_PROXY',
    'https_proxy',
    'PI_CODING_AGENT_DIR',
    'GROK_HOME',
    'GROK_AUTH_PATH',
    'QWEN_HOME',
    'KIMI_CODE_HOME',
    'KIMI_SHARE_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'AMP_SETTINGS_FILE'
  ])
    vi.stubEnv(name, undefined)
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  return home
}

/** A daemon with this runtime; `blockProxy` puts a file where the proxy keeps its key and CA, so it cannot start. */
async function started(blockProxy: boolean, runtime: string) {
  const root = tempDir('acpr-')
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: {
        claude: { command: 'node', args: ['claude-agent-acp'] },
        codex: { command: 'node', args: ['codex-acp'] },
        ...Object.fromEntries(
          RUNTIME_KEY_FIXTURES.map(({ runtime: id }) => [id, { command: 'node', args: [`${id}-adapter`] }])
        )
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
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  const daemon = new Daemon({ root, probeRuntimes: async () => [] })
  await daemon.start()
  const d = daemon as any
  d.assertStrategyRunnable = () => undefined
  d.sandboxMechanism = 'bwrap'
  return { root, daemon, d, agent: d.agents.get('bot-a') }
}

function buildSrt(d: any, agent: any) {
  return d.buildAcpHost(agent, d.cfg, {
    hostKey: sessionHostKey(agent.id, 'slack:T1:C1:1700000000.000100'),
    strategy: 'srt',
    cwd: agent.workspace.path
  }).host
}

/** Every regular file under a directory, as text; links are not followed. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    const stat = lstatSync(path)
    return stat.isDirectory() ? filesUnder(path) : stat.isFile() ? [readFileSync(path, 'utf8')] : []
  })
}

function decide(d: any, host: string, headers: Record<string, string>) {
  return d.credentialProxy.proxy.decide(new Request(`https://${host}/v1/messages`, { method: 'POST', headers }), {
    scheme: 'https',
    target: { host, port: 443 }
  })
}

describe.skipIf(process.platform === 'win32')("this machine's provider keys in srt sessions", () => {
  it('hands the session a placeholder for the key in the daemon env, which the proxy exchanges', async () => {
    hostEnv({ ANTHROPIC_API_KEY: ENV_KEY })
    const { root, daemon, d, agent } = await started(false, 'claude')
    try {
      const host = buildSrt(d, agent)
      const env: Record<string, string> = {
        ...Object.fromEntries(host.runtime.env.map((e: any) => [e.name, e.value])),
        ...host.opts.env
      }
      expect(env.ANTHROPIC_API_KEY!.startsWith(PLACEHOLDER_PREFIX)).toBe(true)
      expect(env.SSL_CERT_FILE).toBeDefined()
      expect(JSON.stringify(env)).not.toContain(ENV_KEY)
      expect(JSON.stringify(host.opts.files ?? [])).not.toContain(ENV_KEY)
      for (const text of filesUnder(root)) expect(text).not.toContain(ENV_KEY)
      expect(d.providerSlots.get('bot-a').get('host:claude-acp:ANTHROPIC_API_KEY')).toEqual({
        id: 'host:claude-acp:ANTHROPIC_API_KEY',
        provider: 'anthropic',
        host: 'api.anthropic.com',
        port: 443,
        saas: true
      })
      expect(d.srtMitmProxy({ id: 'bot-a/session-x', workspaceRoot: agent.dir, mounts: [] }).domains).toEqual([
        'api.anthropic.com'
      ])
      expect(await decide(d, 'api.anthropic.com', { 'x-api-key': env.ANTHROPIC_API_KEY! })).toMatchObject({
        action: 'allow',
        setHeaders: [['x-api-key', ENV_KEY]]
      })
    } finally {
      await daemon.stop()
    }
  })

  it('changes nothing when the proxy did not start', async () => {
    hostEnv({ ANTHROPIC_API_KEY: ENV_KEY })
    const { daemon, d, agent } = await started(true, 'claude')
    try {
      const host = buildSrt(d, agent)
      expect(host.opts.env.ANTHROPIC_API_KEY).toBe(ENV_KEY)
      expect(d.providerSlots.get('bot-a')).toBeUndefined()
    } finally {
      await daemon.stop()
    }
  })

  // The private HOME's copy is projected by file descriptor, which only Linux provides; elsewhere the file stays as it is.
  it.skipIf(process.platform !== 'linux')(
    "projects a Codex API key sign-in with the placeholder and reads the key again from the host's file",
    async () => {
      const home = hostEnv()
      const auth = join(home, '.codex', 'auth.json')
      mkdirSync(join(home, '.codex'))
      writeFileSync(auth, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: CODEX_KEY }))
      const { root, daemon, d, agent } = await started(false, 'codex')
      try {
        const host = buildSrt(d, agent)
        const env: Record<string, string> = host.opts.env
        const placeholder = env.AC_CODEX_API_KEY!
        expect(placeholder.startsWith(PLACEHOLDER_PREFIX)).toBe(true)
        const privateAuth = join(env.HOME!, '.codex', 'auth.json')
        expect(lstatSync(privateAuth).isFile()).toBe(true)
        expect(JSON.parse(readFileSync(privateAuth, 'utf8'))).toEqual({
          auth_mode: 'apikey',
          OPENAI_API_KEY: placeholder
        })
        expect(JSON.stringify(env)).not.toContain(CODEX_KEY)
        for (const text of filesUnder(root)) expect(text).not.toContain(CODEX_KEY)
        expect(await decide(d, 'api.openai.com', { authorization: `Bearer ${placeholder}` })).toMatchObject({
          action: 'allow',
          setHeaders: [['authorization', `Bearer ${CODEX_KEY}`]]
        })
        writeFileSync(auth, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: ROTATED_KEY }))
        await expect(d.resolveProviderSlot('bot-a', 'host:codex-acp:AC_CODEX_API_KEY')).resolves.toEqual({
          key: ROTATED_KEY,
          headers: {}
        })
      } finally {
        await daemon.stop()
      }
    }
  )

  it('leaves a Codex subscription sign-in exactly as it was', async () => {
    const home = hostEnv()
    const auth = join(home, '.codex', 'auth.json')
    mkdirSync(join(home, '.codex'))
    const text = JSON.stringify(OAUTH)
    writeFileSync(auth, text)
    const { daemon, d, agent } = await started(false, 'codex')
    try {
      const host = buildSrt(d, agent)
      // Linux shares the sign-in through a link; elsewhere a runtime named by its adapter seeds none.
      const privateAuth = join(host.opts.env.HOME, '.codex', 'auth.json')
      if (existsSync(privateAuth)) expect(readFileSync(privateAuth, 'utf8')).toBe(text)
      expect(readFileSync(auth, 'utf8')).toBe(text)
      expect(d.providerSlots.get('bot-a')).toBeUndefined()
      expect(JSON.stringify(host.opts.env)).not.toContain(PLACEHOLDER_PREFIX)
    } finally {
      await daemon.stop()
    }
  })

  // The private HOME's copy is projected by file descriptor, which only Linux provides.
  it.skipIf(process.platform !== 'linux').each(RUNTIME_KEY_FIXTURES)(
    'hands a $runtime session a placeholder for the key in its own files, which the proxy exchanges at that host',
    async (fixture) => {
      const home = hostEnv()
      fixture.seed(home)
      const before = filesUnder(home)
      const { root, daemon, d, agent } = await started(false, fixture.runtime)
      try {
        const host = buildSrt(d, agent)
        const env: Record<string, string> = host.opts.env
        const [slot, ...others] = [...d.providerSlots.get('bot-a').values()]
        expect(others).toEqual([])
        const variable = slot.id.slice(`host:${fixture.runtime}:`.length)
        expect(variable).toMatch(new RegExp(`^${fixture.prefix}_[0-9A-F]{16}$`))
        expect(slot).toEqual({ id: slot.id, provider: fixture.provider, host: fixture.host, port: 443, saas: true })
        const placeholder = fixture.stored(env.HOME!)!
        expect(placeholder.startsWith(PLACEHOLDER_PREFIX)).toBe(true)
        expect(env[variable]).toBe(placeholder)
        if (fixture.oauth) expect(fixture.oauth.read(env.HOME!)).toEqual(fixture.oauth.expected)
        expect(filesUnder(home)).toEqual(before)
        expect(JSON.stringify(env)).not.toContain(fixture.key)
        expect(JSON.stringify(host.opts.files ?? [])).not.toContain(fixture.key)
        for (const text of filesUnder(root)) expect(text).not.toContain(fixture.key)
        const headers: Record<string, string> = fixture.apiKeyHeader
          ? { 'x-api-key': placeholder }
          : { authorization: `Bearer ${placeholder}` }
        expect(await decide(d, fixture.host, headers)).toMatchObject({
          action: 'allow',
          setHeaders: [fixture.apiKeyHeader ? ['x-api-key', fixture.key] : ['authorization', `Bearer ${fixture.key}`]]
        })
      } finally {
        await daemon.stop()
      }
    }
  )
})
