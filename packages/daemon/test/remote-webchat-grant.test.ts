import { describe, expect, it, vi } from 'vitest'
import { RemoteWebchatGrantManager } from '../src/mcp/remote-webchat-grant.js'

const authorityId = '11111111-1111-4111-8111-111111111111'
const conversationId = '22222222-2222-4222-8222-222222222222'
const grantId = '33333333-3333-4333-8333-333333333333'
const entitlement = {
  authorityId,
  authorityGeneration: 2,
  expiresAt: '2030-01-01T00:00:00.000Z'
}

describe('RemoteWebchatGrantManager', () => {
  it('installs a private descriptor only after exact two-phase activation', async () => {
    const issueWebchatMcpGrant = vi.fn(async (input: any) => ({
      ...input,
      grantId,
      grantRevision: 7,
      token: 'secret-token-that-is-longer-than-thirty-two-bytes',
      expiresAt: '2030-01-01T00:00:00.000Z',
      mcpUrl: 'https://cp.example/api/v1/mcp'
    }))
    const acceptWebchatMcpGrant = vi.fn(async (input: any) => ({ ...input, activated: true }))
    const manager = new RemoteWebchatGrantManager({
      issueWebchatMcpGrant,
      acceptWebchatMcpGrant,
      revokeWebchatMcpGrant: vi.fn(async (input: any) => ({ ...input, revoked: true }))
    })

    const descriptor = await manager.descriptor(conversationId, entitlement, 0)

    expect(descriptor).toMatchObject({
      type: 'http',
      name: 'agentconnect-admin',
      url: 'https://cp.example/api/v1/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer secret-token-that-is-longer-than-thirty-two-bytes' }]
    })
    expect(acceptWebchatMcpGrant).toHaveBeenCalledWith(
      expect.objectContaining({ grantId, authorityGeneration: 2, grantRevision: 7 })
    )
    expect(await manager.descriptor(conversationId, entitlement, 0)).toBe(descriptor)
    expect(issueWebchatMcpGrant).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale revision before activation', async () => {
    const manager = new RemoteWebchatGrantManager({
      issueWebchatMcpGrant: vi.fn().mockResolvedValueOnce({
        authorityId,
        authorityGeneration: 2,
        conversationId,
        descriptorInstanceId: '44444444-4444-5444-8444-444444444444',
        grantId,
        grantRevision: 7,
        token: 'secret-token-that-is-longer-than-thirty-two-bytes',
        expiresAt: '2030-01-01T00:00:00.000Z',
        mcpUrl: 'https://cp.example/api/v1/mcp'
      }),
      acceptWebchatMcpGrant: vi.fn(async (input: any) => ({ ...input, activated: true })),
      revokeWebchatMcpGrant: vi.fn(async (input: any) => ({ ...input, revoked: true }))
    })
    await expect(manager.descriptor(conversationId, entitlement, 0)).rejects.toThrow(/mismatched/)
  })

  it('rotates five minutes before expiry and reports that session reload is required', async () => {
    const firstExpiry = Date.parse('2030-01-01T00:00:00.000Z')
    let revision = 0
    const manager = new RemoteWebchatGrantManager({
      issueWebchatMcpGrant: vi.fn(async (input: any) => {
        revision += 1
        return {
          ...input,
          grantId: revision === 1 ? grantId : '55555555-5555-4555-8555-555555555555',
          grantRevision: revision,
          token: `secret-token-${revision}-that-is-longer-than-thirty-two-bytes`,
          expiresAt: new Date(firstExpiry + (revision - 1) * 30 * 60_000).toISOString(),
          mcpUrl: 'https://cp.example/api/v1/mcp'
        }
      }),
      acceptWebchatMcpGrant: vi.fn(async (input: any) => ({ ...input, activated: true })),
      revokeWebchatMcpGrant: vi.fn(async (input: any) => ({ ...input, revoked: true }))
    })

    expect((await manager.provision(conversationId, entitlement, 0)).changed).toBe(true)
    expect((await manager.provision(conversationId, entitlement, firstExpiry - 6 * 60_000)).changed).toBe(false)
    expect((await manager.provision(conversationId, entitlement, firstExpiry - 4 * 60_000)).changed).toBe(true)
  })

  const workingClient = () => ({
    issueWebchatMcpGrant: vi.fn(async (input: any) => ({
      ...input,
      grantId,
      grantRevision: 7,
      token: 'secret-token-that-is-longer-than-thirty-two-bytes',
      expiresAt: '2030-01-01T00:00:00.000Z',
      mcpUrl: 'https://cp.example/api/v1/mcp'
    })),
    acceptWebchatMcpGrant: vi.fn(async (input: any) => ({ ...input, activated: true })),
    revokeWebchatMcpGrant: vi.fn(async (input: any) => ({ ...input, revoked: true }))
  })
  const fakeLedger = () => ({ recordActive: vi.fn(), markRevoking: vi.fn(), clear: vi.fn() })

  it('records the provisioned authority tuple in the durable ledger', async () => {
    const ledger = fakeLedger()
    const manager = new RemoteWebchatGrantManager(workingClient(), ledger)
    await manager.provision(conversationId, entitlement, 0, 'agent-1')
    expect(ledger.recordActive).toHaveBeenCalledWith({
      conversationId,
      agentId: 'agent-1',
      authorityId,
      authorityGeneration: 2
    })
    expect(ledger.markRevoking).not.toHaveBeenCalled()
  })

  it('carries the agent organization through issue, accept, and revoke', async () => {
    const client = workingClient()
    const manager = new RemoteWebchatGrantManager(client, undefined, (agentId) =>
      agentId === 'agent-1' ? 'org-1' : undefined
    )

    await manager.provision(conversationId, entitlement, 0, 'agent-1')
    await manager.revokeConversation(conversationId, 'session_expired')

    expect(client.issueWebchatMcpGrant).toHaveBeenCalledWith(expect.any(Object), 'org-1')
    expect(client.acceptWebchatMcpGrant).toHaveBeenCalledWith(expect.any(Object), 'org-1')
    expect(client.revokeWebchatMcpGrant).toHaveBeenCalledWith(expect.any(Object), 'org-1')
  })

  it('clears the ledger only after the CP confirms revocation', async () => {
    const ledger = fakeLedger()
    const client = workingClient()
    const manager = new RemoteWebchatGrantManager(client, ledger)
    await manager.provision(conversationId, entitlement, 0, 'agent-1')
    await manager.revokeConversation(conversationId, 'session_expired')
    expect(client.revokeWebchatMcpGrant).toHaveBeenCalledWith({
      authorityId,
      authorityGeneration: 2,
      conversationId,
      reason: 'session_expired'
    })
    expect(ledger.clear).toHaveBeenCalledWith({ conversationId, authorityId, authorityGeneration: 2 })
    expect(ledger.markRevoking).not.toHaveBeenCalled()
  })

  it('queues a durable revocation and forgets the descriptor when the remote revoke fails', async () => {
    const ledger = fakeLedger()
    const client = workingClient()
    client.revokeWebchatMcpGrant = vi.fn(async () => {
      throw new Error('control plane unreachable')
    })
    const manager = new RemoteWebchatGrantManager(client, ledger)
    await manager.provision(conversationId, entitlement, 0, 'agent-1')
    await expect(manager.revokeAgent('agent-1', 'agent_detached')).rejects.toThrow(/revoke failed/)
    expect(ledger.markRevoking).toHaveBeenCalledWith({
      conversationId,
      agentId: 'agent-1',
      authorityId,
      authorityGeneration: 2,
      reason: 'agent_detached'
    })
    expect(ledger.clear).not.toHaveBeenCalled()
    // Drop the plaintext descriptor once revocation is queued so nothing can reuse it.
    await expect(manager.revokeAgent('agent-1', 'agent_detached')).resolves.toBeUndefined()
    expect(client.revokeWebchatMcpGrant).toHaveBeenCalledTimes(1)
  })
})
