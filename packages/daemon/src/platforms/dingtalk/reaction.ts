// DingTalk's turn acknowledgement (dingtalk-integration.md §4.3): a thinking reaction on the user's message, taken off when the turn ends.
import type { Logger } from '../../log.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { TurnAcknowledgement, TurnOutputContext } from '../turn-output.js'
import type { DingTalkApi } from './api.js'
import { dingTalkMessageRef } from './threading.js'

/** The message a reaction sits on, by the raw ids DingTalk delivered; a DM's `dm:` channel carries neither. */
export interface DingTalkMessageRef {
  openConversationId: string
  openMsgId: string
}

// DingTalk's built-in thinking text emotion; the name is the label its clients show.
const THINKING = {
  emotionType: 2,
  emotionName: '🤔思考中',
  textEmotion: { emotionId: '2659900', emotionName: '🤔思考中', text: '🤔思考中', backgroundId: 'im_bg_1' }
}

/** The reaction calls a turn makes; the connection owns one, shared by its turns. */
export interface DingTalkReactionPort {
  add(at: DingTalkMessageRef): Promise<void>
  remove(at: DingTalkMessageRef): Promise<void>
  /** The connection's log, for a reaction call that fails. */
  warn(message: string): void
}

export class DingTalkReactionClient implements DingTalkReactionPort {
  constructor(
    private readonly api: Pick<DingTalkApi, 'call'>,
    private readonly robotCode: string,
    private readonly log: Pick<Logger, 'warn'>
  ) {}

  async add(at: DingTalkMessageRef): Promise<void> {
    await this.api.call('POST', '/v1.0/robot/emotion/reply', this.body(at))
  }

  async remove(at: DingTalkMessageRef): Promise<void> {
    await this.api.call('POST', '/v1.0/robot/emotion/recall', this.body(at))
  }

  warn(message: string): void {
    this.log.warn(message)
  }

  private body(at: DingTalkMessageRef): Record<string, unknown> {
    return {
      robotCode: this.robotCode,
      openMsgId: at.openMsgId,
      openConversationId: at.openConversationId,
      ...THINKING
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

/** Added at turn start and taken off at its end, never awaited by the turn; a refused call only logs. */
export class DingTalkThinkingReaction implements TurnAcknowledgement {
  // Whether the end should take a reaction off: one this turn added, or one an earlier run of a rerun may have left.
  private readonly placed: Promise<boolean>
  private ended = false

  constructor(
    private readonly port: DingTalkReactionPort,
    private readonly at: DingTalkMessageRef,
    rerun: boolean
  ) {
    this.placed = port.add(at).then(
      () => true,
      (error: unknown) => {
        port.warn(`dingtalk: thinking reaction not added (${describe(error)})`)
        return rerun
      }
    )
  }

  // A reaction cannot carry a notice, so core posts it as a message.
  async replace(): Promise<boolean> {
    return false
  }

  // Every end kind takes the reaction off; the removal runs behind the end so the next turn never waits on it.
  async end(): Promise<void> {
    if (this.ended) return
    this.ended = true
    void this.placed
      .then(async (placed) => {
        if (placed) await this.port.remove(this.at)
      })
      .catch((error: unknown) => this.port.warn(`dingtalk: thinking reaction not removed (${describe(error)})`))
  }
}

/** The turn's reaction: a user message DingTalk delivered, in any mode but `none`, with a connection that can react. */
export function acknowledgeDingTalkTurn(
  ctx: TurnOutputContext<NormalizedMessage>,
  turn: { rerun: boolean }
): TurnAcknowledgement | undefined {
  const port = (ctx.egress as { reactions?: DingTalkReactionPort } | undefined)?.reactions
  const at = ctx.message.source === 'user' && !ctx.message.headless ? dingTalkMessageRef(ctx.message) : undefined
  if (!port || !at || ctx.mode === 'none') return undefined
  return new DingTalkThinkingReaction(port, at, turn.rerun)
}
