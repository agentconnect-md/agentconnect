/**
 * Reusable daemon-level webchat multi-agent fixture, extracted from the #906
 * continuation tests (`daemon-webchat-continuation.test.ts`) so the
 * cross-surface activation parity leg (`evals/test/parity-webchat.test.ts`)
 * can drive the exact same seam: `handleRelayMsg` fed the relay's
 * pre-addressed `turn` frames, with the §5.2 roster fan-out of committed
 * posts (`context` frames) played by the caller — no relay process, no
 * platform SDKs, no credentials.
 *
 * The helpers deliberately stay 1:1 with what the #906 tests inlined; the
 * behavior under test is the DAEMON's (webchat-multi-agents.md §5.2a).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Daemon } from '../src/daemon.js'
import type { RdMsgWebchat, RdWebchatPost, WebchatPost } from '@agentconnect.md/protocol'

/** The standing response-choice sentinel (product-conventions §No-response). */
export const NO_RESPONSE = 'AC_NO_RESPONSE'

/** Scaffold a control-plane-less daemon root with one stub agent per id. */
export function scaffold(agentIds: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-wc-cont-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { turnFinalContextRefresh: true },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  for (const id of agentIds) {
    const adir = join(root, 'agents', id)
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id,
        name: id,
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
  }
  return root
}

/** One scripted per-agent ACP host: every prompt resolves immediately with
 *  `reply(promptText)` streamed as a single message chunk. */
export function scriptedHosts(replies: Record<string, (prompt: string) => string | Promise<string>>) {
  // Eagerly seeded so "was never prompted" asserts read an empty list, not undefined.
  const prompts = new Map<string, string[]>(Object.keys(replies).map((id) => [id, []]))
  let sessionSeq = 0
  const factory = (agent: { id: string }, onUpdate: (sid: string, u: unknown) => void) => {
    const agentId = agent.id
    if (!prompts.has(agentId)) prompts.set(agentId, [])
    return {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-cont-${agentId}-${++sessionSeq}`),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sid: string, blocks: { text?: string }[]) => {
        const text = blocks.map((b) => b.text ?? '').join('\n')
        prompts.get(agentId)!.push(text)
        const reply = await replies[agentId]!(text)
        onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    } as any
  }
  return { factory, prompts }
}

export function fakeCpClient() {
  // Org-scoped: this daemon owns its agents outright and is not duty-governed.
  return {
    emitUsageReport: vi.fn(),
    emitSessionActivity: vi.fn(),
    organizationScope: () => 'connection' as const,
    stop: vi.fn(async () => {})
  }
}

/** Frame factory bound to one conversation id — mirrors the relay's
 *  pre-addressed `rd/msg` shape. `defaultAgentId` is the addressee used when a
 *  call does not override it. */
export function rdFactory(conversationId: string, defaultAgentId: string) {
  return (payload: RdMsgWebchat['payload'], over: Partial<RdMsgWebchat> = {}): RdMsgWebchat => ({
    source: 'webchat',
    agentId: defaultAgentId,
    sessionKey: conversationId,
    msgId: 'm-1',
    chatId: conversationId,
    payload,
    ...over
  })
}

/** Seed the flat org directory so `admits()` (checked per continuation edge, like the
 *  platform ladder) passes for every roster pair. */
export function seedCallPolicy(daemon: Daemon, agentIds: string[], over: Record<string, object> = {}): void {
  ;(daemon as any).cpCollab.replace({
    generation: 1,
    channels: [],
    agents: agentIds.map((agentId) => ({
      agentId,
      orgId: 'org-1',
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: [],
      ...(over[agentId] ?? {})
    }))
  })
}

/** Play the relay: deliver a committed post to the browser log (posts[]) and fan a
 *  pre-addressed `context` copy to every OTHER roster member — the §5.2 fan-out. */
export function fakeRelay(daemonRef: { current?: Daemon }, roster: string[], conversationId: string) {
  // Every fan-out frame overrides `agentId` with the receiving peer.
  const rd = rdFactory(conversationId, 'fan-out-peer')
  const posts: RdWebchatPost[] = []
  let ctxSeq = 0
  const fanOut = (p: RdWebchatPost): void => {
    posts.push(p)
    for (const peer of roster) {
      if (peer === p.agentId) continue
      ;(daemonRef.current as any).handleRelayMsg(
        rd({ op: 'context', post: p.post }, { agentId: peer, msgId: `ctx-${ctxSeq++}` }),
        () => {}
      )
    }
  }
  return { posts, fanOut }
}

export const userPost = (conversationId: string, text: string, at: number, postId: string): WebchatPost => ({
  postId,
  conversationId,
  author: { kind: 'user', user: 'owner' },
  text,
  at
})

export const agentPost = (
  conversationId: string,
  agentId: string,
  text: string,
  at: number,
  postId: string,
  hopCount?: number
): WebchatPost => ({
  postId,
  conversationId,
  author: { kind: 'agent', agentId, ...(hopCount !== undefined ? { hopCount } : {}) },
  text,
  at
})

export const settle = () => new Promise((r) => setTimeout(r, 300))

/** Mirrors daemon.ts `activationKey(platform, transportScope, platformMessageId, target)`. */
export const rendezvousKey = (postId: string, targetAgentId: string): string =>
  ['webchat', '', postId, targetAgentId].join('\u001f')
