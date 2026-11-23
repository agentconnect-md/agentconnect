import { describe, expect, it, vi } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { createMattermostTurnOutput } from '../src/platforms/mattermost/surface.js'
import {
  applyMattermostAction,
  MATTERMOST_EDIT_INTERVAL_MS,
  MATTERMOST_TYPING_INTERVAL_MS,
  mattermostAttributionFooter,
  MattermostConverger,
  mattermostRootIdForMessage,
  MattermostTurnStream,
  type MattermostTurnHost,
  type MattermostTurnPort,
  type MattermostTurnState
} from '../src/platforms/mattermost/turn-output.js'

function textChunk(text: string, messageId?: string): SessionUpdate {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    ...(messageId ? { messageId } : {})
  } as SessionUpdate
}

function toolStart(): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    title: 'readFile',
    kind: 'read',
    status: 'in_progress'
  } as SessionUpdate
}

describe('MattermostConverger', () => {
  it('streams chunks, splits blocks at tool boundaries, holds unresolved link defs, and suppresses AC_NO_RESPONSE', () => {
    const conv = new MattermostConverger('low')
    expect(conv.onUpdate(textChunk('AC_NO'))).toEqual([])
    expect(conv.onUpdate(textChunk('_RESPONSE'))).toEqual([])
    expect(conv.onFinal()).toEqual([])

    const conv2 = new MattermostConverger('low')
    expect(conv2.onUpdate(textChunk('Para 1\n\nWorking '))).toEqual([
      { kind: 'mattermost-stream', text: 'Para 1\n\nWorking ' }
    ])
    expect(conv2.onUpdate(textChunk('[ref]'))).toEqual([{ kind: 'mattermost-stream', text: 'Para 1\n\n' }])
    expect(conv2.onUpdate(textChunk('\n[ref]: https://example.com\n\n'))).toEqual([
      { kind: 'mattermost-stream', text: 'Para 1\n\n' }
    ])
    expect(conv2.onUpdate(toolStart())).toEqual([
      { kind: 'post', text: 'Para 1\n\nWorking [ref]\n[ref]: https://example.com' },
      { kind: 'typing' }
    ])
    expect(conv2.onUpdate(textChunk('AC_NO', 'm2'))).toEqual([])
    expect(conv2.onFinal()).toEqual([{ kind: 'post', text: 'AC_NO' }])
  })

  it('records without streaming when output mode is none', () => {
    const conv = new MattermostConverger('none')
    expect(conv.onUpdate(textChunk('secret-free text'))).toEqual([])
    expect(conv.onFinal()).toEqual([{ kind: 'post', text: 'secret-free text', recordOnly: true }])
  })

  it('keeps minimal mode to a single live post with recordOnly intermediate segments and throttles typing', async () => {
    const conv = new MattermostConverger('minimal')
    expect(conv.onUpdate(textChunk('Searching docs...', 'm1'))).toEqual([
      { kind: 'mattermost-stream', text: 'Searching docs...' }
    ])
    expect(
      conv.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } as SessionUpdate)
    ).toEqual([{ kind: 'typing' }])
    expect(conv.onUpdate(toolStart())).toEqual([
      { kind: 'post', text: 'Searching docs...', recordOnly: true },
      { kind: 'typing' }
    ])
    expect(conv.onUpdate(textChunk('Final answer.', 'm2'))).toEqual([
      { kind: 'mattermost-stream', text: 'Final answer.' }
    ])
    expect(conv.onFinal()).toEqual([{ kind: 'post', text: 'Final answer.' }])

    let nowMs = 10_000
    const sendTyping = vi.fn(async () => {})
    const recordReplySegment = vi.fn(async () => {})
    const state: MattermostTurnState = {
      conn: {
        maxPostSize: 4000,
        sendTyping,
        createPost: async () => ({ id: 'p1' }),
        patchPost: async () => ({ id: 'p1' }),
        uploadFile: async () => ({ ok: true })
      },
      channel: 'ch1',
      rootId: 'mmroot00000000000000000001',
      isDm: false
    }
    const host: MattermostTurnHost<any> = {
      recordReplySegment,
      appendTranscript: vi.fn(async () => {}),
      nowUs: () => nowMs * 1_000,
      warn: vi.fn()
    }
    const turn = {
      plan: { transcriptChannel: 'ch1', statusThread: 's1', agentId: 'a1', sessionKey: 'k1', channel: 'ch1' }
    }
    await applyMattermostAction(host, turn, state, { kind: 'typing' })
    await applyMattermostAction(host, turn, state, { kind: 'typing' })
    expect(sendTyping).toHaveBeenCalledTimes(1)
    nowMs += MATTERMOST_TYPING_INTERVAL_MS
    await applyMattermostAction(host, turn, state, { kind: 'typing' })
    expect(sendTyping).toHaveBeenCalledTimes(2)
  })
})

