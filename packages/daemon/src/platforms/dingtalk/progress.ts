// What a DingTalk turn's progress card shows (dingtalk-integration.md §4.3): status, tool activity, and a bounded reply tail.
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AgentMessageRun } from '../../messages/message-boundary.js'
import { isNoResponsePrefix, NO_RESPONSE_SENTINEL } from '../../session/no-response.js'

/** The most characters of the reply a progress card shows; the whole answer follows as Markdown messages. */
export const DINGTALK_CARD_TAIL_CHARS = 600
/** Reply growth, in characters, that earns a card update on its own; a status or tool change always does. */
export const DINGTALK_CARD_MIN_GROWTH = 160

const TOOLS_SHOWN = 3
const PLAN_SHOWN = 6
const LABEL_CHARS = 80

export interface DingTalkCardAction {
  kind: 'card'
  text: string
  tools: number
}

type ToolState = 'running' | 'completed' | 'failed'

const TOOL_ICON: Record<ToolState, string> = { running: '⏳', completed: '✅', failed: '❌' }
const PLAN_ICON: Record<string, string> = { completed: '✅', in_progress: '⏳' }

/** Plain text the card renders faithfully: it drops list markers and fences and prints table pipes (§4.3). */
export function plainCardText(markdown: string): string {
  const lines: string[] = []
  for (const raw of markdown.split('\n')) {
    let line = raw.trimEnd()
    if (/^\s*(`{3,}|~{3,})/.test(line)) continue
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue
    if (/^\s*\|.*\|\s*$/.test(line))
      line = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim())
        .join(' · ')
    line = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^(\s*)[-*+]\s+/, '$1• ')
      .replace(/^(\s*)(\d+)[.)]\s+/, '$1($2) ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|`/g, '')
    if (line.trim() || lines.at(-1)?.trim()) lines.push(line)
  }
  return lines.join('\n').trim()
}

function clip(text: string, chars: number): string {
  const all = [...text]
  return all.length > chars ? `${all.slice(0, chars - 1).join('')}…` : text
}

/** The last `chars` characters of `text`, from a line start where one is near, marked when cut. */
function tail(text: string, chars: number): string {
  const all = [...text]
  if (all.length <= chars) return text
  const cut = all.slice(-chars).join('')
  const line = cut.indexOf('\n')
  return `…${line >= 0 && line < chars / 3 ? cut.slice(line + 1) : cut}`
}

// Mode gates follow the other card platforms: `none` shows no card, `minimal` and `low` a generic status, `medium` and `high` name tools.
export class DingTalkProgressView {
  private status = '💭 Thinking…'
  private plan: string[] = []
  private readonly tools = new Map<string, { label: string; state: ToolState }>()
  private toolCount = 0
  private reply = ''
  private messageStart = 0
  private received = 0
  private readonly messages = new AgentMessageRun()
  private emittedHead = ''
  private emittedReply = 0
  private emittedText = ''

  constructor(private readonly mode: string) {}

  onUpdate(update: SessionUpdate): DingTalkCardAction[] {
    if (this.mode === 'none') return []
    const u = update as {
      sessionUpdate: string
      content?: { type?: string; text?: string }
      toolCallId?: string
      title?: string
      status?: string
      entries?: { content?: string; status?: string }[]
    }
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = u.content?.type === 'text' ? (u.content.text ?? '') : ''
        if (!text) return []
        if (this.messages.opens(update) && this.reply.trim()) {
          this.reply = `${this.reply.trimEnd()}\n\n`
          this.messageStart = this.reply.length
        }
        this.reply += text
        this.received += text.length
        this.status = '✍️ Writing…'
        break
      }
      case 'agent_thought_chunk':
        this.status = '💭 Thinking…'
        break
      case 'tool_call':
      case 'tool_call_update': {
        const id = u.toolCallId ?? `tool-${this.toolCount}`
        const known = this.tools.get(id)
        if (!known) this.toolCount++
        const label = clip(plainCardText(u.title ?? known?.label ?? 'tool').replace(/\s+/g, ' '), LABEL_CHARS)
        const state: ToolState = u.status === 'completed' ? 'completed' : u.status === 'failed' ? 'failed' : 'running'
        this.tools.delete(id)
        this.tools.set(id, { label, state })
        while (this.tools.size > TOOLS_SHOWN) this.tools.delete(this.tools.keys().next().value!)
        this.status = state === 'running' ? (this.namesTools() ? `🔨 ${label}` : '🔨 Working…') : '💭 Thinking…'
        break
      }
      case 'plan':
        this.plan = (u.entries ?? []).map(
          (entry) => `${PLAN_ICON[entry.status ?? ''] ?? '▫️'} ${clip(plainCardText(entry.content ?? ''), LABEL_CHARS)}`
        )
        break
      default:
        return []
    }
    return this.emit()
  }

  private namesTools(): boolean {
    return this.mode === 'medium' || this.mode === 'high'
  }

  private head(): string {
    const blocks = [this.status]
    if (this.plan.length && this.mode !== 'minimal') {
      const more = this.plan.length - PLAN_SHOWN
      blocks.push([...this.plan.slice(0, PLAN_SHOWN), ...(more > 0 ? [`+${more} more`] : [])].join('\n'))
    }
    if (this.namesTools() && this.tools.size)
      blocks.push([...this.tools.values()].map((tool) => `${TOOL_ICON[tool.state]} ${tool.label}`).join('\n'))
    return blocks.join('\n\n')
  }

  // A message that may still become the no-response marker is held back, and the marker never shows.
  private shownReply(): string {
    const current = this.reply.slice(this.messageStart).trim()
    const reply = current && isNoResponsePrefix(current) ? this.reply.slice(0, this.messageStart) : this.reply
    return reply.split(NO_RESPONSE_SENTINEL).join('')
  }

  private emit(): DingTalkCardAction[] {
    const head = this.head()
    if (head === this.emittedHead && this.received - this.emittedReply < DINGTALK_CARD_MIN_GROWTH) return []
    const reply = plainCardText(tail(this.shownReply(), DINGTALK_CARD_TAIL_CHARS * 2))
    const text = [head, tail(reply, DINGTALK_CARD_TAIL_CHARS)].filter((block) => block.trim()).join('\n\n')
    this.emittedHead = head
    this.emittedReply = this.received
    if (text === this.emittedText) return []
    this.emittedText = text
    return [{ kind: 'card', text, tools: this.toolCount }]
  }
}
