import type { UserTurnBody } from '@agentconnect.md/protocol'
import type { SessionMessageDto } from '@/lib/api'
import { liveBotTurnKey, sameBotSpeaker } from '@/lib/bot-turn-grouping'
import {
  agentLabel,
  platName,
  speaker,
  type Agent,
  type Session,
  type SessionImage,
  type SessionStep
} from '@/lib/data'
import { senderIdentity } from '@/lib/session-trigger'
import { formatTranscriptRowTime, transcriptRowTimeMs } from '@/lib/transcript-time'
import { parseUserTurnBody } from '@/lib/user-turn-body'
import { splitFilesMarker, type MarkedFile } from '@/lib/webchat-file'
import { namesThread, replyToMessageThread } from '@/components/console/coordinator-threads'
import type { WebThreadShape } from '@/components/console/platforms/contract'
import { platformSenderFallback } from '@/components/console/platforms/registry'
import {
  appStepKey,
  capabilityCard,
  elicitCard,
  elicitStepKey,
  liveAppKeys,
  liveCapabilityIds,
  liveFillIds,
  fillCardBody,
  liveElicitKeys,
  mcpAppCard
} from '@/components/console/session-work'
import {
  fmtStep,
  isBgTaskWake,
  msgStep,
  plainStep,
  thinkStep,
  timeMsField,
  type FmtStep
} from '@/components/console/transcript-steps'

export type Turn =
  | {
      kind: 'user'
      /** The raw row's durable `session:seq` (never an index), so a prepended page reconciles in place. */
      key: string
      sp: ReturnType<typeof speaker>
      agent: Agent | null
      avatarUrl?: string | null
      avatarInitials?: string
      sourceLabel: string
      time: string
      /** When it was sent, where known: a turn answering it with a single timed step measures from here. */
      timeMs?: number
      text: string
      images?: SessionImage[]
      /** The files its `[attached: …]` marker names, lifted out of `text` into cards. */
      files?: MarkedFile[]
      isCron: boolean
      cronId: string | null
      /** Sent into the agent's running turn (#1847) rather than as a turn of its own. */
      steer?: boolean
      /** The daemon confirmed the steer landed; until then the reply keeps streaming in the block above. */
      steered?: boolean
      /** The platform this message was authored on — see `FmtStep.platform`. */
      platform?: string
      /** The facts behind a delivery turn (transcript-full-tool-body.md §9) — the bubble's "more". */
      body?: UserTurnBody
      /** The persisted row's transcript seq, which a By decision evaluation of this message is keyed by. */
      seq?: number
      /** The platform's id of a recorded message (a webchat post id, a Slack ts), which a coordinator's task names. */
      messageId?: string
      /** A root-level message the coordinator handed into a task's thread: that thread's root. */
      handedTo?: string
      /** The transcript seq of its row, which a link to the message names. */
      rowSeq?: number
      /** Known to be the signed-in reader's own message, drawn on the right; anyone else's is on the left. */
      self?: boolean
    }
  // `wake`: opened by a background-task wake no reply has merged into yet; the run that follows clears it.
  | {
      kind: 'bot'
      /** The turn key or first step's anchor, never recomputed, so a wake block or streaming turn never remounts. */
      key: string
      agentName: string
      agentId?: string
      model: string
      time: string
      steps: FmtStep[]
      wake?: boolean
      /** A coordinator turn that answered a message in a thread: that thread's root (webchat-threads.md §6.1). */
      inThread?: string
      /** The transcript seq of its first row, which a link to the message names. */
      rowSeq?: number
    }

/** When a turn happened, for its time line: a person's message's own time, else its agent's first timed step. */
export function turnTimeMs(turn: Turn): number | undefined {
  if (turn.kind === 'user') return turn.timeMs
  return turn.steps.find((step) => step.timeMs !== undefined)?.timeMs
}

export type SessionParticipant = {
  id: string
  sp: ReturnType<typeof speaker>
  agent: Agent | null
  avatarUrl?: string | null
  avatarInitials?: string
  isCron: boolean
}

