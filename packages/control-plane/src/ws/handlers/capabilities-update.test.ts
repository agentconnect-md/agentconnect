/**
 * `capabilities/update` — the mid-connection full-replace of a daemon's
 * registered capabilities. The live ConnectionRegistry copy is what every hot
 * gate reads (webchat remote-MCP verification, org-knowledge), so the handler
 * must update it in place; the C4 row is the durable sibling.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope, type RegisterReq } from '@agentconnect.md/protocol'
import { handleCapabilitiesUpdate } from './capabilities-update.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'

const CAPS: RegisterReq['capabilities'] = {
  platforms: ['slack'],
  runtimes: ['Claude Agent'],
  acp: true,
  features: ['webchat_remote_mcp_v1']
}

function fakeDeps(state?: { capabilities?: RegisterReq['capabilities'] }) {
  const updateCapabilities = vi.fn(async () => {})
  const deps = {
    connReg: { get: (id: string) => (id === DAEMON ? state : undefined) },
    registry: { updateCapabilities }
  } as unknown as DaemonWsDeps
  return { deps, updateCapabilities }
}

const conn = { daemonId: DAEMON } as unknown as DaemonConnection

describe('handleCapabilitiesUpdate', () => {
  it('replaces the live capabilities AND persists the durable row', async () => {
    const state: { capabilities?: RegisterReq['capabilities'] } = {
      capabilities: { platforms: [], runtimes: [], acp: true, features: [] }
    }
    const { deps, updateCapabilities } = fakeDeps(state)
    await handleCapabilitiesUpdate(buildEnvelope('capabilities/update', { capabilities: CAPS }), conn, deps)
    expect(state.capabilities).toEqual(CAPS)
    expect(updateCapabilities).toHaveBeenCalledWith(DAEMON, CAPS)
  })

  it('still persists when the live index has no entry for the connection', async () => {
    const { deps, updateCapabilities } = fakeDeps(undefined)
    await handleCapabilitiesUpdate(buildEnvelope('capabilities/update', { capabilities: CAPS }), conn, deps)
    expect(updateCapabilities).toHaveBeenCalledWith(DAEMON, CAPS)
  })

  it('ignores a frame of another type', async () => {
    const { deps, updateCapabilities } = fakeDeps({ capabilities: CAPS })
    await handleCapabilitiesUpdate(
      buildEnvelope('heartbeat', { load: {}, health: 'ok', activeSessions: 0 }),
      conn,
      deps
    )
    expect(updateCapabilities).not.toHaveBeenCalled()
  })
})