describe('MattermostTurnStream', () => {
  it('creates initial post, throttles edits at >= 1s intervals, and splits overflow into same thread', async () => {
    let nowMs = 0
    const timers: { fn: () => void; ms: number; cleared?: boolean }[] = []
    const created: { channel: string; text: string; rootId?: string }[] = []
    const patched: { postId: string; text: string }[] = []
    let nextId = 1

    const port: MattermostTurnPort = {
      maxPostSize: 24,
      createPost: async (channel, text, opts) => {
        created.push({ channel, text, ...(opts?.rootId ? { rootId: opts.rootId } : {}) })
        return { id: `mmpost0000000000000000000${nextId++}` }
      },
      patchPost: async (postId, text) => {
        patched.push({ postId, text })
        return { id: postId }
      },
      uploadFile: async () => ({ ok: true })
    }

    const stream = new MattermostTurnStream(port, 'ch-1', 'mmroot00000000000000000001', 24, {
      minEditIntervalMs: MATTERMOST_EDIT_INTERVAL_MS,
      now: () => nowMs,
      setTimer: (fn, ms) => {
        const handle = { fn, ms }
        timers.push(handle)
        return handle
      },
      clearTimer: (h) => {
        ;(h as { cleared?: boolean }).cleared = true
      }
    })

    // First chunk posts immediately.
    stream.update('Hello')
    await Promise.resolve()
    await Promise.resolve()
    expect(created).toEqual([{ channel: 'ch-1', text: 'Hello', rootId: 'mmroot00000000000000000001' }])
    expect(patched).toEqual([])

    // Rapid updates within 1000ms coalesce into one scheduled timer.
    nowMs = 200
    stream.update('Hello world')
    stream.update('Hello world!')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBe(800)

    nowMs = 1_000
    timers[0]!.fn()
    await vi.waitFor(() => {
      expect(patched).toEqual([{ postId: 'mmpost00000000000000000001', text: 'Hello world!' }])
    })

    // Overflow (> maxPostSize=24) splits across multiple posts in the SAME thread rootId.
    const longFinal = 'First paragraph fit.\n\nSecond paragraph overflows post size.'
    const segments = await stream.finish(longFinal)
    expect(segments.length).toBeGreaterThanOrEqual(2)
    expect(created.length).toBeGreaterThanOrEqual(2)
    for (const req of created) {
      expect(req.rootId).toBe('mmroot00000000000000000001')
    }
    for (const seg of segments) {
      expect(seg.text.length).toBeLessThanOrEqual(24)
    }
  })

  it('sends user_typing admission ack and falls back to recordReplySegment if post fails', async () => {
    const sendTyping = vi.fn(async () => {})
    const recordReplySegment = vi.fn(async () => {})
    const appendTranscript = vi.fn(async () => {})
    const warn = vi.fn()
    const host: MattermostTurnHost<any> = {
      recordReplySegment,
      appendTranscript,
      nowUs: () => 123_000,
      warn
    }
    const surface = createMattermostTurnOutput(host)
    expect(surface.approvalCards).toBeDefined()
    expect(surface.capabilityCards).toBeDefined()
    expect(surface.fillCards).toBeDefined()
    expect(surface.elicitCards).toBeDefined()

    const port: MattermostTurnPort = {
      maxPostSize: 4000,
      sendTyping,
      createPost: async () => {
        throw new Error('rate limited')
      },
      patchPost: async () => ({ id: 'x' }),
      uploadFile: async () => ({ ok: true })
    }
    const channelMsg = {
      platform: 'mattermost',
      source: 'user',
      msgId: 'mattermost:ch1:mmpost00000000000000000001',
      channel: 'ch1',
      thread: 'mmpost00000000000000000001',
      isDm: false
    } as NormalizedMessage

    await surface.onAdmission!(
      {
        mode: 'low',
        isDm: false,
        showFooter: false,
        message: channelMsg,
        egress: port
      },
      'processing',
      new AbortController().signal
    )
    expect(sendTyping).toHaveBeenCalledWith('ch1', 'mmpost00000000000000000001')

    const state: MattermostTurnState = {
      conn: port,
      channel: 'ch1',
      rootId: 'mmpost00000000000000000001',
      isDm: false
    }
    const turn = {
      plan: {
        transcriptChannel: 'ch1',
        statusThread: 'mmpost00000000000000000001',
        agentId: 'agent-1',
        sessionKey: 's1',
        channel: 'ch1'
      }
    }
    await applyMattermostAction(host, turn, state, { kind: 'post', text: 'fallback reply' })
    expect(warn).toHaveBeenCalled()
    expect(recordReplySegment).toHaveBeenCalledWith(turn, 'fallback reply')
    expect(appendTranscript).not.toHaveBeenCalled()
  })

  it('delivers attribution + open in session footer to Mattermost while keeping transcript clean, handles empty tail, and omits footer in minimal/none', async () => {
    const info = {
      botName: 'Agent_One',
      botUrl: 'http://localhost:3000/-/agents/a1',
      runtime: 'Codex',
      model: 'gpt-6.1-sol',
      sessionUrl: 'http://localhost:3000/-/sessions/s1?source=mattermost',
      notice: 'check (details)'
    }
    const footer = mattermostAttributionFooter(info)
    expect(footer).toBe(
      '_sent by [Agent\\_One](http://localhost:3000/-/agents/a1) (Codex · gpt-6.1-sol) · [open in session](http://localhost:3000/-/sessions/s1?source=mattermost) · check (details)_'
    )
    expect(
      mattermostAttributionFooter({ ...info, botUrl: 'javascript:alert(1)', sessionUrl: 'data:text/html,hi' })
    ).not.toContain('javascript:')

    const conv = new MattermostConverger('low')
    conv.onUpdate(textChunk('Answer body.'))
    expect(conv.onFinal(info)).toEqual([{ kind: 'post', text: 'Answer body.', attribution: info }])

    // Tool call flushes text before ending cleanly -> falls back to notice footer.
    const convAfterTool = new MattermostConverger('low')
    expect(convAfterTool.onUpdate(textChunk('Preamble'))).toHaveLength(1)
    expect(convAfterTool.onUpdate(toolStart())[0]).toEqual({ kind: 'post', text: 'Preamble' })
    expect(convAfterTool.onFinal(info)).toEqual([{ kind: 'notice', text: footer }])

    // Minimal and none modes suppress attribution footer.
    const convMinimal = new MattermostConverger('minimal')
    convMinimal.onUpdate(textChunk('Compact answer'))
    expect(convMinimal.onFinal(info)).toEqual([{ kind: 'post', text: 'Compact answer' }])
    const convNone = new MattermostConverger('none')
    convNone.onUpdate(textChunk('Hidden answer'))
    expect(convNone.onFinal(info)).toEqual([{ kind: 'post', text: 'Hidden answer', recordOnly: true }])

    const created: string[] = []
    const port: MattermostTurnPort = {
      maxPostSize: 4000,
      createPost: async (_c, text) => {
        created.push(text)
        return { id: 'mmpost00000000000000000009' }
      },
      patchPost: async (_id, text) => ({ id: 'mmpost00000000000000000009', text }),
      uploadFile: async () => ({ ok: true })
    }
    const appendTranscript = vi.fn(async () => {})
    const recordPublishedPost = vi.fn()
    const host: MattermostTurnHost<any> = {
      recordReplySegment: vi.fn(async () => {}),
      appendTranscript,
      recordPublishedPost,
      nowUs: () => 123_000,
      warn: vi.fn()
    }
    const state: MattermostTurnState = {
      conn: port,
      channel: 'ch1',
      rootId: 'mmroot00000000000000000001',
      isDm: false
    }
    const turn = {
      plan: {
        transcriptChannel: 'ch1',
        statusThread: 'mmroot00000000000000000001',
        agentId: 'agent-1',
        sessionKey: 's1',
        channel: 'ch1'
      }
    }
    await applyMattermostAction(host, turn, state, { kind: 'post', text: 'Answer body.', attribution: info })
    expect(created).toEqual([`Answer body.\n\n${footer}`])
    expect(appendTranscript).toHaveBeenCalledWith(expect.objectContaining({ text: 'Answer body.' }))
    expect(recordPublishedPost).toHaveBeenCalledWith(
      turn,
      expect.objectContaining({ ts: 'mmpost00000000000000000009', text: `Answer body.\n\n${footer}` })
    )
  })

  it('renders plan in low/medium/high, in-place progress in medium/high, and reasoning + tool-output in high without polluting transcripts', async () => {
    const planUpdate = {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read config', status: 'completed' },
        { content: 'Run check', status: 'in_progress' },
        { content: 'Write summary', status: 'pending' }
      ]
    } as SessionUpdate

    // low emits plan, suppresses progress/reasoning/tool-output
    const convLow = new MattermostConverger('low')
    expect(convLow.onUpdate(planUpdate)).toEqual([
      { kind: 'plan', text: '📋 **Plan**\n✅ Read config\n⏳ Run check\n⬜ Write summary' }
    ])
    expect(new MattermostConverger('minimal').onUpdate(planUpdate)).toEqual([{ kind: 'typing' }])
    expect(new MattermostConverger('none').onUpdate(planUpdate)).toEqual([])

    // medium emits live in-place progress
    const convMedium = new MattermostConverger('medium')
    expect(convMedium.onUpdate(toolStart())).toEqual([{ kind: 'typing' }, { kind: 'progress', text: '🔨 `readFile`' }])
    expect(
      convMedium.onUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        title: 'inspect parity',
        status: 'completed',
        rawOutput: { formatted_output: 'hidden in medium' }
      } as SessionUpdate)
    ).toEqual([{ kind: 'typing' }, { kind: 'progress', text: '🔨 `inspect parity`' }])

    // high accumulates reasoning, emits progress + terminal tool-output, and drains reasoning before reply
    const convHigh = new MattermostConverger('high')
    expect(
      convHigh.onUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Step 1 ' }
      } as SessionUpdate)
    ).toEqual([{ kind: 'typing' }])
    expect(convHigh.hasBuffered()).toBe(true)
    expect(convHigh.onUpdate(toolStart())).toEqual([
      { kind: 'reasoning', text: '💭 **Thinking**\nStep 1' },
      { kind: 'typing' },
      { kind: 'progress', text: '🔨 `readFile`' }
    ])
    expect(
      convHigh.onUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        rawOutput: { formatted_output: 'file contents ok' }
      } as SessionUpdate)
    ).toEqual([
      { kind: 'typing' },
      { kind: 'progress', text: '🔨 `readFile`' },
      { kind: 'tool-output', text: '📄\n```\nfile contents ok\n```' }
    ])

    // Applier patches chrome in place without calling appendTranscript or recordPublishedPost.
    let seq = 1
    const created: Array<{ channel: string; text: string; rootId?: string }> = []
    const patched: Array<{ id: string; text: string }> = []
    const appendTranscript = vi.fn(async () => {})
    const recordPublishedPost = vi.fn()
    const port: MattermostTurnPort = {
      maxPostSize: 4000,
      createPost: async (channel, text, opts) => {
        created.push({ channel, text, ...(opts?.rootId ? { rootId: opts.rootId } : {}) })
        return { id: `mmchrome00000000000000000${seq++}` }
      },
      patchPost: async (id, text) => {
        patched.push({ id, text })
        return { id }
      },
      uploadFile: async () => ({ ok: true })
    }
    const host: MattermostTurnHost<any> = {
      recordReplySegment: vi.fn(async () => {}),
      appendTranscript,
      recordPublishedPost,
      nowUs: () => 500_000,
      warn: vi.fn()
    }
    const state: MattermostTurnState = { conn: port, channel: 'ch1', rootId: 'mmroot1', isDm: false }
    const turn = {
      plan: { transcriptChannel: 'ch1', statusThread: 'mmroot1', agentId: 'a1', sessionKey: 's1', channel: 'ch1' }
    }
    await applyMattermostAction(host, turn, state, { kind: 'progress', text: '🔨 `readFile`' })
    await applyMattermostAction(host, turn, state, { kind: 'progress', text: '🔨 `inspect parity`' })
    await applyMattermostAction(host, turn, state, { kind: 'plan', text: '📋 **Plan**\n⏳ Run' })
    await applyMattermostAction(host, turn, state, { kind: 'reasoning', text: '💭 **Thinking**\nOk' })
    await applyMattermostAction(host, turn, state, { kind: 'tool-output', text: '📄\n```\nok\n```' })

    expect(created).toEqual([
      { channel: 'ch1', text: '🔨 `readFile`', rootId: 'mmroot1' },
      { channel: 'ch1', text: '📋 **Plan**\n⏳ Run', rootId: 'mmroot1' },
      { channel: 'ch1', text: '💭 **Thinking**\nOk', rootId: 'mmroot1' },
      { channel: 'ch1', text: '📄\n```\nok\n```', rootId: 'mmroot1' }
    ])
    expect(patched).toEqual([{ id: 'mmchrome000000000000000001', text: '🔨 `inspect parity`' }])
    expect(appendTranscript).not.toHaveBeenCalled()
    expect(recordPublishedPost).not.toHaveBeenCalled()
  })

  it('survives mid-stream patch errors, recreates missing post on final 404, clamps fenced tool output safely, and ignores synthetic msgIds', async () => {
    const port: MattermostTurnPort = {
      maxPostSize: 4000,
      createPost: vi.fn(async (_c, _text) => ({ id: `mmnew0000000000000000000${portCreateCalls++}` })),
      patchPost: vi.fn(async (_id, _text) => {
        patchCount++
        if (patchCount === 1) throw Object.assign(new Error('transient 502'), { status: 502 })
        throw Object.assign(new Error('deleted'), { status: 404 })
      }),
      uploadFile: async () => ({ ok: true })
    }
    let portCreateCalls = 1
    let patchCount = 0
    const stream = new MattermostTurnStream(port, 'ch1', 'mmroot00000000000000000001', 4000, {
      minEditIntervalMs: 1
    })
    stream.update('step 1')
    await vi.waitFor(() => expect(port.createPost).toHaveBeenCalledTimes(1))
    // Mid-stream 502 on patch does NOT latch permanent failure
    stream.update('step 2')
    await vi.waitFor(() => expect(patchCount).toBe(1))
    // Final patch gets 404 -> falls back to createPost so final answer is delivered
    const sent = await stream.finish('final delivered answer')
    expect(sent).toEqual([{ id: 'mmnew00000000000000000002', text: 'final delivered answer' }])

    // Synthetic cron msgId never produces invalid rootId
    expect(
      mattermostRootIdForMessage({
        isDm: false,
        msgId: 'cron:run-123'
      })
    ).toBeUndefined()

    // Fenced tool output clamped below limit closes its code fence cleanly
    const createdTool: string[] = []
    const smallPort: MattermostTurnPort = {
      maxPostSize: 25,
      createPost: async (_c, text) => {
        createdTool.push(text)
        return { id: 'mmtool00000000000000000001' }
      },
      patchPost: async (id, text) => ({ id, text }),
      uploadFile: async () => ({ ok: true })
    }
    const host: MattermostTurnHost<any> = {
      recordReplySegment: vi.fn(async () => {}),
      appendTranscript: vi.fn(async () => {}),
      nowUs: () => 1_000,
      warn: vi.fn()
    }
    await applyMattermostAction(
      host,
      { plan: { transcriptChannel: '', statusThread: '', agentId: 'a', sessionKey: 's', channel: 'ch1' } },
      { conn: smallPort, channel: 'ch1', isDm: false },
      { kind: 'tool-output', text: '```\nvery long output lines that exceed 25 chars\n```' }
    )
    expect(createdTool[0]!.length).toBeLessThanOrEqual(25)
    expect(createdTool[0]!.endsWith('\n```')).toBe(true)
  })

  it('coalesces concurrent updates during in-flight writes and clamps UTF-16 surrogate pairs cleanly', async () => {
    let nowMs = 0
    const timers: { fn: () => void; ms: number; cleared?: boolean }[] = []
    let resolveCreate!: (res: { id: string }) => void
    const createCalls: string[] = []
    const patchCalls: string[] = []

    const port: MattermostTurnPort = {
      maxPostSize: 4000,
      createPost: async (_ch, text) => {
        createCalls.push(text)
        return await new Promise<{ id: string }>((resolve) => {
          resolveCreate = resolve
        })
      },
      patchPost: async (id, text) => {
        patchCalls.push(text)
        return { id }
      },
      uploadFile: async () => ({ ok: true })
    }

    const stream = new MattermostTurnStream(port, 'ch-1', undefined, 4000, {
      minEditIntervalMs: 1_000,
      now: () => nowMs,
      setTimer: (fn, ms) => {
        const handle = { fn, ms }
        timers.push(handle)
        return handle
      },
      clearTimer: (h) => {
        ;(h as { cleared?: boolean }).cleared = true
      }
    })

    // First chunk enters in-flight createPost; concurrent updates while awaiting network must coalesce.
    stream.update('chunk 1')
    await vi.waitFor(() => expect(createCalls).toEqual(['chunk 1']))

    nowMs = 100
    stream.update('chunk 1+2')
    nowMs = 1_500
    stream.update('chunk 1+2+3')
    stream.update('chunk 1+2+3+4')
    expect(patchCalls).toEqual([])
    expect(timers).toHaveLength(0)

    // When createPost settles at nowMs=1500, lastWriteAt becomes 1500 so pending update schedules 1000ms timer instead of firing 0ms burst.
    resolveCreate({ id: 'mmpost00000000000000000010' })
    await vi.waitFor(() => expect(timers).toHaveLength(1))
    expect(timers[0]!.ms).toBe(1_000)
    expect(patchCalls).toEqual([])

    nowMs = 2_500
    timers[0]!.fn()
    await vi.waitFor(() => expect(patchCalls).toEqual(['chunk 1+2+3+4']))

    // Surrogate-pair clamping in clampText (via renderPlan) and clampToolOutput / capOutput never leaves lone high surrogates.
    const emoji = '🚀' // 2 UTF-16 code units
    const convPlan = new MattermostConverger('low')
    const planActions = convPlan.onUpdate({
      sessionUpdate: 'plan',
      entries: [{ content: `${'a'.repeat(98)}${emoji}tail`, status: 'pending' }]
    } as SessionUpdate)
    const planText = (planActions[0] as { kind: 'plan'; text: string }).text
    expect(planText).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)

    const convHigh = new MattermostConverger('high')
    convHigh.onUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-emoji',
      title: 'emoji',
      kind: 'execute',
      status: 'in_progress'
    } as SessionUpdate)
    const toolActions = convHigh.onUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-emoji',
      status: 'completed',
      rawOutput: { formatted_output: `${'x'.repeat(2798)}${emoji}rest` }
    } as SessionUpdate)
    const toolOut = (toolActions.find((a) => a.kind === 'tool-output') as { text: string }).text
    expect(toolOut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(toolOut).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('skips redundant AST parsing on plain streaming tokens while keeping exact settled and reference-hold output', () => {
    const conv = new MattermostConverger('low')
    expect(conv.onUpdate(textChunk('[docs](https://example.com)\n\n'))).toEqual([
      { kind: 'mattermost-stream', text: '[docs](https://example.com)\n\n' }
    ])
    expect(conv.onUpdate(textChunk('Plain '))).toEqual([
      { kind: 'mattermost-stream', text: '[docs](https://example.com)\n\nPlain ' }
    ])
    expect(conv.onUpdate(textChunk('tokens'))).toEqual([
      { kind: 'mattermost-stream', text: '[docs](https://example.com)\n\nPlain tokens' }
    ])
    expect(conv.onUpdate(textChunk(' [ref]'))).toEqual([
      { kind: 'mattermost-stream', text: '[docs](https://example.com)\n\n' }
    ])
    // Appending plain words while holding [ref] stays held without dropping prefix.
    expect(conv.onUpdate(textChunk(' trailing text'))).toEqual([
      { kind: 'mattermost-stream', text: '[docs](https://example.com)\n\n' }
    ])
    expect(conv.onUpdate(textChunk('\n\n[ref]: javascript:alert(1)'))).toEqual([
      { kind: 'mattermost-stream', text: '[docs](https://example.com)\n\n' }
    ])
    expect(conv.onFinal()).toEqual([
      {
        kind: 'post',
        text: '[docs](https://example.com)\n\nPlain tokens ref (`javascript:alert(1)`) trailing text\n\n'
      }
    ])
  })
})
