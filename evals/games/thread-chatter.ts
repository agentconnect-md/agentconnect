// Thread chatter: after one tag in a mention-only channel, does the agent stay out of people's untagged exchange?
import type {
  CollaborationGameWorld,
  DaemonEvaluationEnvironment,
  GameVerdict,
  GameWave,
  GameWaveRecord,
  RecordedOutboundEffect
} from '../../packages/daemon/src/evaluation/index.js'
import type { ArenaWorld } from './world.js'
import type { CompiledRoom } from './types.js'

/** One scripted human message; `{bot}` is replaced with the agent's mention token. */
export interface ChatterLine {
  from: string
  text: string
  /** Whether the agent is expected to post a reply to this message. */
  expectReply: boolean
  /** Human user ids the text tags, beyond the agent (`{bot}` is detected on its own). */
  tags?: string[]
}

/** A ticketing thread where people discuss the ticket's topic among themselves after one tag. */
export const TICKETING_THREAD: ChatterLine[] = [
  {
    from: 'U0ARENAUSRA',
    text: '{bot} create a ticket to track our hardware evaluation for self-hosting agents.',
    expectReply: true
  },
  {
    from: 'U0ARENAUSRB',
    text: 'I think we should evaluate machines with at least 32 GB RAM. Running several agents locally could get memory hungry.',
    expectReply: false
  },
  {
    from: 'U0ARENAUSRC',
    text: 'Agreed. We should also compare the cost of running a couple of GPUs against renting cloud instances.',
    expectReply: false
  },
  {
    from: 'U0ARENAUSRB',
    text: 'We should compare power consumption as well. A small desktop machine might be the better option.',
    expectReply: false
  },
  {
    from: 'U0ARENAUSRD',
    text: 'I found a few interesting options with AMD processors. Might be worth looking into.',
    expectReply: false
  },
  {
    from: 'U0ARENAUSRC',
    text: "Let's put together a comparison sheet with upfront costs and monthly operating costs.",
    expectReply: false
  },
  {
    from: 'U0ARENAUSRB',
    text: "Good idea. I'll start the sheet tonight and share it here tomorrow.",
    expectReply: false
  },
  {
    from: 'U0ARENAUSRA',
    text: '{bot} add to the ticket that we will compare RAM, GPU cost against cloud, and power consumption.',
    expectReply: true
  }
]

/** Guards against over-silencing: an untagged message that names the agent and asks it to act must still be answered. */
export const NAMED_WITHOUT_TAG_THREAD: ChatterLine[] = [
  {
    from: 'U0ARENAUSRA',
    text: '{bot} create a ticket to track our hardware evaluation for self-hosting agents.',
    expectReply: true
  },
  {
    from: 'U0ARENAUSRB',
    text: 'I think we should evaluate machines with at least 32 GB RAM. Running several agents locally could get memory hungry.',
    expectReply: false
  },
  {
    from: 'U0ARENAUSRC',
    text: 'Agreed. We should also compare the cost of running a couple of GPUs against renting cloud instances.',
    expectReply: false
  },
  {
    from: 'U0ARENAUSRA',
    text: 'Ticketing bot, please also set the due date on that ticket to next Friday.',
    expectReply: true
  },
  {
    from: 'U0ARENAUSRB',
    text: "Thanks. I'll check the cloud budget with finance this week.",
    expectReply: false
  }
]

export const CHATTER_SCENARIOS: Record<string, ChatterLine[]> = {
  ticketing: TICKETING_THREAD,
  'named-without-tag': NAMED_WITHOUT_TAG_THREAD
}

export interface ThreadChatterOptions {
  world: ArenaWorld
  roomAlias: string
  lines?: ChatterLine[]
}

interface LineResult {
  index: number
  from: string
  expectReply: boolean
  admitted: boolean
  replies: string[]
}

export class ThreadChatterGame implements CollaborationGameWorld {
  readonly environment: DaemonEvaluationEnvironment
  private readonly world: ArenaWorld
  private readonly room: CompiledRoom
  private readonly lines: ChatterLine[]
  private readonly botToken: string
  private readonly results: LineResult[] = []
  private root: string | undefined
  private next = 0
  private terminalReason: string | undefined

  constructor(options: ThreadChatterOptions) {
    this.world = options.world
    const room = options.world.topology.rooms.find((candidate) => candidate.alias === options.roomAlias)
    if (!room) throw new Error(`chatter room "${options.roomAlias}" is not in the compiled topology`)
    if (room.memberIntegrationIds.length !== 1) throw new Error('thread chatter seats exactly one agent')
    this.room = room
    this.lines = options.lines ?? TICKETING_THREAD
    const botUserId = this.world.botUserIdFor(room.memberIntegrationIds[0]!)
    if (botUserId === undefined) throw new Error('thread chatter agent has no bot user id')
    this.botToken = `<@${botUserId}>`
    // The channel trigger under test is @-mention; continuity after the first tag is thread affinity.
    this.environment = options.world.buildEnvironment({ bindMatch: 'mention' })
  }

