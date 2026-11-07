import {
  buildEnvelope,
  decodeEnvelope,
  encode,
  type AgentModelProvider,
  type ProviderKeyProvider
} from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleProviderCredentials } from './provider-credentials.js'

const agentId = '11111111-1111-4111-8111-111111111111'
const daemonId = '22222222-2222-4222-8222-222222222222'
const orgId = 'example-org'
const credentials = {
  apiKey: 'example-key',
  endpoint: 'https://gateway.example.test',
  headers: { 'x-extra': 'example-header' }
}

function setup(provider: ProviderKeyProvider = 'typesafe', modelProvider?: AgentModelProvider) {
  const agent = vi.fn(async () => ({ id: agentId, orgId, daemonId, ...(modelProvider ? { modelProvider } : {}) }))
  const get = vi.fn(async () => credentials as typeof credentials | null)
  const conn = { daemonId, orgId, replyTo: vi.fn(), sendError: vi.fn() }
  const deps = { agent: { get: agent }, providerKey: { get } }
  const decoded = decodeEnvelope(
    encode(buildEnvelope('provider-credentials/request', { agentId, provider }, { orgId }))
  )
  if (!decoded.ok) throw new Error('invalid request fixture')
  const run = () =>
    handleProviderCredentials(decoded.frame, conn as unknown as DaemonConnection, deps as unknown as DaemonWsDeps)
  return { agent, get, conn, deps, run }
}

describe('provider credential delivery', () => {
  it('delivers the current organization connection and represents only absence as null', async () => {
    const { get, conn, run } = setup()
    await run()
    expect(get).toHaveBeenCalledWith(orgId, 'typesafe')
    expect(conn.replyTo).toHaveBeenLastCalledWith(expect.anything(), 'provider-credentials/reply', { credentials })
    get.mockResolvedValueOnce(null)
    await run()
    expect(conn.replyTo).toHaveBeenLastCalledWith(expect.anything(), 'provider-credentials/reply', {
      credentials: null
    })
  })

  it('refuses a foreign organization or lost placement before reading a secret', async () => {
    const { agent, get, conn, run } = setup()
    agent.mockResolvedValueOnce(null as never)
    await run()
    agent.mockResolvedValueOnce({ id: agentId, orgId, daemonId: 'another-daemon' })
    await run()
    expect(get).not.toHaveBeenCalled()
    expect(agent).toHaveBeenCalledWith(orgId, agentId)
    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
  })

  it('rechecks placement after decrypting and keeps read failures distinct from absent credentials', async () => {
    const { agent, get, conn, run } = setup()
    agent.mockResolvedValueOnce({ id: agentId, orgId, daemonId }).mockResolvedValueOnce(null as never)
    await run()
    expect(conn.replyTo).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenLastCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
    get.mockRejectedValueOnce(new Error('example-secret-must-stay-private'))
    await run()
    expect(conn.sendError).toHaveBeenLastCalledWith(
      expect.any(String),
      'INTERNAL',
      'provider credentials could not be read',
      true
    )
    expect(conn.replyTo).not.toHaveBeenCalled()
  })

  it.each([
    ['anthropic', 'anthropic'],
    ['openai', 'openai'],
    ['auto', 'anthropic'],
    ['auto', 'openai']
  ] as const)(
    'delivers a %s model provider agent its %s key for launches and provider slots',
    async (model, provider) => {
      const { get, conn, run } = setup(provider, model)
      await run()
      expect(get).toHaveBeenCalledWith(orgId, provider)
      expect(conn.replyTo).toHaveBeenLastCalledWith(expect.anything(), 'provider-credentials/reply', { credentials })
    }
  )

  it.each(['typesafe', 'openai'] as const)(
    'delivers the %s Decision provider key to an agent without a model provider',
    async (provider) => {
      const { get, conn, run } = setup(provider)
      await run()
      expect(get).toHaveBeenCalledWith(orgId, provider)
      expect(conn.replyTo).toHaveBeenLastCalledWith(expect.anything(), 'provider-credentials/reply', { credentials })
    }
  )

  it.each([
    ['anthropic', undefined],
    ['anthropic', 'openai'],
    ['openrouter', 'auto'],
    ['cloudflare', 'anthropic']
  ] as const)('refuses a configured %s key to an agent whose model provider is %s', async (provider, model) => {
    const { get, conn, run } = setup(provider, model)
    await run()
    expect(get).not.toHaveBeenCalled()
    expect(conn.replyTo).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenLastCalledWith(
      expect.any(String),
      'SCOPE_DENIED',
      'that agent does not use this provider',
      false
    )
  })

  it('rechecks the provider after reading and withholds a key the agent stopped using', async () => {
    const { agent, get, conn, run } = setup('anthropic', 'anthropic')
    agent
      .mockResolvedValueOnce({ id: agentId, orgId, daemonId, modelProvider: 'anthropic' })
      .mockResolvedValueOnce({ id: agentId, orgId, daemonId, modelProvider: 'openai' })
    await run()
    expect(get).toHaveBeenCalledWith(orgId, 'anthropic')
    expect(conn.replyTo).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenLastCalledWith(
      expect.any(String),
      'SCOPE_DENIED',
      'that agent no longer uses this provider',
      false
    )
  })
})
