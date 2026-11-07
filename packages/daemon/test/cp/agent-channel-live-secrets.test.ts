// Live secrets over the credential channel (capability-requests.md §4.9.2): the server's `secret` op, the gate that keeps `get`
// for agents with a managed credential, and the `agentconnect-secrets` helper end to end over a real socket.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_CHANNEL_AGENT_ENV,
  AGENT_CHANNEL_CAPABILITY_ENV,
  AgentChannelServer,
  agentChannelSocketPath,
  RUNTIME_NO_MINT_ERROR,
  type LiveSecretEntry
} from '../../src/cp/agent-channel-server.js'
import type { GitCredentialCache } from '../../src/cp/git-credential.js'
import { agentChannelIpc } from '../../src/agent-channel/ipc.js'
import { runSecretsHelper } from '../../src/agent-channel/secrets-client.js'

const SECRETS: LiveSecretEntry[] = [
  { name: 'GRAFANA_TOKEN', value: "s3cr3t-'quoted'", description: 'Grafana API token' },
  { name: 'KUBE_CONFIG', value: 'apiVersion: v1' }
]

let dir: string | undefined
let server: AgentChannelServer | undefined
afterEach(() => {
  server?.stop()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

async function boot(opts: { credentialed?: boolean; secrets?: LiveSecretEntry[] } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'agent-channel-live-'))
  const socketPath = agentChannelSocketPath(dir)
  const logs: string[] = []
  const gets: string[] = []
  const cache = {
    get: async (agentId: string) => {
      gets.push(agentId)
      return { username: 'x-access-token', token: 'ghs_test', repoFullName: 'acme/infra', access: 'write' }
    },
    invalidate: () => undefined
  }
  server = new AgentChannelServer(cache as unknown as GitCredentialCache, socketPath, {
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    credentialedOf: () => opts.credentialed === true,
    liveSecretsOf: () => opts.secrets ?? SECRETS
  })
  // The runtime's capability is the one `agentconnect-secrets` holds.
  const capability = server.capabilityFor('a1', 'runtime')
  const daemonCapability = server.capabilityFor('a1', 'daemon')
  await server.start()
  return { socketPath, capability, daemonCapability, logs, gets }
}

describe('the credential channel’s live secrets', () => {
  it('serves the current live secrets by name to the agent capability, never logging a value', async () => {
    const { socketPath, capability, logs } = await boot()
    const all = (await agentChannelIpc(socketPath, { op: 'secret', agentId: 'a1', capability })) as unknown as {
      ok: boolean
      secrets: LiveSecretEntry[]
    }
    expect(all.ok).toBe(true)
    expect(all.secrets.map((s) => s.name)).toEqual(['GRAFANA_TOKEN', 'KUBE_CONFIG'])
    const one = (await agentChannelIpc(socketPath, {
      op: 'secret',
      agentId: 'a1',
      capability,
      names: ['KUBE_CONFIG', 'MISSING']
    })) as unknown as { secrets: LiveSecretEntry[] }
    // An unknown name is simply absent.
    expect(one.secrets).toEqual([{ name: 'KUBE_CONFIG', value: 'apiVersion: v1' }])
    expect(logs.join('\n')).not.toContain('s3cr3t')
    expect(logs.join('\n')).not.toContain('apiVersion')
  })

  it('refuses a request without the agent’s capability', async () => {
    const { socketPath } = await boot()
    const res = await agentChannelIpc(socketPath, { op: 'secret', agentId: 'a1', capability: 'forged' })
    expect(res.ok).toBe(false)
  })

  it('serves the daemon capability too, and refuses either holder’s capability of another agent', async () => {
    const { socketPath, capability, daemonCapability } = await boot()
    expect(daemonCapability).not.toBe(capability)
    const own = (await agentChannelIpc(socketPath, {
      op: 'secret',
      agentId: 'a1',
      capability: daemonCapability
    })) as unknown as {
      ok: boolean
      secrets: LiveSecretEntry[]
    }
    expect(own.ok).toBe(true)
    expect(own.secrets.map((s) => s.name)).toEqual(['GRAFANA_TOKEN', 'KUBE_CONFIG'])
    for (const holder of ['daemon', 'runtime'] as const) {
      const other = server!.capabilityFor('a2', holder)
      expect(await agentChannelIpc(socketPath, { op: 'secret', agentId: 'a1', capability: other })).toMatchObject({
        ok: false
      })
    }
  })

  it('refuses the runtime capability `get` whether or not the spec carries a managed credential', async () => {
    for (const credentialed of [false, true]) {
      const { socketPath, capability, gets } = await boot({ credentialed })
      expect(await agentChannelIpc(socketPath, { op: 'get', agentId: 'a1', capability })).toEqual({
        ok: false,
        error: RUNTIME_NO_MINT_ERROR,
        denied: 'agent'
      })
      expect(gets).toEqual([])
      server?.stop()
      rmSync(dir!, { recursive: true, force: true })
    }
  })

  it("serves the daemon capability's `get` only to an agent whose spec carries a managed credential", async () => {
    const uncredentialed = await boot({ credentialed: false })
    expect(
      await agentChannelIpc(uncredentialed.socketPath, {
        op: 'get',
        agentId: 'a1',
        capability: uncredentialed.daemonCapability
      })
    ).toEqual({ ok: false, error: 'local credential capability required' })
    expect(uncredentialed.gets).toEqual([])
    server?.stop()
    rmSync(dir!, { recursive: true, force: true })
    const credentialed = await boot({ credentialed: true })
    const res = await agentChannelIpc(credentialed.socketPath, {
      op: 'get',
      agentId: 'a1',
      capability: credentialed.daemonCapability
    })
    expect(res.ok).toBe(true)
    expect(credentialed.gets).toEqual(['a1'])
  })
})

