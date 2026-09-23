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

// Permission-mode choices as the run-settings menus take them, with the console's localized labels.
export function localizedPermissionChoices(
  choices: readonly { v: string; l: string; description?: string }[],
  translate: (key: PermissionModeLabelKey) => string
): { value: string; label: string; description?: string }[] {
  return choices.map((choice) => {
    const key = permissionModeLabelKey(choice.v)
    return {
      value: choice.v,
      label: key ? translate(key) : choice.l,
      ...(choice.description ? { description: choice.description } : {})
    }
  })
}
