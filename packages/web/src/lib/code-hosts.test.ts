// Which code hosts each picker offers: every console-ready host for workspaces and grants, only hosts with hooks for triggers.
import { describe, expect, it } from 'vitest'
import { CODE_HOST_PROJECTION, PICKABLE_CODE_HOST_PROVIDERS, TRIGGER_CODE_HOST_PROVIDERS } from './code-hosts'

describe('code-host pickers', () => {
  it('offers Azure DevOps for workspaces and grants but not as a trigger, by its hooks capability', () => {
    expect(PICKABLE_CODE_HOST_PROVIDERS).toEqual(['github', 'gitlab', 'gitea', 'azure-devops'])
    expect(CODE_HOST_PROJECTION['azure-devops'].hooks).toBe(false)
    expect(TRIGGER_CODE_HOST_PROVIDERS).toEqual(['github', 'gitlab', 'gitea'])
  })
})