/** What a transcript's turns are built from: its rows or steps, and how the reader resolves who wrote each. */
export interface BuildTurnsInput {
  session: Pick<Session, 'id' | 'agentId' | 'agentName' | 'model' | 'platform' | 'user' | 'time' | 'steps'>
  /** The fetched transcript rows; absent builds from `session.steps` instead. */
  rows: readonly SessionMessageDto[] | undefined
  /** What this visit sent and is streaming back, layered below the history. */
  liveSteps: readonly SessionStep[]
  /** A merged conversation's per-row source member: its session, turn, platform and agent. */
  source: {
    session: WeakMap<SessionMessageDto, string>
    turn: WeakMap<SessionMessageDto, string>
    platform: WeakMap<SessionMessageDto, string>
    agent: WeakMap<SessionMessageDto, string>
  }
  /** The coordinator's roots view, where a thread's message is labelled on the turn answering it. */
  threadsView: boolean
  threadShape: WebThreadShape | undefined
  agentById: ReadonlyMap<string, Agent>
  asCron: (sender: string) => { id: string; name: string | null } | null
  participantAgent: (sender: string, text: string, trustedAgentBot?: boolean) => Agent | undefined
  isSelf: (sender?: string | null) => boolean
  senderLabel: (sender: string | null | undefined, fallback?: string) => string
  /** Whether a row's seq is the owner's own, which its decision verdicts are keyed by. */
  ownsDecisionSeq: (m: SessionMessageDto) => boolean
  viewer: { picture?: string | null; initials?: string }
  /** A member's console photo by identity. */
  pictureOf: (identity: string) => string | undefined
  /** The platform name a person's turn is labelled with. */
  sourceLabel: string
}

