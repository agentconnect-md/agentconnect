import { describe, it, expect } from 'vitest'
import { toolsForIntegrations, ALL_TOOL_NAMES, GITHUB_REVIEW_TOOLS } from '../src/mcp/tools.js'
import { externalMemoryTools } from '../src/memory/tools.js'
import type { Integration } from '../src/agents/agent-schema.js'
import { SEND_MESSAGE_ACTION_SCHEMAS } from '../src/mcp/ops.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { sendMessageGuide } from '../src/mcp/ops/tool-guide.js'

const slackInt: Integration = {
  id: 'int-1',
  platform: 'slack',
  core: {
    mode: 'direct',
    bindRules: [],
    mutedChannels: [],
    gated: false,
    sessionModes: [],
    decisions: { bindings: [], definitions: [] }
  },
  config: { botToken: 'xoxb', appToken: 'xapp' }
}

const telegramInt: Integration = {
  id: 'int-2',
  platform: 'telegram',
  core: {
    mode: 'direct',
    bindRules: [],
    mutedChannels: [],
    gated: false,
    sessionModes: [],
    decisions: { bindings: [], definitions: [] }
  },
  config: { botToken: '123456:ABC' }
}

const qqInt: Integration = {
  id: 'int-qq',
  platform: 'qq',
  core: {
    mode: 'direct',
    bindRules: [],
    mutedChannels: [],
    gated: false,
    sessionModes: [],
    decisions: { bindings: [], definitions: [] }
  },
  config: { appId: '100', appSecret: 'secret' }
}

// Connected platforms that declare NO credentialed-attachment read port — the
// arm the file-tool matrix below would never exercise with Slack/Telegram alone.
const discordInt: Integration = {
  id: 'int-3',
  platform: 'discord',
  core: {
    mode: 'direct',
    bindRules: [],
    mutedChannels: [],
    gated: false,
    sessionModes: [],
    decisions: { bindings: [], definitions: [] }
  },
  config: { botToken: 'dc' }
}

const feishuInt: Integration = {
  id: 'int-4',
  platform: 'feishu',
  core: {
    mode: 'direct',
    bindRules: [],
    mutedChannels: [],
    gated: false,
    sessionModes: [],
    decisions: { bindings: [], definitions: [] }
  },
  config: { appId: 'cli_x', appSecret: 's', region: 'feishu' }
}

