// The refusal every Azure DevOps seam member answers until its step lands (azure-devops-integration.md §13).
export const CODE_HOST_NOT_IMPLEMENTED = 'code_host_not_implemented' as const

/** Refuse one member by name, so a log says which slice is missing rather than "undefined". */
export function azureDevOpsNotImplemented(member: string): never {
  throw new Error(`${CODE_HOST_NOT_IMPLEMENTED}: azure-devops ${member} arrives with its own rollout step`)
}