/** Rows, steps and live steps into turns: consecutive work of one agent is one turn, each person's message its own. */
export function buildTurns(input: BuildTurnsInput): { turns: Turn[]; speakers: Map<string, SessionParticipant> } {
  const {
    session,
    rows,
    liveSteps,
    source,
    threadsView,
    threadShape,
    agentById,
    asCron,
    participantAgent,
    isSelf,
    senderLabel,
    ownsDecisionSeq,
    viewer,
    pictureOf,
    sourceLabel
  } = input
  const turns: Turn[] = []
  // A row's immutable anchor (source session + `seq`): a turn's identity when no turn key groups it.
  const rowAnchor = (m: SessionMessageDto): string => `${source.session.get(m) ?? session.id}#${m.seq}`
  // The transcript seq a row anchor names, which a message link points at the same in every view of it.
  const anchorSeq = (anchor: string): { rowSeq: number } | Record<string, never> => {
    const seq = /#(\d+)$/.exec(anchor)?.[1]
    return seq ? { rowSeq: Number(seq) } : {}
  }
  // A live step's identity is its `turnId`, which `stampStep` mints for every live step.
  const liveAnchor = (stp: SessionStep): string => `live:${stp.turnId}`
  const speakers = new Map<string, SessionParticipant>()
  const rememberParticipant = (id: string, participant: Omit<SessionParticipant, 'id'>): void => {
    const current = speakers.get(id)
    speakers.set(id, {
      id,
      ...participant,
      agent: participant.agent ?? current?.agent ?? null,
      avatarUrl: participant.avatarUrl ?? current?.avatarUrl,
      avatarInitials: participant.avatarInitials ?? current?.avatarInitials
    })
  }
  const rememberAgentParticipant = (id: string, name: string, agent: Agent | null): void => {
    rememberParticipant(id, { sp: speaker(id, name), agent, isCron: false })
  }
  const pushUserTurn = (id: string, turn: Extract<Turn, { kind: 'user' }>): void => {
    rememberParticipant(id, {
      // The reader is one participant, however a turn names the account they wrote from.
      sp: turn.self ? speaker('@you') : turn.sp,
      agent: turn.agent,
      avatarUrl: turn.avatarUrl,
      avatarInitials: turn.avatarInitials,
      isCron: turn.isCron
    })
    const { text, files } = splitFilesMarker(turn.text)
    turns.push(files.length ? { ...turn, text, files } : turn)
  }
  const botTurnByKey = new Map<string, Extract<Turn, { kind: 'bot' }>>()
  // Another agent speaking here (a peer or trusted a2a bot) gets its own left-side block, grouped by its turn key or adjacency.
  const pushAgentTurn = (agent: Agent, step: FmtStep, anchor: string, turnKey?: string): void => {
    const name = agentLabel(agent)
    rememberAgentParticipant(agent.id, name, agent)
    let last = turnKey ? botTurnByKey.get(turnKey) : turns[turns.length - 1]
    last = bindWakeBlock(last, { agentId: agent.id, agentName: name }, turnKey)
    if (!last || last.kind !== 'bot' || !sameBotSpeaker(last, { agentId: agent.id, agentName: name })) {
      // `model` is the icon fallback for an agent missing from `agentById`; a peer's came from that map.
      last = {
        kind: 'bot',
        key: `b:${turnKey ?? anchor}`,
        ...anchorSeq(anchor),
        agentName: name,
        agentId: agent.id,
        model: '',
        time: '',
        steps: []
      }
      turns.push(last)
      if (turnKey) botTurnByKey.set(turnKey, last)
    }
    last.steps.push(step)
    if (last.wake) last.wake = false
    if (!last.time && step.time) last.time = step.time
  }
  // A background-task wake opens a new `wake` block in its owner's lane (the source member, else the session owner); bindWakeBlock joins its run.
  const pushOwnerWakeTurn = (step: FmtStep, anchor: string, turnKey?: string, ownerAgentId?: string): void => {
    const agentId = ownerAgentId ?? session.agentId
    const agent = agentId ? agentById.get(agentId) : undefined
    const name = agent ? agentLabel(agent) : agentId === session.agentId ? (session.agentName ?? '') : (agentId ?? '')
    const prev = turns[turns.length - 1]
    let last = turnKey ? botTurnByKey.get(turnKey) : undefined
    if (!last && prev?.kind === 'bot' && prev.wake && sameBotSpeaker(prev, { agentId, agentName: name })) last = prev
    if (!last || last.kind !== 'bot') {
      last = {
        kind: 'bot',
        // `wake` stays out of the key, so the block keeps its work panel when the reply binds.
        key: `b:${turnKey ?? anchor}`,
        ...anchorSeq(anchor),
        wake: true,
        agentName: name,
        ...(agentId ? { agentId } : {}),
        model: agentId === session.agentId ? (session.model ?? '') : '',
        time: '',
        steps: []
      }
      turns.push(last)
      if (turnKey) botTurnByKey.set(turnKey, last)
    }
    last.steps.push(step)
    if (!last.time && step.time) last.time = step.time
  }
  // A run with no block of its own binds to the trailing unanswered wake block, under the run's key.
  const bindWakeBlock = (
    found: Turn | undefined,
    speaker: { agentId?: string; agentName: string },
    turnKey?: string
  ): Turn | undefined => {
    if (found) return found
    const prev = turns[turns.length - 1]
    if (prev?.kind === 'bot' && prev.wake && sameBotSpeaker(prev, speaker)) {
      if (turnKey) botTurnByKey.set(turnKey, prev)
      return prev
    }
    return undefined
  }
  // A pending card is both a row and a replayed live event (#1794): the answerable live copy wins until it retires.
  const liveCards = liveElicitKeys(liveSteps, session.agentId)
  // An app card likewise: the live frame is what the daemon serves and a settlement reaches.
  const liveApps = liveAppKeys(liveSteps, session.agentId)
  // A capability card has the same two copies on a reload; the live one is what `capability_request_resolved` settles.
  const liveCapabilities = liveCapabilityIds(liveSteps)
  // A Fill card too: the live copy is what `fill_resolved` settles.
  const liveFills = liveFillIds(liveSteps)
  if (rows) {
    // The roots view's thread message the coordinator received: no bubble here, a label on the turn that answers it.
    let answeringThread: string | undefined
    // A handed message's own post id leads to the thread it joined, where the coordinator's work on it is drawn.
    const handedRoot = new Map(rows.flatMap((m) => (m.handedTo && m.postId ? [[m.postId, m.handedTo] as const] : [])))
    // Agent output carries `sender === agentId`, everything else is a person or schedule; an agent's run is one turn.
    for (const m of rows) {
      if (liveCards.size > 0 && (m.kind || '').toLowerCase() === 'elicit') {
        const persisted = elicitCard(m.body)
        const owner = source.agent.get(m) ?? m.sender
        if (persisted && liveCards.has(elicitStepKey(owner, persisted.requestId))) continue
      }
      if (liveCapabilities.size > 0 && (m.kind || '').toLowerCase() === 'capability') {
        const persisted = capabilityCard(m.body)
        if (persisted && liveCapabilities.has(persisted.requestId)) continue
      }
      if (liveFills.size > 0 && (m.kind || '').toLowerCase() === 'fill') {
        const persisted = fillCardBody(m.body)
        if (persisted && liveFills.has(persisted.requestId)) continue
      }
      if (liveApps.size > 0 && (m.kind || '').toLowerCase() === 'app') {
        const persisted = mcpAppCard(m.body)
        const owner = source.agent.get(m) ?? m.sender
        if (persisted && liveApps.has(appStepKey(owner, persisted.appId))) continue
      }
      const toolSessionId = source.session.get(m)
      const sourceTurnKey = source.turn.get(m)
      // A merged conversation's row carries its source's platform; a single session has one.
      const rowPlatform = source.platform.get(m) ?? session.platform
      if (m.sender === session.agentId) {
        const ownerName = session.agentName ?? ''
        let last = sourceTurnKey ? botTurnByKey.get(sourceTurnKey) : turns[turns.length - 1]
        // A hidden thread message still ends the turn before it, as its bubble would.
        if (answeringThread !== undefined && !sourceTurnKey) last = undefined
        last = bindWakeBlock(last, { agentId: m.sender, agentName: ownerName }, sourceTurnKey)
        if (!last || last.kind !== 'bot' || !sameBotSpeaker(last, { agentId: m.sender, agentName: ownerName })) {
          last = {
            kind: 'bot',
            key: `b:${sourceTurnKey ?? rowAnchor(m)}`,
            rowSeq: m.seq,
            agentName: ownerName,
            agentId: m.sender,
            model: session.model ?? '',
            time: '',
            steps: [],
            ...(answeringThread !== undefined ? { inThread: answeringThread } : {})
          }
          turns.push(last)
          if (sourceTurnKey) botTurnByKey.set(sourceTurnKey, last)
        }
        answeringThread = undefined
        const answeredIn = threadsView && threadShape ? replyToMessageThread(m, threadShape) : undefined
        // The agent's own post at the root names a thread as a person's root does.
        const ownRoot =
          threadsView && !m.thread && (m.kind || 'text').toLowerCase() === 'text' ? (m.postId ?? m.ts) : ''
        const step = {
          ...msgStep(m, toolSessionId, rowPlatform),
          ...(answeredIn ? { answeredIn } : {}),
          ...(namesThread(threadShape, ownRoot) ? { rootId: ownRoot } : {}),
          // Only its work (not its prose) moves into the thread's panel: prose there is read from the thread itself.
          ...(threadsView && m.thread && (m.kind || 'text').toLowerCase() !== 'text'
            ? { thread: handedRoot.get(m.thread) ?? m.thread }
            : {})
        }
        last.steps.push(step)
        if (last.wake) last.wake = false
        if (!last.time && step.time) last.time = step.time
      } else {
        if (threadsView && m.thread && (m.kind || 'text').toLowerCase() === 'text' && !isBgTaskWake(m.sender)) {
          answeringThread = m.thread
          continue
        }
        // A background-task wake belongs to its owning agent (a merged conversation's source member), not a person.
        if (isBgTaskWake(m.sender)) {
          const wakeMs = transcriptRowTimeMs(m)
          pushOwnerWakeTurn(
            {
              ...thinkStep(m.text, formatTranscriptRowTime(m), rowPlatform),
              ...(wakeMs === null ? {} : { timeMs: wakeMs })
            },
            rowAnchor(m),
            sourceTurnKey,
            source.agent.get(m)
          )
          continue
        }
        // Who wrote it, as the organization knows them: a bot is its agent, a linked chat account its member; two people can share a display name.
        const who = senderIdentity(m)
        const cron = asCron(m.sender)
        const senderAgent = participantAgent(who, m.text, m.trustedAgentBot)
        const senderAgentName = senderAgent ? agentLabel(senderAgent) : undefined
        const hookFallback = session.platform === 'hook' && m.sender?.startsWith('hook:') ? session.user : undefined
        const self = isSelf(who)
        if (senderAgent && !self) {
          pushAgentTurn(
            senderAgent,
            {
              ...msgStep(m, toolSessionId, rowPlatform),
              ...(m.attachments?.[0] ? { image: m.attachments[0] } : {}),
              // Only a copy from another member's session is a peer copy; the author's own row resolves through its session.
              ...(m.sharedImage && source.agent.get(m) !== senderAgent.id ? { peerCopy: true } : {})
            },
            rowAnchor(m),
            sourceTurnKey
          )
          continue
        }
        const participant = self
          ? // Written from a linked chat account rather than the console: the turn says which.
            speaker('@you', who !== m.sender ? `You (${platName(rowPlatform)})` : undefined)
          : speaker(
              senderAgentName ?? who,
              cron?.name ??
                (cron
                  ? 'Schedule'
                  : senderLabel(who, m.senderName ?? hookFallback ?? platformSenderFallback(rowPlatform, m.sender)))
            )
        answeringThread = undefined
        pushUserTurn(senderAgent?.id ?? who, {
          kind: 'user',
          key: `u:${rowAnchor(m)}`,
          rowSeq: m.seq,
          messageId: m.postId ?? m.ts,
          sp: participant,
          agent: senderAgent ?? null,
          // The reader keeps one face across the accounts they write from.
          avatarUrl: self ? (viewer.picture ?? m.senderAvatarUrl) : (m.senderAvatarUrl ?? pictureOf(who)),
          avatarInitials: self ? viewer.initials : undefined,
          ...(self ? { self: true } : {}),
          sourceLabel: sourceLabel,
          time: formatTranscriptRowTime(m),
          ...timeMsField(transcriptRowTimeMs(m)),
          text: m.text,
          ...(m.attachments?.length ? { images: m.attachments } : {}),
          isCron: !!cron,
          cronId: cron?.id ?? null,
          platform: rowPlatform,
          body: parseUserTurnBody(m.body),
          // Seqs are per daemon store, so only the owner's own rows can match its gate's verdicts.
          ...(ownsDecisionSeq(m) ? { seq: m.seq } : {}),
          ...(m.handedTo ? { handedTo: m.handedTo } : {})
        })
      }
    }
  } else {
    let firstMsg = true
    // A confirmed steer fences the running turn's block: the reply after it starts a fresh block below it; a pending one keeps the block above growing (#1847).
    let steerSegment = 0
    const segmentedKey = (turnKey: string | undefined): string | undefined =>
      turnKey && steerSegment > 0 ? `${turnKey}:s${steerSegment}` : turnKey
    session.steps.forEach((stp) => {
      if (stp.kind === 'msg') {
        if (stp.steered) steerSegment += 1
        const who = stp.who ?? session.user
        if (isBgTaskWake(stp.who)) {
          pushOwnerWakeTurn(
            thinkStep(stp.text, stp.time, session.platform),
            liveAnchor(stp),
            liveBotTurnKey(stp.turnId, session.agentId)
          )
          firstMsg = false
          return
        }
        const cron = asCron(who)
        const senderAgent = participantAgent(who, stp.text)
        const senderAgentName = senderAgent ? agentLabel(senderAgent) : undefined
        const self = isSelf(who)
        if (senderAgent && !self) {
          pushAgentTurn(
            senderAgent,
            plainStep(stp.text, stp.time ?? (firstMsg ? session.time : ''), stp.image, session.platform),
            liveAnchor(stp),
            liveBotTurnKey(stp.turnId, senderAgent.id)
          )
          firstMsg = false
          return
        }
        const participant = self
          ? speaker('@you')
          : speaker(
              senderAgentName ?? who,
              cron?.name ?? (cron ? 'Schedule' : (senderAgentName ?? platformSenderFallback(session.platform, who)))
            )
        pushUserTurn(senderAgent?.id ?? who, {
          kind: 'user',
          key: `u:${liveAnchor(stp)}`,
          sp: participant,
          agent: senderAgent ?? null,
          avatarUrl: self ? viewer.picture : pictureOf(who),
          avatarInitials: self ? viewer.initials : undefined,
          ...(self ? { self: true } : {}),
          sourceLabel: sourceLabel,
          time: stp.time ?? (firstMsg ? session.time : ''),
          ...(stp.observedAtMs !== undefined ? { timeMs: stp.observedAtMs } : {}),
          text: stp.text,
          ...(stp.images?.length ? { images: stp.images } : stp.image ? { images: [stp.image] } : {}),
          isCron: !!cron,
          cronId: cron?.id ?? null,
          ...(stp.steer ? { steer: true, ...(stp.steered ? { steered: true } : {}) } : {}),
          platform: session.platform
        })
        firstMsg = false
      } else {
        // A live step's lane `agentId` is authoritative; its name comes from the org's agents, since stream-time `who` can be missing.
        const stepAgent = stp.agentId ? agentById.get(stp.agentId) : undefined
        const stepAgentName = (stepAgent ? agentLabel(stepAgent) : stp.who) ?? session.agentName ?? ''
        if (stp.agentId && stp.agentId !== session.agentId) {
          rememberAgentParticipant(stp.agentId, stepAgentName, stepAgent ?? null)
        }
        const turnKey = segmentedKey(liveBotTurnKey(stp.turnId, stp.agentId))
        let last = turnKey ? botTurnByKey.get(turnKey) : turns[turns.length - 1]
        last = bindWakeBlock(last, { agentId: stp.agentId, agentName: stepAgentName }, turnKey)
        if (!last || last.kind !== 'bot' || !sameBotSpeaker(last, { agentId: stp.agentId, agentName: stepAgentName })) {
          last = {
            kind: 'bot',
            key: `b:${turnKey ?? liveAnchor(stp)}`,
            agentName: stepAgentName,
            ...(stp.agentId ? { agentId: stp.agentId } : {}),
            model: session.model ?? '',
            time: '',
            steps: []
          }
          turns.push(last)
          if (turnKey) botTurnByKey.set(turnKey, last)
        } else if (stp.agentId && last.agentId === undefined) {
          // A tagged step continuing an untagged block names its author retroactively.
          last.agentId = stp.agentId
        }
        const step = fmtStep(stp, session.platform)
        if (step.sharedImage && stp.agentId && stp.agentId !== session.agentId && !stp.toolSessionId)
          step.peerCopy = true
        last.steps.push(step)
        if (last.wake) last.wake = false
        if (!last.time && step.time) last.time = step.time
      }
    })
  }

  // An adopted webchat session or a continuation layers this visit's turns below its fetched history.
  if (liveSteps.length > 0) {
    let steerSegment = 0
    const segmentedKey = (turnKey: string | undefined): string | undefined =>
      turnKey && steerSegment > 0 ? `${turnKey}:s${steerSegment}` : turnKey
    // What this visit said in a thread is drawn there; a coordinator turn answering it stays here, labelled.
    const liveThreadOf = new Map<string, string>()
    for (const stp of liveSteps) {
      if (stp.thread) {
        if (stp.kind === 'msg') liveThreadOf.set(stp.turnId, stp.thread)
        continue
      }
      if (stp.kind === 'msg') {
        if (stp.steered) steerSegment += 1
        const who = stp.who ?? session.user
        if (isBgTaskWake(stp.who)) {
          pushOwnerWakeTurn(
            thinkStep(stp.text, stp.time, session.platform),
            liveAnchor(stp),
            liveBotTurnKey(stp.turnId, session.agentId)
          )
          continue
        }
        const senderAgent = participantAgent(who, stp.text)
        const senderAgentName = senderAgent ? agentLabel(senderAgent) : undefined
        const self = isSelf(who)
        if (senderAgent && !self) {
          pushAgentTurn(
            senderAgent,
            plainStep(stp.text, stp.time ?? '', stp.image, session.platform),
            liveAnchor(stp),
            liveBotTurnKey(stp.turnId, senderAgent.id)
          )
          continue
        }
        const cron = asCron(who)
        const participant = self
          ? speaker('@you')
          : speaker(
              senderAgentName ?? who,
              cron?.name ?? (cron ? 'Schedule' : (senderAgentName ?? platformSenderFallback(session.platform, who)))
            )
        pushUserTurn(senderAgent?.id ?? who, {
          kind: 'user',
          key: `u:${liveAnchor(stp)}`,
          sp: participant,
          agent: senderAgent ?? null,
          avatarUrl: self ? viewer.picture : pictureOf(who),
          avatarInitials: self ? viewer.initials : undefined,
          ...(self ? { self: true } : {}),
          sourceLabel: sourceLabel,
          time: stp.time ?? '',
          ...(stp.observedAtMs !== undefined ? { timeMs: stp.observedAtMs } : {}),
          text: stp.text,
          ...(stp.images?.length ? { images: stp.images } : stp.image ? { images: [stp.image] } : {}),
          isCron: !!cron,
          cronId: cron?.id ?? null,
          ...(stp.steer ? { steer: true, ...(stp.steered ? { steered: true } : {}) } : {}),
          platform: session.platform
        })
      } else {
        const stepAgent = stp.agentId ? agentById.get(stp.agentId) : undefined
        const stepAgentName = (stepAgent ? agentLabel(stepAgent) : stp.who) ?? session.agentName ?? ''
        if (stp.agentId && stp.agentId !== session.agentId) {
          rememberAgentParticipant(stp.agentId, stepAgentName, stepAgent ?? null)
        }
        const turnKey = segmentedKey(liveBotTurnKey(stp.turnId, stp.agentId))
        let last = turnKey ? botTurnByKey.get(turnKey) : turns[turns.length - 1]
        last = bindWakeBlock(last, { agentId: stp.agentId, agentName: stepAgentName }, turnKey)
        if (!last || last.kind !== 'bot' || !sameBotSpeaker(last, { agentId: stp.agentId, agentName: stepAgentName })) {
          const inThread = liveThreadOf.get(stp.turnId)
          last = {
            kind: 'bot',
            key: `b:${turnKey ?? liveAnchor(stp)}`,
            agentName: stepAgentName,
            ...(stp.agentId ? { agentId: stp.agentId } : {}),
            model: session.model ?? '',
            time: '',
            steps: [],
            ...(inThread ? { inThread } : {})
          }
          turns.push(last)
          if (turnKey) botTurnByKey.set(turnKey, last)
        } else if (stp.agentId && last.agentId === undefined) {
          // A tagged step continuing an untagged block names its author retroactively.
          last.agentId = stp.agentId
        }
        const step = fmtStep(stp, session.platform)
        if (step.sharedImage && stp.agentId && stp.agentId !== session.agentId && !stp.toolSessionId)
          step.peerCopy = true
        // A post that just arrived at the root names its thread before its row is read.
        if (threadsView && stp.kind === 'done' && namesThread(threadShape, stp.postId)) step.rootId = stp.postId
        last.steps.push(step)
        if (last.wake) last.wake = false
        if (!last.time && step.time) last.time = step.time
      }
    }
  }
  return { turns, speakers }
}
