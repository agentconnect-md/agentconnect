export type PermissionModeLabelKey =
  'askForApproval' | 'approveForMe' | 'fullAccess' | 'manual' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'

export function permissionModeLabelKey(mode: string): PermissionModeLabelKey | null {
  switch (mode) {
    case 'read-only':
      return 'askForApproval'
    case 'agent':
      return 'approveForMe'
    case 'agent-full-access':
      return 'fullAccess'
    case 'default':
      return 'manual'
    case 'acceptEdits':
      return 'acceptEdits'
    case 'plan':
      return 'plan'
    case 'auto':
      return 'auto'
    case 'bypassPermissions':
      return 'bypassPermissions'
    default:
      return null
  }
}
