import { describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { OutputConverger } from '../src/slack/render.js'
import { TelegramConverger } from '../src/telegram/render.js'
import { DiscordConverger } from '../src/discord/render.js'
import { FeishuConverger } from '../src/feishu/render.js'
import { QQConverger } from '../src/platforms/qq/turn-output.js'
import { LinearConverger } from '../src/platforms/linear/turn-output.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'

const chunk = (text: string): SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text }
})
const tool: SessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 'shell-1', title: 'Build', status: 'in_progress' }
const output = (key: string): SessionUpdate => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'shell-1',
  _meta: { [key]: { terminal_id: 'shell-1', data: 'building\n' } }
})
const done: SessionUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 'shell-1', status: 'completed' }
const answer = 'The result stays in one paragraph.'

describe.each([
  ['Slack', OutputConverger],
  ['Telegram', TelegramConverger],
  ['Discord', DiscordConverger],
  ['Feishu', FeishuConverger]
] as const)('%s background tool output', (_name, Converger) => {
  it.each(['minimal', 'low', 'high'] as const)('keeps one reply while updating the tool in %s mode', (mode) => {
    const c = new Converger(mode)
    const folder = new TerminalOutputFolder()
    const updates = [
      tool,
      chunk('The result '),
      output('terminal_output_delta'),
      chunk('stays in '),
      output('terminal_output'),
      chunk('one paragraph.'),
      done
    ]
    const actions = updates.flatMap<ReturnType<typeof c.onUpdate>[number]>((u) =>
      c.onUpdate(folder.fold(u) as SessionUpdate)
    )
    expect(actions.filter((a) => a.kind === 'post')).toEqual([])
    if (mode === 'high') expect(actions.find((a) => a.kind === 'tool-output')?.text).toContain('building')
    expect(
      c
        .onFinal()
        .filter((a) => a.kind === 'post')
        .map((a) => a.text)
    ).toEqual([answer])
  })
})

describe('other output surfaces', () => {
  it.each(['stream', 'group'] as const)('keeps QQ %s output and its final collector intact', (delivery) => {
    const c = new QQConverger('high', undefined, delivery)
    const updates = [
      tool,
      chunk('The result '),
      output('terminal_output_delta'),
      chunk('stays in one paragraph.'),
      done
    ]
    const actions = updates.flatMap((u) => c.onUpdate(u))
    expect(actions.filter((a) => a.kind === 'qq-progress')).toEqual([])
    expect(c.onFinal()).toMatchObject([{ kind: 'post', text: answer }])
  })

  it('keeps Linear narration intact while retaining the completed action', () => {
    const c = new LinearConverger('high', false)
    const updates = [
      tool,
      chunk('The result '),
      output('terminal_output_delta'),
      chunk('stays in one paragraph.'),
      done
    ]
    const actions = updates.flatMap((u) => c.onUpdate(u))
    expect(actions.filter((a) => a.kind === 'activity' && a.type === 'thought')).toEqual([])
    expect(c.onFinal()).toMatchObject([
      { kind: 'activity', type: 'action', action: 'Build' },
      { kind: 'activity', type: 'response', body: answer },
      { kind: 'transcript', text: answer }
    ])
  })
})