describe('toolsForIntegrations', () => {
  it('offers shareFile to an integration-less session only when the console can show shared images', () => {
    expect(toolsForIntegrations([]).map((t) => t.name)).not.toContain('shareFile')
    const names = toolsForIntegrations([], { currentPlatform: 'webchat', consoleImages: true }).map((t) => t.name)
    expect(names.filter((name) => name === 'shareFile')).toHaveLength(1)
  })

  const sendTool = (ints: Integration[]) => toolsForIntegrations(ints).find((t) => t.name === 'sendMessage')
  type ObjectSchema = {
    type?: string
    description?: string
    properties: Record<string, { enum?: string[]; description?: string; oneOf?: Record<string, unknown>[] }>
    required?: string[]
    additionalProperties?: boolean
    oneOf?: ObjectSchema[]
  }
  const sendSchema = (ints: Integration[]) => sendTool(ints)!.inputSchema as unknown as ObjectSchema
  // The flat sendMessage schema's one platform enum, narrowed to the agent's platforms.
  const sendPlatformEnum = (ints: Integration[]) => sendSchema(ints).properties.platform!.enum
  const guideCtx = (ints: Integration[]): SessionContext => ({
    agentId: 'agent-self',
    platform: 'slack',
    isDm: false,
    channel: 'C1',
    thread: '100.1',
    deliveryThread: '100.1',
    tools: toolsForIntegrations(ints),
    integrations: ints.map((i) => ({ id: i.id, platform: i.platform }))
  })
  const guideRules = (ints: Integration[], action: keyof typeof SEND_MESSAGE_ACTION_SCHEMAS) =>
    (sendMessageGuide(guideCtx(ints), action).rules as string[]).join('\n')
  const actionKeys = (action: keyof typeof SEND_MESSAGE_ACTION_SCHEMAS) =>
    Object.keys((SEND_MESSAGE_ACTION_SCHEMAS[action] as unknown as { shape: Record<string, unknown> }).shape)

  it('injects the Slack read tools + the unified send tool for a Slack integration', () => {
    const names = toolsForIntegrations([slackInt]).map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'sendMessage',
        'getCurrentChannel',
        'listChannelMembers',
        'listChannels',
        'getUserProfile',
        'getChannelHistory',
        'readSlackFile'
      ])
    )
    // The send tool's platform enum is narrowed to what the agent actually has.
    expect(sendPlatformEnum([slackInt])).toEqual(['slack'])
  })

  const PORT_GATED = [
    'getThreadHistory',
    'addReaction',
    'getReactions',
    'createConversation',
    'searchPublicMessages',
    'scheduleMessage',
    'createCanvas',
    'readCanvas',
    'updateCanvas',
    'listBookmarks',
    'addBookmark',
    'removeBookmark',
    'readList',
    'addListItem',
    'updateListItem'
  ]

  it('injects each port-gated tool only into a session ON a platform that declares the port', () => {
    const slackNames = toolsForIntegrations([slackInt], { currentPlatform: 'slack' }).map((t) => t.name)
    expect(slackNames).toEqual(expect.arrayContaining(PORT_GATED))
    // A single-platform agent's only platform is its session platform when none is named.
    expect(toolsForIntegrations([slackInt]).map((t) => t.name)).toEqual(expect.arrayContaining(PORT_GATED))
    // Telegram/Discord/Feishu declare none of them, so an agent without Slack sees none —
    // the gate is the DECLARATION, not the platform name.
    for (const other of [telegramInt, discordInt, feishuInt]) {
      const names = toolsForIntegrations([other], { currentPlatform: other.platform }).map((t) => t.name)
      for (const gated of PORT_GATED) expect(names).not.toContain(gated)
    }
  })

  it('keeps a bridged agent’s Slack-shaped tools out of its sessions on every other platform', () => {
    const bridged = [slackInt, telegramInt, discordInt, feishuInt]
    const namesOn = (currentPlatform?: string) =>
      toolsForIntegrations(bridged, currentPlatform ? { currentPlatform } : {}).map((t) => t.name)
    expect(namesOn('slack')).toEqual(expect.arrayContaining(PORT_GATED))
    // The same agent, answering elsewhere: the tools are gone, not merely narrowed. Having
    // Slack does not make a Telegram turn a place to create a canvas.
    for (const elsewhere of ['telegram', 'discord', 'feishu', 'webchat']) {
      for (const gated of PORT_GATED) expect(namesOn(elsewhere)).not.toContain(gated)
    }
    // No session platform at all (a multi-platform agent built without one) opens no gate.
    for (const gated of PORT_GATED) expect(namesOn(undefined)).not.toContain(gated)
    // The neutral reads still span every platform the agent has.
    const listChannels = toolsForIntegrations(bridged, { currentPlatform: 'telegram' }).find(
      (t) => t.name === 'listChannels'
    )!
    expect((listChannels.inputSchema.properties as Record<string, { enum?: string[] }>).platform?.enum).toEqual([
      'slack',
      'telegram',
      'discord',
      'feishu'
    ])
  })

  it('gives a port-gated tool a bot selector but no platform selector — it acts where the session is', () => {
    const props = (name: string) =>
      Object.keys(
        (
          toolsForIntegrations([slackInt, telegramInt], { currentPlatform: 'slack' }).find((t) => t.name === name)!
            .inputSchema as Record<string, unknown>
        ).properties as Record<string, unknown>
      )
    for (const gated of PORT_GATED) {
      expect(props(gated), gated).not.toContain('platform')
      // `searchPublicMessages` is the one exception, and it is not an oversight. Its credential is
      // parked against the bot that RECEIVED the triggering message, so naming another bot on
      // the same platform could only ever produce "this turn has no search credential". A knob
      // whose every setting but one fails is worse than no knob.
      if (gated === 'searchPublicMessages') {
        expect(props(gated), gated).not.toContain('integrationId')
        continue
      }
      expect(props(gated), gated).toContain('integrationId')
    }
  })

  it('injects the platform-neutral read tools + the unified send tool for a Telegram integration', () => {
    const names = toolsForIntegrations([telegramInt]).map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'sendMessage',
        'getCurrentChannel',
        'listChannelMembers',
        // listChannels is platform-neutral now; Telegram just returns an empty list at call time.
        'listChannels',
        'getUserProfile',
        'readTelegramFile'
      ])
    )
    expect(names).not.toContain('readSlackFile') // the Slack file tool is still platform-gated
    expect(names).not.toContain('getChannelHistory')
    expect(sendPlatformEnum([telegramInt])).toEqual(['telegram'])
  })

  it('injects channel history only for the current session platform when its adapter is registered', () => {
    const integrations = [slackInt, telegramInt, discordInt, feishuInt]
    const namesFor = (currentPlatform: string) =>
      toolsForIntegrations(integrations, { currentPlatform }).map((tool) => tool.name)

    for (const platform of ['slack', 'discord', 'feishu']) {
      expect(namesFor(platform)).toContain('getChannelHistory')
    }
    expect(namesFor('telegram')).not.toContain('getChannelHistory')
  })

  it('narrows the read tools’ platform enum to the agent’s platforms and routes cross-platform', () => {
    const readTool = (ints: Integration[], name: string) => toolsForIntegrations(ints).find((t) => t.name === name)!
    const enumOf = (t: { inputSchema: Record<string, unknown> }) =>
      (t.inputSchema.properties as Record<string, { enum: string[] }>).platform!.enum
    // A bridged agent's read tools can target either platform.
    expect(enumOf(readTool([slackInt, telegramInt], 'listChannels'))).toEqual(['slack', 'telegram'])
    expect(enumOf(readTool([slackInt, telegramInt], 'getUserProfile'))).toEqual(['slack', 'telegram'])
    expect(enumOf(readTool([slackInt, telegramInt], 'listKnownUsers'))).toEqual(['slack', 'telegram'])
    // A single-platform agent's enum is that one platform.
    expect(enumOf(readTool([slackInt], 'listChannelMembers'))).toEqual(['slack'])
    // Gateway-backed reads expose integrationId (bot disambiguation) like sendMessage;
    // listKnownUsers does not (history is not per-integration).
    const props = (t: { inputSchema: Record<string, unknown> }) => t.inputSchema.properties as Record<string, unknown>
    for (const n of ['listChannels', 'listChannelMembers', 'getUserProfile']) {
      expect(props(readTool([slackInt, telegramInt], n))).toHaveProperty('integrationId')
    }
    const historyTool = toolsForIntegrations([slackInt, telegramInt], { currentPlatform: 'slack' }).find(
      (tool) => tool.name === 'getChannelHistory'
    )!
    const historyProps = props(historyTool)
    expect(Object.keys(historyProps).sort()).toEqual([
      'channel',
      'cursor',
      'integrationId',
      'latest',
      'limit',
      'oldest'
    ])
    expect(props(readTool([slackInt, telegramInt], 'listKnownUsers'))).not.toHaveProperty('integrationId')
  })

  it('offers one send tool spanning both platforms when an agent bridges them, and dedupes read helpers', () => {
    const names = toolsForIntegrations([slackInt, telegramInt]).map((t) => t.name)
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]) // no duplicate names
    expect(names.filter((n) => n === 'sendMessage')).toHaveLength(1)
    expect(sendPlatformEnum([slackInt, telegramInt])).toEqual(['slack', 'telegram'])
    expect(names.filter((n) => n === 'getCurrentChannel')).toHaveLength(1)
  })

  /**
   * The credentialed-attachment tools are injected because the platform DECLARES
   * the Layer-1 read port (`platforms/read-ports.ts`), not because this file knows
   * the words "slack" and "telegram". The matrix below is the behavioral contract
   * that survived that change: same tools, same names, same order, for every
   * combination of connected platforms.
   */
  it('injects each platform’s credentialed file tool for exactly the platforms that declare one', () => {
    const fileTools = (ints: Integration[]) =>
      toolsForIntegrations(ints)
        .map((t) => t.name)
        .filter((n) => n.startsWith('read') && n.endsWith('File'))

    expect(fileTools([])).toEqual([])
    expect(fileTools([slackInt])).toEqual(['readSlackFile'])
    expect(fileTools([telegramInt])).toEqual(['readTelegramFile'])
    expect(fileTools([qqInt])).toEqual(['readQQFile'])
    expect(fileTools([slackInt, telegramInt, qqInt])).toEqual(['readSlackFile', 'readTelegramFile', 'readQQFile'])
    // Registry order, not integration order — a stored-the-other-way-round agent
    // must not see its tool list reshuffle.
    expect(fileTools([qqInt, telegramInt, slackInt])).toEqual(['readSlackFile', 'readTelegramFile', 'readQQFile'])
    // A connected platform that declares no such port contributes no tool, alone…
    expect(fileTools([discordInt])).toEqual([])
    expect(fileTools([feishuInt])).toEqual([])
    // …and does not suppress the ones that do.
    expect(fileTools([discordInt, slackInt, feishuInt])).toEqual(['readSlackFile'])
    // Two bots on the same platform still yield ONE tool (the `seen` dedupe).
    expect(fileTools([slackInt, { ...slackInt, id: 'int-1b' }])).toEqual(['readSlackFile'])
    // The platform read helpers are unaffected — they were never port-gated.
    expect(toolsForIntegrations([discordInt]).map((t) => t.name)).toEqual(
      expect.arrayContaining(['getCurrentChannel', 'listChannels'])
    )
  })

  it('accepts `thread` on postMessage ONLY, on any integration set', () => {
    // send-message-routing-rework.md §2.2/§2.4: the update form is the only visible in-thread send.
    for (const ints of [[slackInt], [telegramInt], [slackInt, telegramInt]]) {
      expect(Object.keys(sendSchema(ints).properties)).toContain('thread')
    }
    for (const action of Object.keys(SEND_MESSAGE_ACTION_SCHEMAS) as (keyof typeof SEND_MESSAGE_ACTION_SCHEMAS)[]) {
      expect(actionKeys(action).includes('thread'), action).toBe(action === 'postMessage')
    }
    expect(guideRules([slackInt], 'postMessage')).toContain('`thread` is only for a bare `channel` post')
  })

  it('descriptor shape: one flat object with a required action, no top-level union, within the size budget', () => {
    const tool = sendTool([slackInt])!
    expect(tool.name).toBe('sendMessage')
    const schema = sendSchema([slackInt])
    expect(schema.type).toBe('object')
    expect(schema).not.toHaveProperty('oneOf')
    expect(schema).not.toHaveProperty('anyOf')
    expect(schema.required).toEqual(['action', 'message'])
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties)).toEqual([
      'action',
      'message',
      'toAgent',
      'toUser',
      'channel',
      'thread',
      'sessionId',
      'taskId',
      'messageId',
      'attachment',
      'platform',
      'integrationId'
    ])
    expect(schema.properties.action!.enum).toEqual([
      'callAgent',
      'startTask',
      'messageTask',
      'replyToSession',
      'postMessage'
    ])
    expect(schema.properties.toUser!.oneOf).toMatchObject([
      { type: 'string', minLength: 1 },
      { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } }
    ])
    for (const ints of [[], [slackInt], [slackInt, telegramInt, discordInt, feishuInt, qqInt]]) {
      expect(sendTool(ints)!.description.length).toBeLessThanOrEqual(1024)
    }
    const guide = toolsForIntegrations([slackInt]).find((t) => t.name === 'getToolGuide')!
    expect(guide.description.length + JSON.stringify(guide.inputSchema).length).toBeLessThanOrEqual(600)
    expect(guide.inputSchema).not.toHaveProperty('oneOf')
    expect(tool.description).toContain('Required action: callAgent')
    expect(tool.description).toContain('Call getToolGuide {"tool":"sendMessage"} for arguments and examples.')
    expect(tool.description).toContain('Calls without action fail without sending anything.')
    expect(tool.description).toContain('toAgent: {agentId: "...", needsReply: true}')
    // Tasks and explicit peer sessions are advertised now that the daemon implements both (§8, §9).
    expect(tool.description).toContain('sessionId continues an existing peer session')
    expect(tool.description).toContain('startTask starts a background task of this session')
    expect(tool.description).toContain('messageTask sends a task you started more (taskId)')
    // §9.4: a reply names the message it answers.
    expect(tool.description).toContain('replyToSession answers a message another session sent you, by its messageId')
    expect(schema.properties.sessionId!.description).toContain('callAgent only')
    expect(schema.properties.messageId!.description).toContain('replyToSession only')
  })

  it('states what a channel-root post costs, and points a relayed answer at the message it answers', () => {
    const description = sendTool([slackInt])!.description
    expect(description).toContain('For your current conversation, write your ordinary reply.')
    expect(guideRules([slackInt], 'replyToSession')).toContain(
      'Never post the answer at that conversation’s channel root instead: that starts a separate conversation.'
    )
    expect(guideRules([slackInt], 'postMessage')).toContain(
      'posts one message at the channel root that @-mentions all of them'
    )
    expect(guideRules([slackInt], 'postMessage')).toContain(
      'never for the thread you are answering — that is your ordinary reply'
    )
  })

  it('`toAgent` accepts the bare agent id OR an {agentId, needsReply} object', () => {
    const branches = (sendSchema([slackInt]).properties.toAgent as { oneOf: unknown[] }).oneOf as {
      type?: string
      properties?: Record<string, unknown>
      required?: string[]
      additionalProperties?: boolean
    }[]
    // The bare-string form stays FIRST; the object form only layers delivery options onto it.
    expect(branches).toHaveLength(2)
    expect(branches[0]!.type).toBe('string')
    expect(Object.keys(branches[1]!.properties!)).toEqual(['agentId', 'needsReply'])
    expect(branches[1]!.required).toEqual(['agentId'])
    expect(branches[1]!.additionalProperties).toBe(false)
  })

  it('teaches discovery and the guide how to address self without confusing the Slack bot identity', () => {
    const listAgents = toolsForIntegrations([slackInt]).find((tool) => tool.name === 'listAgents')!
    expect(listAgents.description).toContain('INCLUDING YOURSELF')
    expect(listAgents.description).toContain('`callAgent` with `channel`')
    const callAgent = guideRules([slackInt], 'callAgent')
    expect(callAgent).toContain('never a platform member id such as a Slack `U…` id')
    expect(callAgent).toContain('Your own id (agent-self) with `channel` opens and activates a visible conversation')
    expect(guideRules([slackInt], 'postMessage')).toContain('never an AgentConnect agent or your own bot identity')
  })

  it('still injects sendMessage and its guide for an agent with no integrations, but no platform read tools', () => {
    const names = toolsForIntegrations([]).map((t) => t.name)
    expect(names).toContain('sendMessage')
    expect(names).toContain('getToolGuide')
    expect(names).not.toContain('getCurrentChannel')
    expect(names).not.toContain('listChannels')
    // With no platform, `platform` still describes the field but has no selectable enum.
    expect(sendSchema([]).properties.platform).not.toHaveProperty('enum')
  })

  it('injects the universal memory + collaboration + send tools for every agent, even with no integrations', () => {
    const tools = toolsForIntegrations([])
    expect(tools.map((t) => t.name)).toEqual([
      'describeMemoryEntries',
      'listMemoryEntries',
      'getMemoryEntry',
      'searchMemoryEntries',
      'createMemoryEntry',
      'updateMemoryEntry',
      'deleteMemoryEntry',
      'readMemory',
      'writeMemory',
      'listAgents',
      // still offered under the old name, for sessions already warm with it
      'listChannelAgents',
      'viewSessionStatus',
      'recall',
      'sendMessage',
      'getToolGuide'
    ])
  })

  it('offers one surface only: every composition carries every sendMessage action', () => {
    // There is exactly ONE tool surface, and it is the production one.
    const surfaces = [
      toolsForIntegrations([]),
      toolsForIntegrations([slackInt]),
      toolsForIntegrations([slackInt, telegramInt, discordInt], { organizationKnowledge: true })
    ]
    for (const tools of surfaces) {
      const names = tools.map((tool) => tool.name)
      for (const required of ['listAgents', 'listChannelAgents', 'viewSessionStatus', 'sendMessage', 'getToolGuide']) {
        expect(names).toContain(required)
      }
      const send = tools.find((tool) => tool.name === 'sendMessage')!
      const schema = send.inputSchema as unknown as ObjectSchema
      expect(schema.properties.action!.enum).toEqual([
        'callAgent',
        'startTask',
        'messageTask',
        'replyToSession',
        'postMessage'
      ])
      expect(send.description).not.toContain('disabled for this run')
    }
  })

  it('every injected tool exposes a JSON-Schema object input + a description', () => {
    for (const t of toolsForIntegrations([slackInt, telegramInt])) {
      expect(t.inputSchema).toMatchObject({ type: 'object' })
      expect(typeof t.description).toBe('string')
    }
  })

  it('tells replace edits to source oldString only from actual memory-file content', () => {
    const writeMemory = toolsForIntegrations([]).find((t) => t.name === 'writeMemory')!
    expect(writeMemory.description).toContain('Never source it from surrounding session context')
    expect(writeMemory.description).toContain('workspace or git status')
    expect(writeMemory.description).toContain('fresh `readMemory`')
    expect(writeMemory.description).toContain("decode exactly one layer of the injected boundary's documented XML")

    const properties = writeMemory.inputSchema.properties as Record<string, { description?: string }>
    expect(properties.oldString?.description).toBe(
      'Edit mode: exact text to replace; must occur exactly once in the target memory file.'
    )
  })

  it('ALL_TOOL_NAMES reserves every dispatchable product tool exactly once', () => {
    expect(new Set(ALL_TOOL_NAMES).size).toBe(ALL_TOOL_NAMES.length)
    expect(ALL_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        'sendMessage',
        'listChannels',
        'getChannelHistory',
        // Port-gated names are reserved too: the auto-allow set is about names some platform
        // CAN inject, not about what this agent happens to have.
        'getThreadHistory',
        'addReaction',
        'getReactions',
        'createConversation',
        'searchPublicMessages',
        'scheduleMessage',
        'createCanvas',
        'readCanvas',
        'updateCanvas',
        'listBookmarks',
        'addBookmark',
        'removeBookmark',
        'readList',
        'addListItem',
        'updateListItem',
        'readTelegramFile',
        'searchMemory',
        'saveMemory',
        'getMemory',
        'updateMemory',
        'deleteMemory',
        'submitCodeReview',
        // The pre-promotion alias stays reserved and auto-allowed for warm sessions.
        'submitGithubReview'
      ])
    )
    // The merged-away and removed tool names are gone.
    for (const name of [
      'sendPlatformMessage',
      'messageAgent',
      'startOrchestration',
      'getOrchestration',
      'cancelOrchestration'
    ])
      expect(ALL_TOOL_NAMES).not.toContain(name)
  })

  it('projects only reviewed external-memory capabilities onto stable core tool names', () => {
    expect(externalMemoryTools(new Set(['recall', 'capture', 'get', 'delete'])).map((tool) => tool.name)).toEqual([
      'describeMemoryEntries',
      'getMemoryEntry',
      'searchMemoryEntries',
      'deleteMemoryEntry',
      'searchMemory',
      'getMemory',
      'deleteMemory'
    ])
    for (const tool of externalMemoryTools(new Set(['recall', 'create', 'get', 'update', 'delete']))) {
      expect(tool.name).not.toMatch(/^agentconnect_memory_/)
      // A union descriptor closes each branch; every other descriptor closes its one object.
      const schema = tool.inputSchema as { type: string; oneOf?: Array<Record<string, unknown>> }
      for (const branch of schema.oneOf ?? [schema])
        expect(branch).toMatchObject({ type: 'object', additionalProperties: false })
    }
  })

  it('formal review descriptor has no model-selectable code-host target', () => {
    const tool = GITHUB_REVIEW_TOOLS.find((candidate) => candidate.name === 'submitCodeReview')!
    expect(tool.name).toBe('submitCodeReview')
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>
    expect(Object.keys(properties)).toEqual(['event', 'verdict', 'body', 'comments'])
    expect(properties).not.toHaveProperty('repoFullName')
    expect(properties).not.toHaveProperty('pullNumber')
    expect(properties).not.toHaveProperty('commitId')
    expect(properties).not.toHaveProperty('projectId')
    expect(properties).not.toHaveProperty('mergeRequestIid')
    expect(properties.body).toMatchObject({ minLength: 1 })
    expect(tool.description).toContain('only a definite not_submitted result preserves')
    expect(tool.description).toContain('REQUEST_CHANGES requires verdict fail')
  })

  it('batched review replies select only trusted thread roots exposed by the prompt', () => {
    const tool = GITHUB_REVIEW_TOOLS.find((candidate) => candidate.name === 'replyGithubReviewThreads')!
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, any>
    expect(Object.keys(properties)).toEqual(['replies'])
    expect(properties.replies).toMatchObject({ minItems: 1, maxItems: 25 })
    expect(properties.replies.items.properties).toHaveProperty('threadRootCommentId')
    expect(properties.replies.items.properties).not.toHaveProperty('repo')
    expect(properties.replies.items.properties).not.toHaveProperty('number')
  })
})

