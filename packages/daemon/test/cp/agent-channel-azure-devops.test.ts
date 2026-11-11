// An Azure DevOps credential is presented by the proxy and the daemon's own Git alone (azure-devops-integration.md §6.1): the helper channel refuses it, and each lease names its consumer.
import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitCredGrant } from '@agentconnect.md/protocol'
import {
  GitCredentialCache,
  GitCredUnavailableError,
  proxyOnlyRefusal,
  type GitCredentialCacheDeps
} from '../../src/cp/git-credential.js'
import { AgentChannelServer, agentChannelSocketPath, RUNTIME_NO_MINT_ERROR } from '../../src/cp/agent-channel-server.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const IDENTITY = '00000000-0000-4000-8000-0000000000a1'
const WORKSPACE = 'example-org/Example Project/Example Repo'
const SECOND = 'example-org/Example Project/Second Repo'

describe('the helper channel', () => {
  let dir: string | undefined
  let server: AgentChannelServer | undefined
  afterEach(() => {
    server?.stop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  async function boot() {
    dir = mkdtempSync(join(tmpdir(), 'gitcred-azure-'))
    const sockPath = agentChannelSocketPath(dir)
    const gets: { agentId: string; opts: Record<string, unknown> }[] = []
    const fakeCache = {
      get: async (agentId: string, _reason: string, opts: Record<string, unknown> = {}) => {
        gets.push({ agentId, opts })
        return { username: IDENTITY, token: 'azure-token', repoFullName: WORKSPACE, access: 'write', expiresAtMono: 0 }
      },
      invalidate: () => {}
    }
    server = new AgentChannelServer(fakeCache as unknown as GitCredentialCache, sockPath, {
      log: { info: () => {}, warn: () => {} },
      providerOf: () => 'azure-devops',
      workspaceRepoOf: () => WORKSPACE,
      workspaceRepoIdOf: () => '42',
      qualifiedRepoOf: (_agentId, repoFullName) =>
        repoFullName.toLowerCase() === SECOND.toLowerCase()
          ? { provider: 'azure-devops', externalId: '43' }
          : repoFullName.toLowerCase() === 'example-group/example-project'
            ? { provider: 'gitlab', externalId: '7' }
            : undefined,
      githubAdditionalRepoOf: (_agentId, repoFullName) => repoFullName === 'acme/tools',
      credentialedOf: () => true
    })
    const daemon = server.capabilityFor(AGENT, 'daemon')
    const runtime = server.capabilityFor(AGENT, 'runtime')
    await server.start()
    return { sockPath, gets, daemon, runtime }
  }

  /** One ask on the helper socket; `greeting` first makes it a tunnel's from inside a boundary. */
  function ask(sockPath: string, msg: Record<string, unknown>, greeting?: Buffer): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(sockPath)
      let buf = ''
      sock.on('connect', () => {
        if (greeting) sock.write(greeting)
        sock.write(`${JSON.stringify({ op: 'get', agentId: AGENT, ...msg })}\n`)
      })
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        const nl = buf.indexOf('\n')
        if (nl === -1) return
        sock.destroy()
        resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>)
      })
      sock.on('error', reject)
    })
  }

  it('refuses the runtime an Azure DevOps credential by the provider’s own rule, before the runtime’s general one', async () => {
    const { sockPath, gets, runtime } = await boot()
    const refusal = { ok: false, error: proxyOnlyRefusal('azure-devops'), denied: 'agent' }
    expect(await ask(sockPath, { capability: runtime })).toEqual(refusal)
    expect(
      await ask(sockPath, { capability: runtime, provider: 'azure-devops', repoFullName: SECOND.toLowerCase() })
    ).toEqual(refusal)
    // Any other provider the runtime asks for meets the general rule instead.
    expect(await ask(sockPath, { capability: runtime, repoFullName: 'acme/tools' })).toMatchObject({
      ok: false,
      error: RUNTIME_NO_MINT_ERROR
    })
    expect(gets).toEqual([])
  })

  it('serves the daemon’s own Git, naming it as the consumer', async () => {
    const { sockPath, gets, daemon } = await boot()
    // What the helper parses from git's path on dev.azure.com, lower-cased.
    expect(
      await ask(sockPath, { capability: daemon, provider: 'azure-devops', repoFullName: WORKSPACE.toLowerCase() })
    ).toMatchObject({ ok: true, username: IDENTITY, password: 'azure-token' })
    expect(
      await ask(sockPath, { capability: daemon, provider: 'azure-devops', repoFullName: SECOND.toLowerCase() })
    ).toMatchObject({ ok: true })
    expect(gets).toEqual([
      { agentId: AGENT, opts: { plane: 'git', provider: 'azure-devops', externalRepoId: '42', consumer: 'daemon' } },
      {
        agentId: AGENT,
        opts: {
          plane: 'git',
          repo: SECOND.toLowerCase(),
          provider: 'azure-devops',
          externalRepoId: '43',
          consumer: 'daemon'
        }
      }
    ])
  })

  it('refuses the daemon’s own capability through a tunnel from inside a boundary, and still serves it another provider there', async () => {
    const { sockPath, gets, daemon } = await boot()
    const greeting = server!.tunnelGreeting(`${AGENT}/session-000000000000000000000000`)
    const refusal = { ok: false, error: proxyOnlyRefusal('azure-devops'), denied: 'agent' }
    expect(await ask(sockPath, { capability: daemon }, greeting)).toEqual(refusal)
    expect(
      await ask(
        sockPath,
        { capability: daemon, provider: 'azure-devops', repoFullName: SECOND.toLowerCase() },
        greeting
      )
    ).toEqual(refusal)
    expect(gets).toEqual([])
    // A GitHub repository's credential reaches the daemon's Git in a pod or a VM as before.
    expect(await ask(sockPath, { capability: daemon, repoFullName: 'acme/tools' }, greeting)).toMatchObject({
      ok: true
    })
    expect(gets).toHaveLength(1)
  })

  it('names no consumer for a provider that is not proxy-only', async () => {
    const { sockPath, gets, daemon } = await boot()
    await ask(sockPath, { capability: daemon, repoFullName: 'acme/tools' })
    expect(gets.at(-1)?.opts).not.toHaveProperty('consumer')
  })
})

