import {
  assistantModeDefinitionRefusals,
  type AgentMemoryBinding,
  type AssistantModeAdmission,
  type AssistantModePolicy,
  type AssistantModeRefusal
} from '@agentconnect.md/protocol'
import type { AgentRecord, MemberSetRepo } from '../persistence/ports.js'

/** The 409 `code` of an edit refused by assistant mode admission. */
export const ASSISTANT_MODE_NOT_ADMITTED = 'ASSISTANT_MODE_NOT_ADMITTED'

const REFUSAL_MESSAGES: Record<AssistantModeRefusal, string> = {
  'runtime-unset': 'the agent has no runtime yet',
  'runtime-not-admitted':
    'the runtime is not on the assistant mode admission list (its native memory must be able to turn off and its sessions must resume by id after a restart)',
  'memory-provider': 'memory must be managed or off',
  'store-not-shared': 'every member of the agent’s daemon group must share one store'
}

/** One sentence naming every refusal, for the API message. */
export function assistantModeRefusalMessage(refusals: readonly AssistantModeRefusal[]): string {
  return `assistant mode cannot be turned on: ${refusals.map((r) => REFUSAL_MESSAGES[r]).join('; ')}`
}

/** Thrown inside the row-locked agent write when the committed definition fails admission. */
export class AssistantModeAdmissionRefused extends Error {
  constructor(readonly refusals: AssistantModeRefusal[]) {
    super(assistantModeRefusalMessage(refusals))
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

/** The definition checks, as the row-locked write runs them. */
export function assertAssistantModeDefinition(agent: {
  runtime: string | null | undefined
  memory: AgentMemoryBinding | null | undefined
}): void {
  const refusals = assistantModeDefinitionRefusals(agent)
  if (refusals.length > 0) throw new AssistantModeAdmissionRefused(refusals)
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
