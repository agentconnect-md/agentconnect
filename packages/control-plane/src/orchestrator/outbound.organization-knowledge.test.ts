import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ORGANIZATION_SUGGESTION_CHUNK_BYTES, type OrganizationSuggestionChunk } from '@agentconnect.md/protocol'
import type { LaunchRepo } from '../persistence/ports.js'
import { ProtocolError } from '../domain/errors.js'
import { ConnectionRegistry, type ConnChannel, type DaemonConnState } from '../ws/registry.js'
import { ControlSender } from './outbound.js'

const DAEMON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT = '11111111-1111-4111-8111-111111111111'
const CANDIDATE = '22222222-2222-4222-8222-222222222222'

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function senderWith(request: ConnChannel['request']): ControlSender {
  const conn = { daemonId: DAEMON, request, send: vi.fn(), close: vi.fn() } as unknown as ConnChannel
  const registry = new ConnectionRegistry()
  const state: DaemonConnState = {
    daemonId: DAEMON,
    conn,
    sessionEpoch: 7,
    state: 'READY',
    maxAgents: 2,
    load: { cpu: 0, mem: 0, agents: 1 },
    health: 'ok',
    lastBeatAt: 0,
    reachable: true,
    assignments: new Set(),
    launches: new Map()
  }
  registry.add(state)
  return new ControlSender(registry, {} as LaunchRepo)
}

describe('ControlSender organization suggestion content', () => {
  it('assembles bounded chunks, validates their digest, and advances by authoritative offsets', async () => {
    const content = `# Runbook\n${'x'.repeat(ORGANIZATION_SUGGESTION_CHUNK_BYTES + 4096)}`
    const body = { kind: 'knowledge' as const, content, summary: 'Large runbook', tags: ['ops'] }
    const raw = Buffer.from(JSON.stringify(body))
    const candidateDigest = digest(content)
    const request = vi.fn(async (_type: string, payload: unknown): Promise<OrganizationSuggestionChunk> => {
      const { offset, limit } = payload as { offset: number; limit: number }
      const end = Math.min(raw.byteLength, offset + limit)
      return {
        sourceAgentId: AGENT,
        dreamId: 'dream-1',
        candidateId: CANDIDATE,
        digest: candidateDigest,
        exists: true,
        size: raw.byteLength,
        offset,
        nextOffset: end,
        data: raw.subarray(offset, end).toString('base64'),
        truncated: end < raw.byteLength
      }
    })

    await expect(
      senderWith(request as unknown as ConnChannel['request']).organizationSuggestionRead(DAEMON, {
        sourceAgentId: AGENT,
        dreamId: 'dream-1',
        candidateId: CANDIDATE,
        kind: 'knowledge'
      })
    ).resolves.toEqual({
      sourceAgentId: AGENT,
      dreamId: 'dream-1',
      candidateId: CANDIDATE,
      digest: candidateDigest,
      exists: true,
      body
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenNthCalledWith(
      1,
      'knowledge/suggestion/read',
      expect.objectContaining({ offset: 0, limit: ORGANIZATION_SUGGESTION_CHUNK_BYTES }),
      { epoch: 7 },
      undefined,
      undefined
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      'knowledge/suggestion/read',
      expect.objectContaining({ offset: ORGANIZATION_SUGGESTION_CHUNK_BYTES }),
      { epoch: 7 },
      undefined,
      undefined
    )
  })

  it('returns an explicit missing value only on the first empty chunk', async () => {
    const request = vi.fn(async (): Promise<OrganizationSuggestionChunk> => ({
      sourceAgentId: AGENT,
      dreamId: 'dream-1',
      candidateId: CANDIDATE,
      digest: `sha256:${'0'.repeat(64)}`,
      exists: false,
      size: 0,
      offset: 0,
      nextOffset: 0,
      data: '',
      truncated: false
    }))
    await expect(
      senderWith(request as unknown as ConnChannel['request']).organizationSuggestionRead(DAEMON, {
        sourceAgentId: AGENT,
        dreamId: 'dream-1',
        candidateId: CANDIDATE,
        kind: 'knowledge'
      })
    ).resolves.toMatchObject({ exists: false })
  })

  it('rejects stalled chunks and a body whose content does not match the advertised digest', async () => {
    const stalled = vi.fn(async (): Promise<OrganizationSuggestionChunk> => ({
      sourceAgentId: AGENT,
      dreamId: 'dream-1',
      candidateId: CANDIDATE,
      digest: digest('expected'),
      exists: true,
      size: 10,
      offset: 0,
      nextOffset: 0,
      data: '',
      truncated: true
    }))
    await expect(
      senderWith(stalled as unknown as ConnChannel['request']).organizationSuggestionRead(DAEMON, {
        sourceAgentId: AGENT,
        dreamId: 'dream-1',
        candidateId: CANDIDATE,
        kind: 'knowledge'
      })
    ).rejects.toBeInstanceOf(ProtocolError)

    const body = Buffer.from(JSON.stringify({ kind: 'knowledge', content: 'changed' }))
    const mismatched = vi.fn(async (): Promise<OrganizationSuggestionChunk> => ({
      sourceAgentId: AGENT,
      dreamId: 'dream-1',
      candidateId: CANDIDATE,
      digest: digest('expected'),
      exists: true,
      size: body.byteLength,
      offset: 0,
      nextOffset: body.byteLength,
      data: body.toString('base64'),
      truncated: false
    }))
    await expect(
      senderWith(mismatched as unknown as ConnChannel['request']).organizationSuggestionRead(DAEMON, {
        sourceAgentId: AGENT,
        dreamId: 'dream-1',
        candidateId: CANDIDATE,
        kind: 'knowledge'
      })
    ).rejects.toThrow('mismatched digest')
  })

  // #968: a duty holder never registered the agent, so the connection's id→org map cannot name the
  // org for it. Both downlink sends therefore state it, exactly as the lifecycle sends do.
  it('states the organization explicitly on the review and content sends', async () => {
    const body = Buffer.from(JSON.stringify({ kind: 'knowledge', content: 'runbook' }))
    const seen: (string | undefined)[] = []
    const request = vi.fn(async (type: string, _payload, _ext, _opts, orgId?: string) => {
      seen.push(orgId)
      if (type === 'knowledge/suggestion/review') return {}
      return {
        sourceAgentId: AGENT,
        dreamId: 'dream-1',
        candidateId: CANDIDATE,
        digest: digest('runbook'),
        exists: true,
        size: body.byteLength,
        offset: 0,
        nextOffset: body.byteLength,
        data: body.toString('base64'),
        truncated: false
      }
    })
    const sender = senderWith(request as unknown as ConnChannel['request'])

    await sender.organizationSuggestionRead(
      DAEMON,
      { sourceAgentId: AGENT, dreamId: 'dream-1', candidateId: CANDIDATE, kind: 'knowledge' },
      'org-b'
    )
    await sender.organizationSuggestionReview(
      DAEMON,
      { sourceAgentId: AGENT, dreamId: 'dream-1', candidateId: CANDIDATE, state: 'accepted' },
      'org-b'
    )

    expect(seen).toEqual(['org-b', 'org-b'])
  })
})
