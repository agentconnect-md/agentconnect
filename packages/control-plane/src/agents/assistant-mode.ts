import { z } from 'zod'
import {
  AssistantModePolicy,
  assistantModeDefinitionRefusals,
  assistantModePermissionModeOnEnable,
  type AgentMemoryBinding,
  type AssistantModeAdmission,
  type AssistantModeRefusal
} from '@agentconnect.md/protocol'
import { canEdit } from '../authorization/policy.js'
import type { AgentRecord, MemberSetRepo, OrgMemberRecord, StoredAssistantModePolicy } from '../persistence/ports.js'

// Expand step (assistant-mode.md §5.1): an older CP's routing keys are read past and never written; removed keys are dropped.
export const StoredAssistantModePolicyRow = AssistantModePolicy.extend({
  responsibleUserId: z.unknown().optional(),
  fallbackConversation: z.unknown().optional()
}).strip()

/** The stored policy as the API serves it, without the routing keys an older CP wrote. */
export function servedAssistantMode(policy: StoredAssistantModePolicy): AssistantModePolicy {
  const { responsibleUserId: _r, fallbackConversation: _f, ...served } = policy
  return served
}

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
  'store-not-shared': 'every member of the agent’s daemon group must share one store'
}

/** One sentence naming every refusal, for the API message; an edit to an agent already in the mode is told to turn it off first. */
export function assistantModeRefusalMessage(refusals: readonly AssistantModeRefusal[], alreadyOn = false): string {
  const reasons = refusals.map((r) => REFUSAL_MESSAGES[r]).join('; ')
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

/** Every admission check for an agent as it stands. */
export async function assistantModeAdmissionOf(
  memberSets: Pick<MemberSetRepo, 'get' | 'memberContentStoresOf'>,
  agent: Pick<AgentRecord, 'runtime' | 'memory' | 'placementKind' | 'setId'>
): Promise<AssistantModeAdmission> {
  const refusals = [...assistantModeDefinitionRefusals(agent), ...(await assistantModeStoreRefusals(memberSets, agent))]
  return { admitted: refusals.length === 0, refusals }
}
