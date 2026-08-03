/**
 * Concrete-vs-virtual connection surface guard.
 *
 * The Arena's fidelity depends on VirtualSlackConnection implementing the
 * COMPLETE concrete-connection surface the daemon consumes (collaboration-arena
 * §3). When the real driver grows a member (e.g. #503's response/recipient
 * metadata stamping), this test fails until the virtual transport either
 * implements it or the exemption list below is consciously extended with a
 * justification — surface growth can never silently diverge the arena again.
 */
import { describe, expect, it } from 'vitest'
import { SlackConnection } from '../../packages/daemon/src/slack/connection.js'
import { VirtualSlackConnection } from '../../packages/daemon/src/evaluation/index.js'

/**
 * Members of the real SlackConnection the daemon does NOT consume through the
 * reply/gateway/session paths the Arena exercises. Every entry needs a reason;
 * removing an entry (because the daemon started consuming it) means the
 * virtual connection must implement it.
 */
const EXEMPT: Record<string, string> = {
  constructor: 'not a surface member',
  // Socket-mode lifecycle internals — the daemon calls start/stop, which the
  // virtual implements; these run inside the real connection only.
  rememberAssistantThread: 'private Bolt event bookkeeping',
  withAssistantThread: 'private Bolt event bookkeeping',
  rememberMissingScopes: 'private scope-error bookkeeping',
  permissionUpdateUrl: 'private permission-card helper',
  postPermissionUpdateCard: 'private permission-card helper',
  postChatMessage: 'private shared post boundary behind postMessage/postBlocks',
  // Interactive Slack surfaces (Block Kit actions / modals) are driven by
  // Bolt callbacks the virtual transport never receives; the daemon only
  // invokes them from those callbacks.
  openStatusModal: 'interactivity-only (status modal from a Bolt action)'
}

describe('virtual connection surface guard', () => {
  it('VirtualSlackConnection implements every consumed member of the real SlackConnection', () => {
    const real = Object.getOwnPropertyNames(SlackConnection.prototype)
    const virtual = new Set(Object.getOwnPropertyNames(VirtualSlackConnection.prototype))
    const missing = real.filter((name) => !(name in EXEMPT) && !virtual.has(name))
    expect(
      missing,
      `VirtualSlackConnection is missing concrete-connection members: ${missing.join(', ')}. ` +
        'Implement them in packages/daemon/src/evaluation/virtual-connections.ts (or, if the daemon ' +
        'provably never consumes them, add an EXEMPT entry with a justification).'
    ).toEqual([])
  })

  it('exemptions do not rot: every exempt name still exists on the real connection', () => {
    const real = new Set(Object.getOwnPropertyNames(SlackConnection.prototype))
    const stale = Object.keys(EXEMPT).filter((name) => name !== 'constructor' && !real.has(name))
    expect(stale, `stale EXEMPT entries (removed from SlackConnection): ${stale.join(', ')}`).toEqual([])
  })

  it('the virtual transport carries the identity fields the daemon reads off live connections', () => {
    const connection = new VirtualSlackConnection(
      'surface-int',
      { workspaceId: 'TSURFACE' },
      {
        recordOutbound: async () => ({ status: 'delivered', messageId: '1.1', sequence: 1 }),
        channelInfo: () => undefined,
        members: () => [],
        channels: () => [],
        profile: () => undefined
      }
    )
    // Read at reconcile/classification/routing sites: botUserId (mention
    // routing), botId (managed-identity suppression), appToken/botToken
    // (credential comparison), workspaceId() (Slack realm classification).
    expect(typeof connection.botUserId).toBe('string')
    expect(typeof connection.botId).toBe('string')
    expect(typeof connection.appToken).toBe('string')
    expect(typeof connection.botToken).toBe('string')
    expect(connection.workspaceId()).toBe('TSURFACE')
  })
})
