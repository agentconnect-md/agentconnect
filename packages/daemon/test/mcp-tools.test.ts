import { describe, it, expect } from 'vitest'
import { toolsForIntegrations, ALL_TOOL_NAMES, GITHUB_REVIEW_TOOLS, externalMemoryTools } from '../src/mcp/tools.js'
import type { Integration } from '../src/agents/agent-schema.js'

const slackInt: Integration = {
  id: 'int-1',
  platform: 'slack',
  slack: { botToken: 'xoxb', appToken: 'xapp', bindRules: [] }
}

const telegramInt: Integration = {
  id: 'int-2',
  platform: 'telegram',
  telegram: { botToken: '123456:ABC', bindRules: [] }
}

// Connected platforms that declare NO credentialed-attachment read port — the
// arm the file-tool matrix below would never exercise with Slack/Telegram alone.
const discordInt: Integration = {
  id: 'int-3',
  platform: 'discord',
  discord: { botToken: 'dc', bindRules: [], mutedChannels: [], gated: false }
}

const feishuInt: Integration = {
  id: 'int-4',
  platform: 'feishu',
  feishu: {
    mode: 'direct',
    appId: 'cli_x',
    appSecret: 's',
    region: 'feishu',
    bindRules: [],
    mutedChannels: [],
    gated: false
  }
}

