// An API turn hands its runtime approvals to the caller over the relay ops, and a caller who writes again instead of answering ends the waiting turn.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { agentHostKey } from '../src/acp/host-key.js'
import { Daemon } from '../src/daemon.js'
import { EvaluationEventCollector } from '../src/evaluation/index.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const agentId = 'example-agent'
const chatId = '44444444-4444-4444-8444-444444444444'
const roots: string[] = []
const daemons: Daemon[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const PERMISSION: RequestPermissionRequest = {
  sessionId: 'acp-1',
  toolCall: { toolCallId: 'call-1', title: 'Bash', kind: 'execute', rawInput: { command: 'rm -rf build' } },
  options: [
    { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' }
  ]
}

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-api-caller-'))
  roots.push(root)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ version: 1, controlPlane: { enabled: false }, runtimes: { test: { command: 'node', args: [] } } })
  )
  const dir = join(root, 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({
      id: agentId,
      name: 'Example agent',
      runtime: 'test',
      workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
      integrations: [],
      memory: { provider: 'none' }
    })
  )
  return root
}

async function start() {
  const verdicts: unknown[] = []
  const daemon = new Daemon({
    root: scaffold(),
    slackAppFactory: fakeSlackAppFactory(),
    evaluation: { observer: new EvaluationEventCollector(), runId: 'api-caller' },
    hostFactory: (_agent, onUpdate) =>
      ({
        start: async () => {},
        stop: async () => {},
        cancel: async () => {},
        newSession: async () => 'acp-1',
        loadSession: async () => true,
        hasSession: () => true,
        prompt: async (id: string) => {
          // The runtime asks before its tool runs, as a real one does mid-turn.
          const verdict = await (daemon as any).permissions.onAcpPermission(agentHostKey(agentId), id, PERMISSION)
          verdicts.push(verdict)
          onUpdate(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } })
          return { stopReason: verdict.outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn' }
        }
      }) as any
  })
  daemons.push(daemon)
  await daemon.start()
  const internal = daemon as any
  const chat = vi.fn()
  let seq = 0
  const op = (payload: Record<string, unknown>) =>
    internal.dispatchRelayOp(
      { source: 'webchat', agentId, sessionKey: chatId, msgId: `msg-${++seq}`, chatId, payload },
      chat
    )
  const events = (): any[] => chat.mock.calls.map(([e]) => e)
  const handedOut = async (): Promise<string> => {
    await vi.waitFor(() =>
      expect(events().some((e) => e.kind === 'output' && e.output.event?.kind === 'permission')).toBe(true)
    )
    return events().find((e) => e.kind === 'output' && e.output.event?.kind === 'permission').output.event.requestId
  }
  return { internal, op, events, handedOut, verdicts }
}

describe('an API turn over the relay', () => {
  it("streams its approval to the caller and runs on the caller's refusal", async () => {
    const { op, events, handedOut, verdicts } = await start()
    expect(await op({ op: 'turn', text: 'Clean the build', user: 'Example user', origin: 'ai-sdk-ui' })).toMatchObject({
      accepted: true
    })
    const requestId = await handedOut()
    expect(
      await op({
        op: 'permission_choice',
        requestId,
        allow: false,
        mayAllow: false,
        userId: 'user-1',
        user: 'Example user'
      })
    ).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events().some((e) => e.kind === 'done')).toBe(true))
    expect(verdicts).toEqual([{ outcome: { outcome: 'selected', optionId: 'no' } }])
  })

  it('ends a turn still waiting on its caller when the caller writes again instead', async () => {
    const { internal, op, handedOut, verdicts } = await start()
    await op({ op: 'turn', text: 'Clean the build', user: 'Example user', origin: 'ai-sdk-ui' })
    await handedOut()
    expect(internal.permissions.awaitsApiCaller(chatId)).toBe(true)
    expect(await op({ op: 'turn', text: 'Never mind', user: 'Example user', origin: 'ai-sdk-ui' })).toMatchObject({
      accepted: true
    })
    await vi.waitFor(() => expect(verdicts[0]).toEqual({ outcome: { outcome: 'cancelled' } }))
  })

  it('ends the waiting turn even when the gate declines what the caller wrote instead', async () => {
    const { internal, op, handedOut, verdicts } = await start()
    await op({ op: 'turn', text: 'Clean the build', user: 'Example user', origin: 'ai-sdk-ui' })
    await handedOut()
    vi.spyOn(internal, 'admitApiTurn').mockResolvedValue(false)
    expect(await op({ op: 'turn', text: 'Off topic', user: 'Example user', origin: 'ai-sdk-ui' })).toMatchObject({
      accepted: false,
      reason: 'declined'
    })
    expect(verdicts[0]).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(internal.permissions.awaitsApiCaller(chatId)).toBe(false)
  })
})