  isTerminal(): boolean {
    return this.terminalReason !== undefined || this.next >= this.lines.length
  }

  nextDeliveries(): GameWave {
    const line = this.lines[this.next]
    if (line === undefined) return { platformEvents: [], refereeEvents: [] }
    const text = line.text.replaceAll('{bot}', this.botToken)
    const mentions = [...(text.includes(this.botToken) ? [this.botToken.slice(2, -1)] : []), ...(line.tags ?? [])]
    const messageId = this.world.mintMessageId(this.room.platform)
    // The first message is the channel post that opens the thread; the rest reply inside it.
    this.root ??= messageId
    this.world.registerRoomMessage(this.room.channel, messageId)
    this.world.recordThreadMessage(this.room.channel, this.root, {
      ts: messageId,
      text,
      sender: line.from,
      isBot: false
    })
    this.world.appendEvent({
      type: 'chatter.line',
      origin: 'referee',
      index: this.next,
      from: line.from,
      expectReply: line.expectReply,
      messageId,
      text
    })
    this.results.push({
      index: this.next,
      from: line.from,
      expectReply: line.expectReply,
      admitted: false,
      replies: []
    })
    this.next += 1
    return {
      platformEvents: [
        {
          integrationId: this.room.memberIntegrationIds[0]!,
          payload: {
            channel: this.room.channel,
            thread: this.root,
            messageId,
            text,
            sender: { id: line.from, isBot: false },
            ...(mentions.length > 0 ? { mentions } : {})
          }
        }
      ],
      refereeEvents: []
    }
  }

  drainOutboundEffects(): readonly RecordedOutboundEffect[] {
    return this.world.drainOutboundEffects()
  }

  applyEffects(effects: readonly RecordedOutboundEffect[]): void {
    const current = this.results.at(-1)
    if (current === undefined) return
    for (const effect of effects) {
      if (effect.status !== 'delivered' || effect.kind !== 'reply') continue
      if (effect.channel !== this.room.channel) continue
      const text = effect.text.trim()
      if (text.length === 0) continue
      current.replies.push(text)
      this.world.appendEvent({
        type: 'chatter.reply',
        origin: 'agent_effect',
        effectSequence: effect.sequence,
        index: current.index,
        expectReply: current.expectReply,
        text
      })
    }
  }

  noteWave(record: GameWaveRecord): void {
    const current = this.results.at(-1)
    if (current !== undefined) current.admitted = record.admissions.some((admission) => admission.admitted)
    this.world.appendEvent({
      type: 'wave',
      origin: 'world',
      step: record.step,
      admissions: [...record.admissions]
    })
  }

  terminate(reason: string): void {
    if (this.terminalReason === undefined) this.terminalReason = reason
    this.world.appendEvent({ type: 'game.terminated', origin: 'world', reason })
  }

  verdict(): GameVerdict {
    const answered = this.results.filter((line) => line.replies.length > 0)
    const chatter = this.results.filter((line) => !line.expectReply)
    const addressed = this.results.filter((line) => line.expectReply)
    const unwanted = chatter.filter((line) => line.replies.length > 0)
    const missed = addressed.filter((line) => line.replies.length === 0)
    return {
      terminalReason: this.terminalReason ?? (this.next >= this.lines.length ? 'completed' : 'incomplete'),
      // Every line must reach the agent, or the game measured routing instead of the model.
      refereeConsistent: this.results.every((line) => line.admitted),
      invariants: { ...this.world.invariantCounters(), privateLeaks: 0 },
      outcome: {
        completed: missed.length === 0 && unwanted.length === 0,
        lines: this.results.map((line) => ({
          index: line.index,
          from: line.from,
          expectReply: line.expectReply,
          admitted: line.admitted,
          replied: line.replies.length > 0,
          ...(line.replies.length > 0 ? { reply: line.replies.join('\n').slice(0, 400) } : {})
        }))
      },
      metrics: {
        lines: this.results.length,
        answered: answered.length,
        chatterLines: chatter.length,
        unwantedReplies: unwanted.length,
        addressedLines: addressed.length,
        missedReplies: missed.length
      }
    }
  }

  worldEventRecords(): readonly Record<string, unknown>[] {
    return this.world.events()
  }

  topologyArtifact(): unknown {
    return this.world.topology
  }
}
