// Azure DevOps subscription vocabulary (azure-devops-integration.md §11.4): Gitea's family encoding, narrowed to pull requests and pushes, with no labels.

import type { AzureDevOpsCommentFamily, AzureDevOpsHookFamily, HookCommentFamily } from './api'

export type AzFamily = AzureDevOpsHookFamily
export type AzTriggerMode = 'first' | 'every' | 'mention'

export interface AzFamilyTile {
  fam: AzFamily
  pill: string
  icon: string
  label: string
}

// Every subject the wire knows; a stored push row still reads its own label from here.
const AZ_ALL_FAMILIES: AzFamilyTile[] = [
  { fam: 'merge_request', pill: 'PRs', icon: 'git-pull-request', label: 'Pull requests' },
  { fam: 'push', pill: 'Pushes', icon: 'git-commit-horizontal', label: 'Pushes' }
]

// The subjects the console offers: pushes are held back on every host, as `GT_FAMILIES` holds them back.
export const AZ_FAMILIES: AzFamilyTile[] = AZ_ALL_FAMILIES.filter((entry) => entry.fam !== 'push')

/** The display metadata for one family, including the held-back push subject. */
export function azureDevOpsFamilyTile(fam: AzFamily): AzFamilyTile | undefined {
  return AZ_ALL_FAMILIES.find((entry) => entry.fam === fam)
}

/** Reviews and the pull-request status exist only on the pull-request subject. */
export function azureDevOpsFamilyCarriesReviews(fam: AzFamily): boolean {
  return fam === 'merge_request'
}

export const AZ_TRIGGER_MODES: readonly AzTriggerMode[] = ['first', 'every', 'mention']
export const AZ_TRIGGER_LABEL: Record<AzTriggerMode, string> = {
  first: 'opened',
  every: 'any update',
  mention: '@-mention'
}
export const AZ_TRIGGER_PILL: Record<AzTriggerMode, string> = {
  first: 'create',
  every: 'update',
  mention: '@-mention'
}

/** The cadences one family offers: a push has no thread to update or mention in. */
export function azureDevOpsTriggerModes(fam: AzFamily): readonly AzTriggerMode[] {
  return fam === 'push' ? ['first'] : AZ_TRIGGER_MODES
}

/** Per-segment hover copy for the trigger bar. */
export function azureDevOpsTriggerTooltip(mode: AzTriggerMode, agentName: string, fam?: AzFamily): string {
  if (fam === 'push') return 'Runs on every push to the repository.'
  switch (mode) {
    case 'first':
      return 'Runs when a pull request is opened.'
    case 'every':
      return 'Runs when a pull request is opened, gets new commits or is reopened, when the Azure DevOps application is added as a reviewer, and on comments.'
    case 'mention':
      return `Runs when a pull request or comment mentions @${agentName} or the Azure DevOps application, and when the application is added as a reviewer.`
  }
}

/** Hover copy for the agent-targeted mention form. */
export function azureDevOpsMentionUsage(agentName: string): string {
  return `Write @${agentName} in a pull request or comment to trigger only this agent.`
}

/** The default create-form selection: pull requests only. */
export const AZ_DEFAULT_FAMILIES: readonly AzFamily[] = ['merge_request']

/** A pull request opens on every update, like the other hosts. */
export function azureDevOpsDefaultTriggerMode(fam: AzFamily): AzTriggerMode {
  return fam === 'merge_request' ? 'every' : 'first'
}

/** Narrow a stored cross-host comment scope to the one family an azure-devops hook may carry. */
export function azureDevOpsCommentFamilies(families: readonly HookCommentFamily[]): AzureDevOpsCommentFamily[] {
  return families.filter((family): family is AzureDevOpsCommentFamily => family === 'merge_request')
}

/** Whether a hook's stored events cover a family (any action pattern counts). */
export function azureDevOpsFamCovered(events: readonly string[], family: AzFamily): boolean {
  return events.some((event) => event.startsWith(`${family}:`))
}

/** The one subject family a stored row covers: its own `family`, else the first its events cover. */
export function azureDevOpsHookFamily(hook: { family: string | null; events: readonly string[] }): AzFamily | null {
  const declared = AZ_ALL_FAMILIES.find((entry) => entry.fam === hook.family)
  if (declared) return declared.fam
  return AZ_ALL_FAMILIES.find((entry) => azureDevOpsFamCovered(hook.events, entry.fam))?.fam ?? null
}

/** Recover the trigger mode: the mentionOnly flag wins, `:opened` ⇒ created. */
export function azureDevOpsTriggerModeOf(hook: { events: readonly string[]; mentionOnly: boolean }): AzTriggerMode {
  if (hook.mentionOnly) return 'mention'
  return hook.events.some((event) => event.endsWith(':opened')) ? 'first' : 'every'
}

/** The subscription block one (family, mode) row writes. */
export interface AzureDevOpsFamilySubscription {
  events: string[]
  commentFamilies: AzureDevOpsCommentFamily[]
  mentionOnly: boolean
}

/** Compile one row's family+mode into the fields its create/update body carries; a cadence a family cannot carry narrows to its opening. */
export function azureDevOpsFamilySubscription(fam: AzFamily, mode: AzTriggerMode): AzureDevOpsFamilySubscription {
  const own = azureDevOpsTriggerModes(fam).includes(mode) ? mode : 'first'
  if (fam === 'push') return { events: ['push:*'], commentFamilies: [], mentionOnly: false }
  return own === 'first'
    ? { events: ['merge_request:opened'], commentFamilies: [], mentionOnly: false }
    : { events: ['merge_request:*'], commentFamilies: ['merge_request'], mentionOnly: own === 'mention' }
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  return actualSet.size === expectedSet.size && [...actualSet].every((value) => expectedSet.has(value))
}

/** Whether a stored rule differs from the console's encoding, such as finer patterns an API caller wrote; it is never rewritten implicitly. */
export function azureDevOpsHookNeedsNormalization(hook: {
  family: string | null
  events: readonly string[]
  commentFamilies: readonly HookCommentFamily[]
  mentionOnly: boolean
}): boolean {
  const family = azureDevOpsHookFamily(hook)
  if (!family) return false
  const expected = azureDevOpsFamilySubscription(family, azureDevOpsTriggerModeOf(hook))
  return (
    !sameMembers(hook.events, expected.events) ||
    !sameMembers(azureDevOpsCommentFamilies(hook.commentFamilies), expected.commentFamilies)
  )
}

/** A cadence pick on an existing hook — null when nothing would change; re-picking the displayed cadence normalizes a custom rule. */
export function azureDevOpsCadencePick(
  hook: {
    family: string | null
    events: readonly string[]
    commentFamilies: readonly HookCommentFamily[]
    mentionOnly: boolean
  },
  mode: AzTriggerMode
): { family: AzFamily; mode: AzTriggerMode } | null {
  const family = azureDevOpsHookFamily(hook)
  if (!family) return null
  if (mode === azureDevOpsTriggerModeOf(hook) && !azureDevOpsHookNeedsNormalization(hook)) return null
  return { family, mode }
}
