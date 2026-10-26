// What a capability request asks for and whether it holds, worded by the Control Plane from `want` and current rows (capability-requests.md §4.6).
import {
  ASSISTANT_MODE_PERMISSION_MODES,
  type CapabilityAsk,
  type CapabilitySettingsWant
} from '@agentconnect.md/protocol'
import type { AgentRecord } from '../persistence/ports.js'

/** The agent fields a predicate reads. */
export type CapabilityAgentView = Pick<
  AgentRecord,
  'model' | 'reasoningEffort' | 'fastMode' | 'outputMode' | 'permissionMode' | 'mcpServers' | 'skills' | 'runtime'
>

type SettingsField = keyof CapabilitySettingsWant

const SETTINGS_ORDER: readonly SettingsField[] = [
  'model',
  'reasoningEffort',
  'fastMode',
  'outputMode',
  'permissionMode'
]

const SETTING_LABEL: Record<SettingsField, string> = {
  model: 'the model',
  reasoningEffort: 'reasoning effort',
  fastMode: 'fast mode',
  outputMode: 'the output mode',
  permissionMode: 'the permission mode'
}

const quote = (value: string): string => JSON.stringify(value)

function settingsFields(want: CapabilitySettingsWant): SettingsField[] {
  return SETTINGS_ORDER.filter((field) => want[field] !== undefined)
}

function settingValue(field: SettingsField, value: unknown): string {
  if (field === 'fastMode') return value === true ? 'on' : value === false ? 'off' : 'the runtime default'
  return value === null || value === undefined ? 'the runtime default' : quote(String(value))
}

function asked(field: SettingsField, want: CapabilitySettingsWant): string {
  if (field === 'fastMode') return `turn fast mode ${want.fastMode ? 'on' : 'off'}`
  return `set ${SETTING_LABEL[field]} to ${settingValue(field, want[field])}`
}

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases.join('')
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`
}

/** The skill source a `<source>/<skill>` reference names: everything before its last segment. */
export function skillSourceOf(skill: string): string {
  return skill.slice(0, skill.lastIndexOf('/'))
}

/** What was asked, as the card, the page and the reminder name it. */
export function capabilitySummary(ask: CapabilityAsk): string {
  switch (ask.kind) {
    case 'agent-settings':
      return joinPhrases(settingsFields(ask.want).map((field) => asked(field, ask.want)))
    case 'mcp-server':
      return `add the MCP server ${quote(ask.want.server)}`
    case 'skill':
      return `install the skill ${quote(ask.want.skill)}`
  }
}

function skillInstalled(agent: CapabilityAgentView, skill: string): boolean {
  return agent.skills.includes(skill) || agent.skills.includes(`${skillSourceOf(skill)}/*`)
}

/** Whether the state asked for holds, the change as observed, and the current values the page diffs against. */
export function evaluateCapability(
  ask: CapabilityAsk,
  agent: CapabilityAgentView
): { satisfied: boolean; outcome: string; current: Record<string, unknown> } {
  switch (ask.kind) {
    case 'agent-settings': {
      const fields = settingsFields(ask.want)
      const current = Object.fromEntries(fields.map((field) => [field, agent[field] ?? null]))
      const satisfied = fields.every((field) => agent[field] === ask.want[field])
      const phrases = fields.map((field) => {
        const now = `${SETTING_LABEL[field]} is ${settingValue(field, agent[field])}`
        return agent[field] === ask.want[field] ? now : `${now} (you asked for ${settingValue(field, ask.want[field])})`
      })
      const sentence = joinPhrases(phrases)
      return { satisfied, outcome: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`, current }
    }
    case 'mcp-server': {
      const attached = agent.mcpServers.includes(ask.want.server)
      return {
        satisfied: attached,
        outcome: attached
          ? `MCP server ${quote(ask.want.server)} was added to this agent. Its tools are available from this turn.`
          : `MCP server ${quote(ask.want.server)} was not added to this agent.`,
        current: { attached }
      }
    }
    case 'skill': {
      const installed = skillInstalled(agent, ask.want.skill)
      return {
        satisfied: installed,
        outcome: installed
          ? `Skill ${quote(ask.want.skill)} was installed on this agent.`
          : `Skill ${quote(ask.want.skill)} was not installed on this agent.`,
        current: { installed }
      }
    }
  }
}

/** Warning lines for a change that raises what the agent can do on its own (§4.5). */
export function capabilityWarnings(ask: CapabilityAsk, agent: Pick<AgentRecord, 'runtime'>): string[] {
  if (ask.kind !== 'agent-settings' || ask.want.permissionMode === undefined) return []
  const modes = agent.runtime ? ASSISTANT_MODE_PERMISSION_MODES[agent.runtime] : undefined
  const kind =
    modes && Object.prototype.hasOwnProperty.call(modes, ask.want.permissionMode)
      ? modes[ask.want.permissionMode]
      : undefined
  if (kind === 'full-access')
    return ['This permission mode never asks before the agent acts: it gets full access to its tools and workspace.']
  if (kind === 'auto') return ['In this permission mode the runtime decides on its own which actions to allow.']
  return []
}