describe('toolsForIntegrations', () => {
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
  const sendTargetBranch = (ints: Integration[], targetField: 'toAgent' | 'toUser' | 'sessionId') =>
    sendSchema(ints).oneOf!.find((branch) => branch.required?.includes(targetField))!
  // The unified sendMessage tool's platform enum belongs only to the toUser-mode branch.
  const sendPlatformEnum = (ints: Integration[]) => {
    return sendTargetBranch(ints, 'toUser').properties.platform!.enum
  }

  it('injects the Slack read tools + the unified send tool for a Slack integration', () => {
    const names = toolsForIntegrations([slackInt]).map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'sendMessage',
        'getCurrentChannel',
        'listChannelMembers',
        'listChannels',
        'getUserProfile',
        'readSlackFile'
      ])
    )
    // The send tool's platform enum is narrowed to what the agent actually has.
    expect(sendPlatformEnum([slackInt])).toEqual(['slack'])
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
    expect(sendPlatformEnum([telegramInt])).toEqual(['telegram'])
  })

  it('narrows the read tools’ platform enum to the agent’s platforms and routes cross-platform', () => {
    const readTool = (ints: Integration[], name: string) => toolsForIntegrations(ints).find((t) => t.name === name)!
    const enumOf = (t: { inputSchema: Record<string, unknown> }) =>
      (t.inputSchema.properties as Record<string, { enum: string[] }>).platform.enum
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
    expect(fileTools([slackInt, telegramInt])).toEqual(['readSlackFile', 'readTelegramFile'])
    // Registry order, not integration order — a stored-the-other-way-round agent
    // must not see its tool list reshuffle.
    expect(fileTools([telegramInt, slackInt])).toEqual(['readSlackFile', 'readTelegramFile'])
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

  it('exposes NO `thread` property in any send branch, on any integration set', () => {
    // send-message-routing-rework.md §2.2 / §10 case 1. This is the schema-level statement
    // of "there is no visible in-thread form": speaking in the current thread is the
    // ordinary turn reply's job (§2.1), and a second delivery path into the same thread
    // would compete with it. Asserted across integration sets because the branch union is
    // built per-agent — a `thread` reappearing on only the Telegram shape would be just as
    // wrong and much easier to miss.
    for (const ints of [[slackInt], [telegramInt], [slackInt, telegramInt]]) {
      for (const branch of sendSchema(ints).oneOf!) {
        expect(Object.keys(branch.properties)).not.toContain('thread')
      }
    }
  })

  it('descriptor shape: the unified send tool requires one strict, non-overlapping target branch', () => {
    const tool = sendTool([slackInt])!
    expect(tool.name).toBe('sendMessage')
    const schema = sendSchema([slackInt])
    expect(schema.type).toBe('object')
    expect(schema.oneOf).toHaveLength(4)

    const agent = sendTargetBranch([slackInt], 'toAgent')
    expect(agent.required).toEqual(['toAgent', 'message'])
    expect(agent.additionalProperties).toBe(false)
    expect(Object.keys(agent.properties)).toEqual(['toAgent', 'channel', 'message'])
    expect(agent.description).toContain('direct')
    expect(agent.description).toContain('channel root')

    const user = sendTargetBranch([slackInt], 'toUser')
    expect(user.required).toEqual(['toUser', 'message'])
    expect(user.additionalProperties).toBe(false)
    expect(Object.keys(user.properties)).toEqual(['toUser', 'channel', 'platform', 'integrationId', 'message'])
    expect(user.description).toContain('dm')
    expect(user.description).toContain('channel-root')
    expect(user.properties.toUser!.oneOf).toMatchObject([
      { type: 'string', minLength: 1 },
      { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } }
    ])

    const channel = sendTargetBranch([slackInt], 'channel')
    expect(channel.required).toEqual(['channel', 'message'])
    expect(channel.additionalProperties).toBe(false)
    expect(Object.keys(channel.properties)).toEqual(['channel', 'platform', 'integrationId', 'message'])
    expect(channel.description).toContain('without waking an agent or @-mentioning a human')

    const session = sendTargetBranch([slackInt], 'sessionId')
    expect(session.required).toEqual(['sessionId', 'message'])
    expect(session.additionalProperties).toBe(false)
    expect(Object.keys(session.properties)).toEqual(['sessionId', 'correlationId', 'message'])

    expect(tool.description).toMatch(/^Send one message using exactly one target mode:/)
    expect(tool.description).toContain('{"toAgent":"<agent id>","message":"..."}')
    expect(tool.description).toContain('{"toAgent":"<agent id>","channel":"<channel id>","message":"..."}')
    expect(tool.description).toContain('{"toUser":"<Slack user id>","message":"..."}')
    expect(tool.description).toContain(
      '{"toUser":["<user id 1>","<user id 2>"],"channel":"<channel id>","message":"..."}'
    )
    expect(tool.description).toContain('{"channel":"<channel id>","message":"..."}')
    expect(tool.description).toContain('{"sessionId":"<Parent session>","message":"..."}')
  })

  it('states what a channel-root post costs, and points a relayed answer at the parent session', () => {
    // A coordinate-only description leaves the three branches reading as equivalent ways to
    // "send somewhere", so an agent asked to relay an answer back to a customer picks the
    // channel it can see and posts at its root — a top-level message plus a NEW session,
    // instead of a reply in the conversation that asked. The consequence has to be ON the
    // branch that carries it, and the tool has to say the turn's own reply already lands here.
    const description = sendTool([slackInt])!.description
    // §2.1 is now the FIRST thing the tool says: to speak where you already are — including
    // to address a peer or a human there — write your ordinary reply and @-mention them.
    expect(description).toContain('CONVERSATION YOU ARE ALREADY IN')
    expect(description).toContain('ordinary turn reply')
    expect(description).toContain('@-mention')
    expect(description).toContain('opens a NEW conversation')
    expect(description).toContain('never by posting it at their channel root')
    expect(sendTargetBranch([slackInt], 'sessionId').description).toContain(
      'channel ROOT instead would start a new one'
    )

    // Every visible send is a ROOT post now (§2.2), so both the tool and the channel branch
    // have to say so — there is no longer an in-thread form that avoids the cost.
    for (const text of [description, sendTargetBranch([slackInt], 'channel').description!])
      expect(text).toMatch(/(at )?channel.{0,3}s? root/i)

    // …and the toUser mode is not DM-only: its channel-root form posts visible @-mentions,
    // which is a legitimate reason to send into a conversation the agent is not in.
    expect(description).toContain('@-mentions every listed user')
    expect(sendTargetBranch([slackInt], 'toUser').description).toContain('@-mentions every listed user')

    // Collaboration off leaves only the visible platform targets, so the channel-root cost must
    // still be stated there (spawnChannelRootSession runs either way).
    const soloDescription = toolsForIntegrations([slackInt], { collaboration: false }).find(
      (t) => t.name === 'sendMessage'
    )!.description
    expect(soloDescription).toContain('opens a NEW conversation')
    expect(soloDescription).toContain('ordinary turn reply')
    expect(soloDescription).toContain('{"toUser":"<Slack user id>","message":"..."}')
  })

  it('`toAgent` accepts the bare agent id OR an {agentId, needsReply} object', () => {
    const branches = (sendTargetBranch([slackInt], 'toAgent').properties.toAgent as { oneOf: unknown[] }).oneOf as {
      type?: string
      properties?: Record<string, unknown>
      required?: string[]
      additionalProperties?: boolean
    }[]
    // The bare-string form stays FIRST: it is what every warm session's descriptor and every
    // published example teaches, and the object form only layers delivery options onto it.
    expect(branches).toHaveLength(2)
    expect(branches[0]!.type).toBe('string')
    expect(Object.keys(branches[1]!.properties!)).toEqual(['agentId', 'needsReply'])
    expect(branches[1]!.required).toEqual(['agentId'])
    expect(branches[1]!.additionalProperties).toBe(false)
  })

  it('still injects the unified send tool for an agent with no integrations, but no platform read tools', () => {
    // The unified sendMessage tool is ALWAYS present (a memory-only agent can wake a peer /
    // reply to its origin) — but the platform read helpers only appear with ≥1 integration.
    const names = toolsForIntegrations([]).map((t) => t.name)
    expect(names).toContain('sendMessage')
    expect(names).not.toContain('getCurrentChannel')
    expect(names).not.toContain('listChannels')
    // With no platform, the toUser branch still describes the shape but has no selectable platform enum.
    expect(sendTargetBranch([], 'toUser').properties.platform).not.toHaveProperty('enum')
  })

  it('injects the universal memory + collaboration + send tools for every agent, even with no integrations', () => {
    const tools = toolsForIntegrations([])
    // Universal, platform-independent; no Slack/Telegram read tools. `sendMessage` is
    // always present (session-concept §3); `messageAgent` is gone (merged into it).
    expect(tools.map((t) => t.name)).toEqual([
      'readMemory',
      'writeMemory',
      'listAgents',
      // still offered under the old name, for sessions already warm with it
      'listChannelAgents',
      'viewSessionStatus',
      'startOrchestration',
      'getOrchestration',
      'cancelOrchestration',
      'sendMessage'
    ])
  })

  it('removes peer/orchestration targets for a collaboration-off treatment while preserving platform sends', () => {
    expect(toolsForIntegrations([], { collaboration: false }).map((tool) => tool.name)).toEqual([
      'readMemory',
      'writeMemory'
    ])

    const tools = toolsForIntegrations([slackInt], { collaboration: false })
    const names = tools.map((tool) => tool.name)
    expect(names).not.toEqual(
      expect.arrayContaining(['listAgents', 'listChannelAgents', 'startOrchestration', 'getOrchestration'])
    )
    expect(names).toContain('sendMessage')
    const send = tools.find((tool) => tool.name === 'sendMessage')!
    const schema = send.inputSchema as unknown as ObjectSchema
    expect(schema.oneOf).toHaveLength(2)
    expect(schema.oneOf?.[0]?.required).toEqual(['toUser', 'message'])
    expect(schema.oneOf?.[1]?.required).toEqual(['channel', 'message'])
    expect(send.description).toContain('Peer-agent and parent-session delivery are disabled')
  })

  it('injects the session-title fallback only when the runtime is explicitly whitelisted', () => {
    expect(toolsForIntegrations([]).map((t) => t.name)).not.toContain('setSessionTitle')
    expect(toolsForIntegrations([], { sessionTitle: true }).map((t) => t.name)).toContain('setSessionTitle')
  })

  it('every injected tool exposes a JSON-Schema object input + a description', () => {
    for (const t of toolsForIntegrations([slackInt, telegramInt], { sessionTitle: true })) {
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

  it('ALL_TOOL_NAMES lists every injectable tool exactly once', () => {
    expect(new Set(ALL_TOOL_NAMES).size).toBe(ALL_TOOL_NAMES.length)
    expect(ALL_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        'setSessionTitle',
        'sendMessage',
        'listChannels',
        'readTelegramFile',
        'searchMemory',
        'saveMemory',
        'getMemory',
        'updateMemory',
        'deleteMemory',
        'submitGithubReview'
      ])
    )
    // The merged-away tool names are gone.
    expect(ALL_TOOL_NAMES).not.toContain('sendPlatformMessage')
    expect(ALL_TOOL_NAMES).not.toContain('messageAgent')
  })

  it('projects only reviewed external-memory capabilities onto stable core tool names', () => {
    expect(externalMemoryTools(new Set(['recall', 'capture', 'get', 'delete'])).map((tool) => tool.name)).toEqual([
      'searchMemory',
      'getMemory',
      'deleteMemory'
    ])
    for (const tool of externalMemoryTools(new Set(['recall', 'create', 'get', 'update', 'delete']))) {
      expect(tool.name).not.toMatch(/^agentconnect_memory_/)
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
    }
  })

  it('formal review descriptor has no model-selectable GitHub target', () => {
    const tool = GITHUB_REVIEW_TOOLS[0]!
    expect(tool.name).toBe('submitGithubReview')
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>
    expect(Object.keys(properties)).toEqual(['event', 'verdict', 'body', 'comments'])
    expect(properties).not.toHaveProperty('repoFullName')
    expect(properties).not.toHaveProperty('pullNumber')
    expect(properties).not.toHaveProperty('commitId')
    expect(properties.body).toMatchObject({ minLength: 1 })
    expect(tool.description).toContain('only a definite not_submitted result preserves')
  })
})
