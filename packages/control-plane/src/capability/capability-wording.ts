// What a capability request asks for and whether it holds, worded by the Control Plane from `want` and current rows (capability-requests.md §4.6).
import {
  ASSISTANT_MODE_PERMISSION_MODES,
  type CapabilityAsk,
  type CapabilitySettingsWant
} from '@agentconnect.md/protocol'
import type { AgentRecord } from '../persistence/ports.js'

/** What the Phase 2 kinds are judged by, read from rows outside the agent; absent ⇒ not known, which never satisfies. */
export interface CapabilityFacts {
  repository?: {
    authorized: 'none' | 'read' | 'write'
    repoId: string | null
    installationId: string | null
    // The covering grant is an installation's, which reaches every repository it covers.
    installationWide: boolean
  }
  mcpProvider?: { providerId: string | null; connected: boolean; headerPresent: boolean }
  codeHostConnected?: boolean
  integrationConnected?: boolean
}

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
    case 'repository':
      return `grant ${ask.want.access} access to the ${hostLabel(ask.want.provider, ask.want.host)} repository ${quote(ask.want.repository)}`
    case 'connection': {
      const want = ask.want
      if (want.type === 'mcp-oauth') return `connect the MCP server ${quote(want.server)}`
      if (want.type === 'code-host') return `connect ${hostLabel(want.provider, want.host)} to the organization`
      return `connect a ${quote(want.platform)} chat integration to this agent`
    }
    case 'secret':
      return ask.want.use.route === 'mcp-header'
        ? `set the header ${quote(ask.want.name)} of the MCP server ${quote(ask.want.use.server)}`
        : `set the secret ${quote(ask.want.name)}`
  }
}

/** A code host as people name it: GitHub, GitLab, or a self-managed GitLab by its host. */
function hostLabel(provider: 'github' | 'gitlab', host: string | undefined): string {
  if (provider === 'github') return 'GitHub'
  return host && host !== 'gitlab.com' ? `GitLab (${host})` : 'GitLab'
}

function skillInstalled(agent: CapabilityAgentView, skill: string): boolean {
  return agent.skills.includes(skill) || agent.skills.includes(`${skillSourceOf(skill)}/*`)
}

/** Whether the state asked for holds, the change as observed, and the current values the page diffs against. */
export function evaluateCapability(
  ask: CapabilityAsk,
  agent: CapabilityAgentView,
  facts: CapabilityFacts = {}
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
    case 'repository': {
      const repo = facts.repository ?? {
        authorized: 'none',
        repoId: null,
        installationId: null,
        installationWide: false
      }
      const satisfied = repo.authorized === 'write' || (repo.authorized === 'read' && ask.want.access === 'read')
      const name = `${hostLabel(ask.want.provider, ask.want.host)} repository ${quote(ask.want.repository)}`
      const tier = (access: 'read' | 'write') => (access === 'write' ? 'read and write' : 'read')
      return {
        satisfied,
        outcome: satisfied
          ? `The agent can now ${tier(ask.want.access)} the ${name}. Sessions see it from their next turn.`
          : repo.authorized === 'none'
            ? `The agent still has no access to the ${name}.`
            : `The agent can ${tier(repo.authorized)} the ${name} (you asked for ${ask.want.access} access).`,
        current: { authorized: repo.authorized, repoId: repo.repoId, installationId: repo.installationId }
      }
    }
    case 'connection': {
      const want = ask.want
      if (want.type === 'mcp-oauth') {
        const connected = facts.mcpProvider?.connected === true
        return {
          satisfied: connected,
          outcome: connected
            ? `MCP server ${quote(want.server)} is connected. Its tools are available from this turn.`
            : `MCP server ${quote(want.server)} is still not connected.`,
          current: { providerId: facts.mcpProvider?.providerId ?? null, connected }
        }
      }
      if (want.type === 'code-host') {
        const connected = facts.codeHostConnected === true
        const label = hostLabel(want.provider, want.host)
        return {
          satisfied: connected,
          outcome: connected
            ? `${label} is connected to the organization.`
            : `${label} is still not connected to the organization.`,
          current: { connected }
        }
      }
      const connected = facts.integrationConnected === true
      return {
        satisfied: connected,
        outcome: connected
          ? `This agent now has a ${quote(want.platform)} chat integration.`
          : `This agent still has no ${quote(want.platform)} chat integration.`,
        current: { connected }
      }
    }
    case 'secret': {
      // Existence only: no value is ever read into an outcome, a wake or a page.
      const use = ask.want.use
      if (use.route !== 'mcp-header') {
        return {
          satisfied: false,
          outcome: `Secret ${quote(ask.want.name)} cannot be set this way yet.`,
          current: { present: false }
        }
      }
      const present = facts.mcpProvider?.headerPresent === true
      return {
        satisfied: present,
        outcome: present
          ? `Header ${quote(ask.want.name)} of MCP server ${quote(use.server)} is set. The server's tools send it; you never see its value.`
          : `Header ${quote(ask.want.name)} of MCP server ${quote(use.server)} is still not set.`,
        current: { providerId: facts.mcpProvider?.providerId ?? null, present }
      }
    }
  }
}

/** Warning lines for a change that raises what the agent can do on its own (§4.5). */
export function capabilityWarnings(
  ask: CapabilityAsk,
  agent: Pick<AgentRecord, 'runtime'>,
  facts: CapabilityFacts = {}
): string[] {
  if (ask.kind === 'repository') {
    const lines: string[] = []
    if (ask.want.access === 'write')
      lines.push('Write access lets the agent push branches and open or change pull requests in this repository.')
    if (facts.repository?.installationWide)
      lines.push(
        'The access this agent has here comes from an installation-wide grant, which reaches every repository it covers.'
      )
    return lines
  }
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
