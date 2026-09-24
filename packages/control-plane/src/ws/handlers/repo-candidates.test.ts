import { buildEnvelope, decodeEnvelope, encode } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import { GithubApiError } from '../../github/api.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleRepoCandidates } from './repo-candidates.js'

const agentId = '11111111-1111-4111-8111-111111111111'
const daemonId = '22222222-2222-4222-8222-222222222222'
const orgId = 'example-org'
const reply = { candidates: [{ provider: 'github', repoFullName: 'acme/infra', repoId: '12345' }], partial: false }

function setup() {
  const agent = vi.fn(
    async () => ({ id: agentId, orgId, daemonId }) as { id: string; orgId: string; daemonId: string } | null
  )
  const forAgent = vi.fn(async () => reply)
  const conn = { daemonId, orgId, replyTo: vi.fn(), sendError: vi.fn() }
  const deps: Record<string, unknown> = { agent: { get: agent }, repoCandidates: { forAgent } }
  const decoded = decodeEnvelope(encode(buildEnvelope('repo-candidates/request', { agentId }, { orgId })))
  if (!decoded.ok) throw new Error('invalid request fixture')
  const run = () =>
    handleRepoCandidates(decoded.frame, conn as unknown as DaemonConnection, deps as unknown as DaemonWsDeps)
  return { agent, forAgent, conn, deps, run }
}

describe('repo-candidates/request', () => {
  it('answers the serving daemon with the rosters of its agent, fenced on the frame’s organization', async () => {
    const { agent, forAgent, conn, run } = setup()
    await run()
    expect(agent).toHaveBeenCalledWith(orgId, agentId)
    expect(forAgent).toHaveBeenCalledWith(expect.objectContaining({ id: agentId, orgId }))
    expect(conn.replyTo).toHaveBeenCalledWith(expect.anything(), 'repo-candidates/reply', reply)
    expect(conn.sendError).not.toHaveBeenCalled()
  })

  it('refuses another organization’s agent or a daemon that does not serve it before reading a roster', async () => {
    const { agent, forAgent, conn, run } = setup()
    agent.mockResolvedValueOnce(null)
    await run()
    agent.mockResolvedValueOnce({ id: agentId, orgId, daemonId: 'another-daemon' })
    await run()
    expect(forAgent).not.toHaveBeenCalled()
    expect(conn.replyTo).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenCalledTimes(2)
    expect(conn.sendError).toHaveBeenLastCalledWith(
      expect.any(String),
      'SCOPE_DENIED',
      'this daemon does not serve that agent',
      false
    )
  })

  it('rechecks placement after the roster read', async () => {
    const { agent, conn, run } = setup()
    agent.mockResolvedValueOnce({ id: agentId, orgId, daemonId }).mockResolvedValueOnce(null)
    await run()
    expect(conn.replyTo).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenCalledWith(
      expect.any(String),
      'SCOPE_DENIED',
      'this daemon no longer serves that agent',
      false
    )
  })

  it('passes GitHub failures through as their own codes, and anything else as a retryable INTERNAL', async () => {
    const { forAgent, conn, run } = setup()
    forAgent.mockRejectedValueOnce(new GithubApiError('rate limited', 429, 'RATE_LIMITED', true))
    await run()
    expect(conn.sendError).toHaveBeenLastCalledWith(expect.any(String), 'RATE_LIMITED', 'github: rate limited', true)
    forAgent.mockRejectedValueOnce(new Error('database unavailable'))
    await run()
    expect(conn.sendError).toHaveBeenLastCalledWith(
      expect.any(String),
      'INTERNAL',
      'repository candidates could not be read',
      true
    )
    expect(conn.replyTo).not.toHaveBeenCalled()
  })

  it('refuses when this control plane has no rosters to read', async () => {
    const { deps, agent, conn, run } = setup()
    delete deps.repoCandidates
    await run()
    expect(agent).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenCalledWith(
      expect.any(String),
      'SCOPE_DENIED',
      'repository candidates are unavailable for this organization',
      false
    )
  })
})
