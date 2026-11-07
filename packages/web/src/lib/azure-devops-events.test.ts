// The Azure DevOps trigger encoding (azure-devops-integration.md §11.4): every compiled body matches the hook schema the Control Plane validates.
import { describe, expect, it } from 'vitest'
import {
  AZ_FAMILIES,
  azureDevOpsCadencePick,
  azureDevOpsFamilySubscription,
  azureDevOpsHookFamily,
  azureDevOpsHookNeedsNormalization,
  azureDevOpsTriggerModeOf
} from './azure-devops-events'
import {
  azureDevOpsPullRequestLabel,
  azureDevOpsPullRequestUrl,
  azureDevOpsRepositoryUrl
} from './azure-devops-repositories'

// The Control Plane's `AzureDevOpsHookEventPattern`.
const EVENT = /^(merge_request:(opened|synchronize|review_requested|reopened|\*)|push:\*)$/

describe('azure devops trigger encoding', () => {
  it('offers pull requests only', () => {
    expect(AZ_FAMILIES.map((tile) => tile.fam)).toEqual(['merge_request'])
  })

  it('compiles each cadence to patterns the server accepts and reads it back', () => {
    for (const mode of ['first', 'every', 'mention'] as const) {
      const body = azureDevOpsFamilySubscription('merge_request', mode)
      expect(body.events.every((event) => EVENT.test(event))).toBe(true)
      expect(azureDevOpsTriggerModeOf(body)).toBe(mode)
    }
    expect(azureDevOpsFamilySubscription('merge_request', 'first')).toEqual({
      events: ['merge_request:opened'],
      commentFamilies: [],
      mentionOnly: false
    })
    expect(azureDevOpsFamilySubscription('merge_request', 'mention')).toEqual({
      events: ['merge_request:*'],
      commentFamilies: ['merge_request'],
      mentionOnly: true
    })
    // A push has no thread: any cadence narrows to its one form.
    expect(azureDevOpsFamilySubscription('push', 'mention')).toEqual({
      events: ['push:*'],
      commentFamilies: [],
      mentionOnly: false
    })
  })

  it('never rewrites a finer rule an API caller stored until a cadence is picked', () => {
    const custom = {
      family: 'merge_request',
      events: ['merge_request:opened', 'merge_request:synchronize'],
      commentFamilies: [] as [],
      mentionOnly: false
    }
    expect(azureDevOpsHookFamily(custom)).toBe('merge_request')
    expect(azureDevOpsHookNeedsNormalization(custom)).toBe(true)
    expect(azureDevOpsCadencePick(custom, 'first')).toEqual({ family: 'merge_request', mode: 'first' })
    const canonical = { family: 'merge_request', ...azureDevOpsFamilySubscription('merge_request', 'every') }
    expect(azureDevOpsCadencePick(canonical, 'every')).toBeNull()
  })
})

describe('azure devops pull-request names (§11.8)', () => {
  it('labels and links a pull request by its repository path', () => {
    const repo = 'example-org/Example Project/example-repo'
    expect(azureDevOpsPullRequestLabel(repo, 12)).toBe('example-org/Example Project/example-repo!12')
    expect(azureDevOpsPullRequestUrl(repo, 12)).toBe(
      'https://dev.azure.com/example-org/Example%20Project/_git/example-repo/pullrequest/12'
    )
    expect(azureDevOpsRepositoryUrl('not-a-path')).toBeNull()
  })
})