describe('agentconnect-secrets', () => {
  async function helper(argv: string[], opts: { env?: NodeJS.ProcessEnv; secrets?: LiveSecretEntry[] } = {}) {
    const { socketPath, capability } = await boot(opts.secrets ? { secrets: opts.secrets } : {})
    const out: string[] = []
    const err: string[] = []
    const runs: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = []
    const code = await runSecretsHelper(argv, {
      socketPath,
      env: opts.env ?? {
        [AGENT_CHANNEL_AGENT_ENV]: 'a1',
        [AGENT_CHANNEL_CAPABILITY_ENV]: capability,
        PATH: '/usr/bin'
      },
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      run: async (command, args, env) => {
        runs.push({ command, args, env })
        return 7
      },
      tmpdir: () => dir!
    })
    return { code, out: out.join(''), err: err.join(''), runs }
  }

  it('lists names and descriptions only', async () => {
    const { code, out } = await helper(['list'])
    expect(code).toBe(0)
    expect(out).toBe('GRAFANA_TOKEN\tGrafana API token\nKUBE_CONFIG\n')
  })

  it('runs a command with only the named secrets added, printing nothing itself, and passes its exit code', async () => {
    const { code, out, runs } = await helper(['exec', '--only', 'GRAFANA_TOKEN', '--', 'curl', '-s', 'https://x'])
    expect(code).toBe(7)
    expect(out).toBe('')
    expect(runs[0]!.command).toBe('curl')
    expect(runs[0]!.args).toEqual(['-s', 'https://x'])
    expect(runs[0]!.env.GRAFANA_TOKEN).toBe("s3cr3t-'quoted'")
    expect(runs[0]!.env.KUBE_CONFIG).toBeUndefined()
    expect(runs[0]!.env.PATH).toBe('/usr/bin')
  })

  it('prints shell-quoted export lines for eval', async () => {
    const { code, out } = await helper(['env', 'GRAFANA_TOKEN'])
    expect(code).toBe(0)
    expect(out).toBe(`export GRAFANA_TOKEN='s3cr3t-'\\''quoted'\\'''\n`)
  })

  it('writes one secret to a private file and prints only its path', async () => {
    const { code, out } = await helper(['file', 'KUBE_CONFIG'])
    expect(code).toBe(0)
    const path = out.trim()
    expect(path.startsWith(dir!)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('apiVersion: v1')
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('with a command, names the file in NAME_FILE and removes it once the command exits', async () => {
    const { code, runs } = await helper(['file', 'KUBE_CONFIG', '--', 'kubectl', 'get', 'pods'])
    expect(code).toBe(7)
    expect(runs[0]!.command).toBe('kubectl')
    const path = runs[0]!.env.KUBE_CONFIG_FILE!
    expect(path.startsWith(dir!)).toBe(true)
    // The value never rides the environment, and the file is gone after the command.
    expect(runs[0]!.env.KUBE_CONFIG).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  it('refuses malformed calls before reaching the daemon, and names a secret it does not have', async () => {
    expect((await helper(['exec'])).code).toBe(2)
    expect((await helper(['exec', '--only', 'GRAFANA_TOKEN'])).code).toBe(2)
    expect((await helper(['exec', '--bogus', '--', 'curl'])).code).toBe(2)
    // An empty --only would run the command with no secrets and hide the mistake.
    expect((await helper(['exec', '--only', ',', '--', 'curl'])).code).toBe(2)
    expect((await helper(['exec', '--only=', '--', 'curl'])).code).toBe(2)
    expect((await helper(['file', 'KUBE_CONFIG', '--'])).code).toBe(2)
    expect((await helper(['file'])).code).toBe(2)
    expect((await helper(['env', 'lower-case'])).code).toBe(2)
    expect((await helper(['frobnicate'])).code).toBe(2)
    const missing = await helper(['env', 'NOPE_TOKEN'])
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('no live secret named NOPE_TOKEN')
  })

  it('says so when the runtime has no credential channel', async () => {
    const { code, err } = await helper(['list'], { env: { PATH: '/usr/bin' } })
    expect(code).toBe(1)
    expect(err).toContain('no AgentConnect agent channel')
  })
})
