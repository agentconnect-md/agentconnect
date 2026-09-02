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
import {
  VirtualSlackConnection,
  type OutboundEffectInput,
  type OutboundEffectResult,
  type VirtualConnectionWorldPort,
  type VirtualThreadMessage
} from '../../packages/daemon/src/evaluation/index.js'

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
  postIfThreadExists: 'private Slack root-existence guard',
  postChatMessage: 'private shared post boundary behind postMessage/postBlocks',
  setSessionLifecycle: 'private agent-session lifecycle call, behind setStatus',
  noteStreamFailure: 'private streaming error classification, behind the startTurnStream trio',
  closeStream: 'private streaming handle bookkeeping, behind the startTurnStream trio',
  openStream: 'private chat.startStream call, behind startTurnStream',
  abandonStream: 'private teardown for a stream no turn owns, behind startTurnStream',
  runSettleAndStop: 'private single settle+stop attempt, behind settleAndStop',
  scheduleOwedStop: 'private owed-stop backoff, behind settleAndStop',
  forgetOwedStop: 'private owed-stop bookkeeping, behind settleAndStop',
  agentSessionStopped: 'native stop button (Bolt event / relay-forwarded), no arena equivalent',
  shareWithIdentity: 'private identity-carrying upload path, behind uploadFile',
  putUploadBytes: 'private step 2 of the external upload, behind uploadFile',
  completeUpload: 'private step 3 of the external upload, behind uploadFile',
  completeShare: 'private one-shot completion boundary, behind completeUpload',
  shareMessageTs: 'private share-ts read behind uploadFile',
  toolFailure: 'private Slack-error sanitizer behind the agent-callable actions',
  canvasLink: 'private files.info read behind createCanvas',
  canvasSections: 'private canvases.sections.lookup behind readCanvas',
  rememberSearchToken: 'private ingress-side credential parking, behind rememberInboundSearchToken',
  searchTokenFor: 'private credential lookup behind searchPublicMessages',
  // The Arena's transport receives no provider events, so nothing ever parks a credential
  // for it — and `searchPublicMessages` (which the virtual DOES implement) refuses regardless.
  rememberInboundSearchToken: 'HTTP-arm credential handoff; the Arena has no relay ingress',
  // Interactive Slack surfaces (Block Kit actions / modals) are driven by
  // Bolt callbacks the virtual transport never receives; the daemon only
  // invokes them from those callbacks.
  openStatusModal: 'interactivity-only (status modal from a Bolt action)'
}

function recordingConnection() {
  const effects: OutboundEffectInput[] = []
  const history: VirtualThreadMessage[] = []
  let sequence = 0
  const port: VirtualConnectionWorldPort = {
    recordOutbound: async (effect): Promise<OutboundEffectResult> => {
      effects.push(effect)
      sequence += 1
      const messageId = `1700000000.${String(sequence).padStart(6, '0')}`
      history.push({
        ts: messageId,
        text: effect.text,
        sender: 'UB11111111',
        isBot: true,
        ...(effect.identity?.agentAuthorId !== undefined ? { agentAuthorId: effect.identity.agentAuthorId } : {})
      })
      return { status: 'delivered', messageId, sequence }
    },
    channelInfo: () => ({ id: 'C-META', name: 'meta' }),
    members: () => [],
    channels: () => [{ id: 'C-META', name: 'meta' }],
    profile: () => undefined,
    threadHistory: () => history
  }
  const connection = new VirtualSlackConnection('meta-int', { workspaceId: 'TMETA' }, port, {
    botUserId: 'UB11111111'
  })
  return { connection, effects, history, port }
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

  it('round-trips the CURRENT per-message metadata contract through the sink and provider history', async () => {
    const { connection, effects, port } = recordingConnection()
    const ts = await connection.postMessage('C-META', 'hello', undefined, {
      username: 'Agent One',
      icon_url: 'https://icons.example.test/agent-one.png',
      agentAuthorId: 'agent-1-id'
    })
    expect(ts).toBeDefined()
    // The sink preserves the per-message identity the real connection persists
    // into Slack message metadata today.
    expect(effects[0]!.identity).toEqual({
      username: 'Agent One',
      icon_url: 'https://icons.example.test/agent-one.png',
      agentAuthorId: 'agent-1-id'
    })
    // And the provider history — what getThreadReplies/finalThreadSnapshot
    // read — carries the trusted author id, like conversations.replies with
    // include_all_metadata does.
    const replies = await connection.getThreadReplies('C-META', ts!)
    void port
    expect(replies.find((reply) => reply.text === 'hello')).toMatchObject({ agentAuthorId: 'agent-1-id' })
  })

  // Behavioral metadata round-trip (PR #520 review): prototype reflection
  // cannot catch NEW FIELDS added to existing postMessage options. #503 §4
  // landed the driver contract as `options.response` (SlackResponseMetadata)
  // plus the response-closing `finalizeResponse` edit — both must round-trip
  // through the virtual transport, or the arena silently drops exactly the
  // metadata the rework routes on. Green now; extend alongside the driver.
  it('round-trips #503 response/recipient/pairing/hop metadata (§4) through post and finalize', async () => {
    const { connection, effects, history } = recordingConnection()
    const streaming = {
      responseId: 'resp-1',
      deliveryState: 'streaming' as const,
      hopCount: 2,
      mentionedAgentIds: ['agent-2-id']
    }
    const ts = await connection.postMessage('C-META', '<@UB22222222> over to you', undefined, {
      agentAuthorId: 'agent-1-id',
      response: streaming
    })
    expect(ts).toBeDefined()
    expect(effects[0]!.response).toEqual(streaming)
    // Closing the response re-stamps the SAME message as the single final
    // routing event, carrying the complete recipient set and pairing id.
    const final = {
      responseId: 'resp-1',
      deliveryState: 'final' as const,
      hopCount: 2,
      mentionedAgentIds: ['agent-2-id'],
      agentCallDeliveryId: 'acd-1'
    }
    const closed = await connection.finalizeResponse(
      'C-META',
      ts!,
      [],
      '<@UB22222222> over to you',
      'agent-1-id',
      final
    )
    expect(closed).toBe(true)
    const finalize = effects.find((effect) => effect.kind === 'finalize')
    expect(finalize).toMatchObject({ messageTs: ts, response: final, identity: { agentAuthorId: 'agent-1-id' } })
    void history
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
