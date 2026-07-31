import { describe, expect, it } from 'vitest'
import { buildEnvelope, type McpInvocationMint } from '@agentconnect.md/protocol'
import { WireError } from '@agentconnect.md/connection'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeClock } from './fake-clock.js'
import { FakeTransport } from './fake-transport.js'

const INVOCATION_ID = '11111111-1111-4111-8111-111111111111'
const DELEGATION_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444'

const mint: McpInvocationMint = {
  delegationId: DELEGATION_ID,
  generation: 3,
  agentId: AGENT_ID,
  conversationId: CONVERSATION_ID,
  invocationId: INVOCATION_ID,
  requestHash: 'a'.repeat(64),
  method: 'tools/call',
  toolName: 'listAgents'
}

function clientIn(state: CpClient['state']) {
  const transport = new FakeTransport()
  const client = new CpClient({ clock: new FakeClock() } as CpClientDeps)
  Object.assign(client as unknown as { state: CpClient['state']; transport: FakeTransport }, {
    state,
    transport
  })
  return { client, transport }
}

async function settle(client: CpClient, frame: unknown) {
  await (client as unknown as { onText(text: string): Promise<void> }).onText(JSON.stringify(frame))
}

describe('CpClient delegated MCP requests', () => {
  it.each(['CLOSED', 'CONNECTING', 'AUTHENTICATING', 'REGISTERING', 'DEGRADED'] as const)(
    'fails mint and revoke immediately while %s',
    async (state) => {
      const { client, transport } = clientIn(state)

      await expect(client.mintMcpInvocation(mint)).rejects.toMatchObject({
        name: 'WireError',
        retryable: true
      })
      await expect(
        client.revokeWebchatMcpDelegation({
          delegationId: DELEGATION_ID,
          generation: 3,
          reason: 'session_expired'
        })
      ).rejects.toMatchObject({ name: 'WireError', retryable: true })
      expect(transport.sent).toHaveLength(0)
    }
  )

  it.each(['READY', 'DRAINING'] as const)(
    'mints only from %s and requires the exact correlated reply type',
    async (state) => {
      const { client, transport } = clientIn(state)
      const pending = client.mintMcpInvocation(mint)
      const request = transport.lastSent()
      expect(request).toMatchObject({ type: 'mcp/invocation/mint', payload: mint })

      await settle(
        client,
        buildEnvelope(
          'mcp/invocation/minted',
          {
            invocationId: INVOCATION_ID,
            assertion: 'ac_inv_assertion',
            expiresAt: '2026-07-31T00:00:30.000Z'
          },
          { corr: request.id }
        )
      )
      await expect(pending).resolves.toEqual({
        invocationId: INVOCATION_ID,
        assertion: 'ac_inv_assertion',
        expiresAt: '2026-07-31T00:00:30.000Z'
      })
    }
  )

  it('rejects a correlated reply with the wrong semantic type or invocation echo', async () => {
    const first = clientIn('READY')
    const wrongType = first.client.mintMcpInvocation(mint)
    const firstRequest = first.transport.lastSent()
    await settle(
      first.client,
      buildEnvelope(
        'webchat/mcp-delegation/revoked',
        { delegationId: DELEGATION_ID, generation: 3, revoked: false },
        { corr: firstRequest.id }
      )
    )
    await expect(wrongType).rejects.toThrow('expected mcp/invocation/minted')

    const second = clientIn('READY')
    const wrongEcho = second.client.mintMcpInvocation(mint)
    const secondRequest = second.transport.lastSent()
    await settle(
      second.client,
      buildEnvelope(
        'mcp/invocation/minted',
        {
          invocationId: '55555555-5555-4555-8555-555555555555',
          assertion: 'ac_inv_assertion',
          expiresAt: '2026-07-31T00:00:30.000Z'
        },
        { corr: secondRequest.id }
      )
    )
    await expect(wrongEcho).rejects.toThrow('invocation id mismatch')
  })

  it('sends a fenced revoke and validates its correlated echo', async () => {
    const { client, transport } = clientIn('READY')
    const payload = {
      delegationId: DELEGATION_ID,
      generation: 3,
      reason: 'agent_detached' as const
    }
    const pending = client.revokeWebchatMcpDelegation(payload)
    const request = transport.lastSent()
    expect(request).toMatchObject({ type: 'webchat/mcp-delegation/revoke', payload })

    await settle(
      client,
      buildEnvelope(
        'webchat/mcp-delegation/revoked',
        { delegationId: DELEGATION_ID, generation: 3, revoked: true },
        { corr: request.id }
      )
    )
    await expect(pending).resolves.toEqual({ delegationId: DELEGATION_ID, generation: 3, revoked: true })
  })

  it('preserves typed control-plane denial errors', async () => {
    const { client, transport } = clientIn('READY')
    const pending = client.mintMcpInvocation(mint)
    const request = transport.lastSent()
    await settle(
      client,
      buildEnvelope(
        'error',
        { code: 'DELEGATION_DENIED', message: 'Delegated MCP invocation is not authorized.', retryable: false },
        { corr: request.id }
      )
    )

    await expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<WireError>>({ code: 'DELEGATION_DENIED', retryable: false })
    )
  })
})