function grant(overrides: Partial<GitCredGrant> = {}): GitCredGrant {
  return {
    username: IDENTITY,
    token: 'azure-token-1',
    ttlSec: 3000,
    expiresAt: '2026-11-07T13:00:00.000Z',
    repoFullName: WORKSPACE,
    access: 'write',
    provider: 'azure-devops',
    externalRepoId: '42',
    credentialEpoch: '3',
    ...overrides
  }
}

function cache(respond: (payload: Parameters<GitCredentialCacheDeps['request']>[0], n: number) => GitCredGrant) {
  const seen: Parameters<GitCredentialCacheDeps['request']>[0][] = []
  const credentials = new GitCredentialCache({
    request: async (payload) => {
      seen.push(payload)
      return respond(payload, seen.length)
    },
    log: { warn: () => {} },
    providerV2Supported: () => true,
    monoNow: () => 0
  })
  return { credentials, seen }
}

describe('the credential cache', () => {
  it('refuses an Azure DevOps ask that names no proxy or daemon consumer, without asking the control plane', async () => {
    const { credentials, seen } = cache(() => grant())
    for (const consumer of [undefined, 'helper'] as const) {
      const refused = credentials.get(AGENT, 'helper', {
        provider: 'azure-devops',
        externalRepoId: '42',
        ...(consumer ? { consumer } : {})
      })
      await expect(refused).rejects.toBeInstanceOf(GitCredUnavailableError)
      await expect(refused).rejects.toThrow(proxyOnlyRefusal('azure-devops'))
    }
    expect(seen).toEqual([])
    await credentials.get(AGENT, 'clone', { provider: 'azure-devops', externalRepoId: '42', consumer: 'daemon' })
    expect(seen).toEqual([
      { agentId: AGENT, reason: 'clone', provider: 'azure-devops', externalRepoId: '42', consumer: 'daemon' }
    ])
  })

  it('leases the proxy a repository in its own keyspace per access, naming the proxy as the consumer', async () => {
    const { credentials, seen } = cache((payload, n) =>
      grant({
        token: `azure-token-${n}`,
        access: payload.requestedAccess === 'read' ? 'read' : 'write',
        ...(payload.repoFullName ? { repoFullName: payload.repoFullName, externalRepoId: '43' } : {})
      })
    )
    const read = await credentials.getProxyLease(AGENT, {
      provider: 'azure-devops',
      externalRepoId: '42',
      requestedAccess: 'read'
    })
    const again = await credentials.getProxyLease(AGENT, {
      provider: 'azure-devops',
      externalRepoId: '42',
      requestedAccess: 'read'
    })
    const tier = await credentials.getProxyLease(AGENT, { provider: 'azure-devops', externalRepoId: '42' })
    const second = await credentials.getProxyLease(AGENT, {
      provider: 'azure-devops',
      externalRepoId: '43',
      repoFullName: SECOND
    })
    // A read lease never answers a push: the agent's tier is its own entry.
    expect([read.access, again.token, tier.access, second.access]).toEqual(['read', read.token, 'write', 'write'])
    expect(read.credentialEpoch).toBe('3')
    expect(seen).toEqual([
      {
        agentId: AGENT,
        reason: 'helper',
        provider: 'azure-devops',
        externalRepoId: '42',
        consumer: 'proxy',
        requestedAccess: 'read'
      },
      { agentId: AGENT, reason: 'helper', provider: 'azure-devops', externalRepoId: '42', consumer: 'proxy' },
      {
        agentId: AGENT,
        reason: 'helper',
        provider: 'azure-devops',
        externalRepoId: '43',
        consumer: 'proxy',
        repoFullName: SECOND
      }
    ])
  })

  it('asks the control plane to refresh exactly once after the upstream rejected a lease', async () => {
    const { credentials, seen } = cache((_payload, n) => grant({ token: `azure-token-${n}` }))
    const lease = { provider: 'azure-devops', externalRepoId: '42', requestedAccess: 'read' } as const
    const first = await credentials.getProxyLease(AGENT, lease)
    // Another token than the cached one drops nothing.
    credentials.invalidateProxyLease(AGENT, lease, 'azure-token-other')
    expect((await credentials.getProxyLease(AGENT, lease)).token).toBe(first.token)
    credentials.invalidateProxyLease(AGENT, lease, first.token)
    expect((await credentials.getProxyLease(AGENT, lease)).token).toBe('azure-token-2')
    expect(seen.map((payload) => payload.forceRefresh)).toEqual([undefined, true])
  })

  it('verifies the grant echo as for every provider, and serves no wrong-repository or unqualified grant', async () => {
    for (const echo of [{ provider: 'gitea' as const }, { externalRepoId: '99' }, { provider: undefined }]) {
      const { credentials } = cache(() => grant(echo))
      await expect(
        credentials.getProxyLease(AGENT, { provider: 'azure-devops', externalRepoId: '42' })
      ).rejects.toThrow(GitCredUnavailableError)
    }
    const renamed = cache(() => grant({ repoFullName: 'example-org/Example Project/Renamed Repo' }))
    await expect(
      renamed.credentials.getProxyLease(AGENT, {
        provider: 'azure-devops',
        externalRepoId: '42',
        repoFullName: WORKSPACE
      })
    ).rejects.toThrow(GitCredUnavailableError)
  })

  it('leases nothing from a control plane without provider-qualified grants', async () => {
    const { seen } = cache(() => grant())
    const older = new GitCredentialCache({
      request: async () => grant(),
      log: { warn: () => {} },
      providerV2Supported: () => false
    })
    await expect(older.getProxyLease(AGENT, { provider: 'azure-devops', externalRepoId: '42' })).rejects.toThrow(
      /too old/
    )
    expect(seen).toEqual([])
  })
})
