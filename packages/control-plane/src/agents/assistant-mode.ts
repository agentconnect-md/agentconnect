import {
  ASSISTANT_ONBOARDING_HINTS_MAX,
  AssistantModePolicy,
  assistantModeDefinitionRefusals,
  type AssistantOnboarding,
  type AssistantOnboardingHints,
  assistantModePermissionModeOnEnable,
  type AgentMemoryBinding,
  type AssistantModeAdmission,
  type AssistantModeRefusal,
  type AssistantModeRoutedConversation
} from '@agentconnect.md/protocol'
import { canEdit } from '../authorization/policy.js'
import type { AgentId, OrgId } from '../domain/ids.js'
import { isRoutedChannel } from '../orchestrator/decisionBundle.js'
import type {
  AgentRecord,
  AgentRepo,
  BotRepo,
  IntegrationChannelRepo,
  IntegrationRepo,
  MemberSetRepo,
  OrgMemberRecord,
  OrgRepo,
  UserRepo
} from '../persistence/ports.js'

// A stored row drops keys this CP does not know, so a key another CP version wrote never turns the mode off.
export const StoredAssistantModePolicyRow = AssistantModePolicy.strip()

/** The agent's responsible user (assistant-mode.md §5.1): its creator while they may edit it, else the editor who joined first. */
export function assistantResponsibleUser<M extends OrgMemberRecord>(
  agent: Pick<AgentRecord, 'createdByUserId' | 'visibility' | 'sharedWith'>,
  members: readonly M[]
): M | undefined {
  const editors = members.filter((m) => canEdit(agent, m))
  const creator = editors.find((m) => m.userId === agent.createdByUserId)
  if (creator) return creator
  // Membership order, then user id: the same member every time, whatever order the list arrived in.
  return [...editors].sort(
    (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
  )[0]
}

/** The 409 `code` of an edit refused by assistant mode admission. */
export const ASSISTANT_MODE_NOT_ADMITTED = 'ASSISTANT_MODE_NOT_ADMITTED'

const REFUSAL_MESSAGES: Record<AssistantModeRefusal, string> = {
  'runtime-unset': 'the agent has no runtime yet',
  'runtime-not-admitted':
    'the runtime is not on the assistant mode admission list (its native memory must be able to turn off and its sessions must resume by id after a restart)',
  'memory-provider': 'memory must be managed',
  'store-not-shared': 'every member of the agent’s daemon group must share one store',
  routing: 'no conversation may be By decision or in a shared bot’s routing'
}

/** One sentence naming every refusal, for the API message; an edit to an agent already in the mode is told to turn it off first. */
export function assistantModeRefusalMessage(
  refusals: readonly AssistantModeRefusal[],
  alreadyOn = false,
  conversations: readonly AssistantModeRoutedConversation[] = []
): string {
  const named = conversations.map((c) => c.name ?? c.channelId).join(', ')
  const reasons = refusals
    .map((r) => (r === 'routing' && named ? `${REFUSAL_MESSAGES[r]} (change ${named} first)` : REFUSAL_MESSAGES[r]))
    .join('; ')
  return alreadyOn
    ? `assistant mode is on, so this edit is refused: ${reasons}; turn assistant mode off first`
    : `assistant mode cannot be turned on: ${reasons}`
}

/** Thrown inside the row-locked agent write when the committed definition fails admission. */
export class AssistantModeAdmissionRefused extends Error {
  constructor(
    readonly refusals: AssistantModeRefusal[],
    alreadyOn = false
  ) {
    super(assistantModeRefusalMessage(refusals, alreadyOn))
    this.name = 'AssistantModeAdmissionRefused'
  }
}

/** An edit is checked when it turns assistant mode on, or changes what admission reads while it is on. */
export function assistantModeEditNeedsAdmission(
  before: AssistantModePolicy | null | undefined,
  after: AssistantModePolicy | null | undefined,
  changesDefinition: boolean
): boolean {
  return after?.enabled === true && (before?.enabled !== true || changesDefinition)
}

/** The permission mode an edit sets as it turns assistant mode on (§1.8); undefined keeps the mode, as does an edit that sets one itself. */
export function assistantModePermissionModeForEdit(
  before: AssistantModePolicy | null | undefined,
  after: AssistantModePolicy | null | undefined,
  agent: { runtime: string | null | undefined; permissionMode: string | null | undefined },
  editSetsPermissionMode: boolean
): string | undefined {
  if (before?.enabled === true || after?.enabled !== true || editSetsPermissionMode) return undefined
  return assistantModePermissionModeOnEnable(agent.runtime, agent.permissionMode)
}

/** The onboarding record an edit writes (assistant-mode.md §5.15): only the first switch-on of an agent with none, never again. */
export function assistantOnboardingForEdit(
  before: AssistantModePolicy | null | undefined,
  after: AssistantModePolicy | null | undefined,
  recorded: boolean,
  edit: { userId?: string | undefined; hints?: AssistantOnboardingHints | undefined; now: Date }
): AssistantOnboarding | undefined {
  if (recorded || before?.enabled === true || after?.enabled !== true) return undefined
  const hints = edit.hints && Object.keys(edit.hints).length > 0 ? edit.hints : undefined
  return {
    ...(edit.userId ? { enabledByUserId: edit.userId } : {}),
    enabledAt: edit.now.toISOString(),
    ...(hints ? { hints } : {})
  }
}

// Mail providers anyone may sign up with: such a domain names no organization, so research never searches by one.
const PUBLIC_MAIL_DOMAINS = new Set([
  '126.com',
  '139.com',
  '163.com',
  'aol.com',
  'fastmail.com',
  'foxmail.com',
  'gmail.com',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'googlemail.com',
  'hey.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'mac.com',
  'mail.com',
  'mail.ru',
  'me.com',
  'msn.com',
  'naver.com',
  'outlook.com',
  'pm.me',
  'proton.me',
  'protonmail.com',
  'qq.com',
  'sina.com',
  'sohu.com',
  'tutanota.com',
  'web.de',
  'yahoo.co.jp',
  'yahoo.com',
  'yandex.com',
  'yandex.ru',
  'zoho.com'
])

/** The email domains the organization's members use, most used first: never an address, never a public provider's. */
export function memberEmailDomains(emails: readonly (string | null)[]): string[] {
  const counts = new Map<string, number>()
  for (const email of emails) {
    const domain = email?.split('@')[1]?.trim().toLowerCase()
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || isPublicMailDomain(domain)) continue
    counts.set(domain, (counts.get(domain) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, ASSISTANT_ONBOARDING_HINTS_MAX)
    .map(([domain]) => domain)
}

/** A public provider's domain, or a regional or subdomain variant of one (`yahoo.co.uk`, `mail.yahoo.com`). */
function isPublicMailDomain(domain: string): boolean {
  if (PUBLIC_MAIL_DOMAINS.has(domain)) return true
  const parts = domain.split('.')
  for (let i = 1; i < parts.length - 1; i++) if (PUBLIC_MAIL_DOMAINS.has(parts.slice(i).join('.'))) return true
  return /^(gmail|googlemail|hotmail|outlook|live|yahoo|yandex|gmx|icloud)\./.test(domain)
}

/** The research hints an onboarding records: the organization's and its chat workspaces' names and its members' email domains. */
export function assistantOnboardingHints(input: {
  organization: string | null | undefined
  workspaces: readonly (string | null | undefined)[]
  memberEmails: readonly (string | null)[]
}): AssistantOnboardingHints {
  const organization = input.organization?.trim().slice(0, 200)
  const workspaces = [
    ...new Set(input.workspaces.map((name) => name?.trim().slice(0, 200)).filter((name): name is string => !!name))
  ].slice(0, ASSISTANT_ONBOARDING_HINTS_MAX)
  const emailDomains = memberEmailDomains(input.memberEmails)
  return {
    ...(organization ? { organization } : {}),
    ...(workspaces.length > 0 ? { workspaces } : {}),
    ...(emailDomains.length > 0 ? { emailDomains } : {})
  }
}

/** The hints read for an agent's first switch-on: its organization's name as the editor's membership shows it, its bots' workspaces, and the members' emails. */
export async function onboardingHintsFor(
  deps: {
    repos: {
      org: Pick<OrgRepo, 'listForUser'>
      integration: Pick<IntegrationRepo, 'listForAgent'>
      bot: Pick<BotRepo, 'get'>
      user: Pick<UserRepo, 'listMembers'>
    }
  },
  agent: Pick<AgentRecord, 'id' | 'orgId'>,
  editorUserId: string | undefined
): Promise<AssistantOnboardingHints> {
  const { repos } = deps
  const org = editorUserId
    ? (await repos.org.listForUser(editorUserId)).find((candidate) => candidate.id === agent.orgId)
    : undefined
  const integrations = await repos.integration.listForAgent(agent.id)
  const bots = await Promise.all(integrations.map((integration) => repos.bot.get(agent.orgId, integration.botId)))
  const members = await repos.user.listMembers(agent.orgId)
  return assistantOnboardingHints({
    organization: org?.name ?? org?.slug,
    workspaces: bots.map((bot) => bot?.workspaceName),
    memberEmails: members.map((member) => member.email)
  })
}

/** The definition checks, as the row-locked write runs them. */
export function assertAssistantModeDefinition(
  agent: { runtime: string | null | undefined; memory: AgentMemoryBinding | null | undefined },
  alreadyOn = false
): void {
  const refusals = assistantModeDefinitionRefusals(agent)
  if (refusals.length > 0) throw new AssistantModeAdmissionRefused(refusals, alreadyOn)
}

/** The self-hosted group check (assistant-mode.md §4.1): every member reports the same shared store. */
export async function assistantModeStoreRefusals(
  memberSets: Pick<MemberSetRepo, 'get' | 'memberContentStoresOf'>,
  agent: Pick<AgentRecord, 'placementKind' | 'setId'>
): Promise<AssistantModeRefusal[]> {
  if (agent.placementKind !== 'set' || !agent.setId) return []
  const set = await memberSets.get(agent.setId)
  // The org-less pool's members all run on the one data-plane store.
  if (!set || set.orgId === null) return []
  const stores = await memberSets.memberContentStoresOf(set.id)
  const first = stores[0]
  const shared = stores.length === 0 || (first !== null && first !== undefined && stores.every((s) => s === first))
  return shared ? [] : ['store-not-shared']
}

/** The routing check (assistant-mode.md §4.1): the agent's By decision conversations, and its bots' routed ones it may be routed into. */
export async function assistantModeRoutedConversations(
  repos: {
    integration: Pick<IntegrationRepo, 'listForAgent'>
    integrationChannel: Pick<IntegrationChannelRepo, 'listForBot'>
  },
  agentId: AgentId
): Promise<AssistantModeRoutedConversation[]> {
  const found = new Map<string, AssistantModeRoutedConversation>()
  for (const integration of await repos.integration.listForAgent(agentId)) {
    for (const row of await repos.integrationChannel.listForBot(integration.botId)) {
      if (row.trigger !== 'decision' || (row.integrationId !== integration.id && !isRoutedChannel(row))) continue
      const key = `${integration.id}:${row.channelId}`
      const seen = found.get(key)
      if (!seen || (seen.name === null && row.name !== null))
        found.set(key, { integrationId: integration.id, channelId: row.channelId, name: row.name })
    }
  }
  return [...found.values()]
}

/** Whether any of a conversation's agents is in assistant mode, which keeps the conversation off By decision (§5.18 ①). */
export async function anyAssistantModeAgent(
  agents: Pick<AgentRepo, 'get'>,
  orgId: OrgId,
  agentIds: Iterable<AgentId>
): Promise<boolean> {
  for (const id of new Set(agentIds)) if ((await agents.get(orgId, id))?.assistantMode?.enabled === true) return true
  return false
}

/** Every admission check for an agent as it stands; `routing: false` skips the check an agent already on is exempt from. */
export async function assistantModeAdmissionOf(
  repos: {
    memberSet: Pick<MemberSetRepo, 'get' | 'memberContentStoresOf'>
    integration: Pick<IntegrationRepo, 'listForAgent'>
    integrationChannel: Pick<IntegrationChannelRepo, 'listForBot'>
  },
  agent: Pick<AgentRecord, 'id' | 'runtime' | 'memory' | 'placementKind' | 'setId'>,
  opts: { routing?: boolean } = {}
): Promise<AssistantModeAdmission> {
  const refusals = [
    ...assistantModeDefinitionRefusals(agent),
    ...(await assistantModeStoreRefusals(repos.memberSet, agent))
  ]
  const conversations = opts.routing === false ? [] : await assistantModeRoutedConversations(repos, agent.id)
  if (conversations.length > 0) refusals.push('routing')
  return { admitted: refusals.length === 0, refusals, ...(conversations.length > 0 ? { conversations } : {}) }
}