describe('platform session tools (read-ports.ts `sessionTools`)', () => {
  const linearInt: Integration = {
    id: 'int-ln',
    platform: 'linear',
    core: {
      mode: 'shared',
      bindRules: [],
      mutedChannels: [],
      gated: false,
      sessionModes: [],
      decisions: { bindings: [], definitions: [] }
    },
    config: {}
  } as Integration
  const LINEAR_TOOL_NAMES = ['getIssue', 'listIssues', 'createIssue', 'updateIssue', 'createIssueComment', 'listTeams']

  it('injects Linear’s tool family into a Linear session, and into no other session of the same agent', () => {
    const bridged = [slackInt, linearInt]
    const namesOn = (currentPlatform: string) => toolsForIntegrations(bridged, { currentPlatform }).map((t) => t.name)
    expect(namesOn('linear')).toEqual(expect.arrayContaining(LINEAR_TOOL_NAMES))
    for (const gated of LINEAR_TOOL_NAMES) {
      expect(namesOn('slack')).not.toContain(gated)
      expect(namesOn('webchat')).not.toContain(gated)
    }
    // A single-platform Linear agent's only platform is its session platform.
    expect(toolsForIntegrations([linearInt]).map((t) => t.name)).toEqual(expect.arrayContaining(LINEAR_TOOL_NAMES))
    // Slack's own port-gated tools stay out of the Linear session in return.
    expect(namesOn('linear')).not.toContain('createCanvas')
  })

  it('reserves every platform’s session tool name in the auto-allow set', () => {
    for (const name of LINEAR_TOOL_NAMES) expect(ALL_TOOL_NAMES).toContain(name)
  })
})
