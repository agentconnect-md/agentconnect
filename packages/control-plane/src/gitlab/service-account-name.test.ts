/**
 * Project Service Account naming (gitlab-com-integration.md §7.2): the username
 * is the rename-stable machine identity, the display name is the friendly label.
 */
import { describe, expect, it } from 'vitest'
import { gitlabServiceAccountDisplayName, gitlabServiceAccountNameIsDefault } from './api.js'

const USERNAME = 'agentconnect-p4455667'

describe('gitlabServiceAccountDisplayName', () => {
  it('names the account after the project’s own last path segment', () => {
    expect(gitlabServiceAccountDisplayName('example-group/example-project', USERNAME)).toBe('example-project-bot')
    // Nested subgroups still resolve to the project itself.
    expect(gitlabServiceAccountDisplayName('example-group/team/api.service', USERNAME)).toBe('api.service-bot')
  })

  it('folds anything outside the safe set and caps the segment', () => {
    expect(gitlabServiceAccountDisplayName('group/prêt <à> porter', USERNAME)).toBe('pr-t-porter-bot')
    const long = gitlabServiceAccountDisplayName(`group/${'a'.repeat(120)}`, USERNAME)
    expect(long).toBe(`${'a'.repeat(48)}-bot`)
  })

  it('falls back to the machine username when nothing survives', () => {
    expect(gitlabServiceAccountDisplayName('group/***', USERNAME)).toBe(USERNAME)
    expect(gitlabServiceAccountDisplayName('', USERNAME)).toBe(USERNAME)
  })
})

describe('gitlabServiceAccountNameIsDefault', () => {
  it('accepts every default form the account can carry', () => {
    expect(gitlabServiceAccountNameIsDefault('', USERNAME)).toBe(true)
    expect(gitlabServiceAccountNameIsDefault(undefined, USERNAME)).toBe(true)
    expect(gitlabServiceAccountNameIsDefault(USERNAME, USERNAME)).toBe(true)
    expect(gitlabServiceAccountNameIsDefault('AgentConnect (example-group/example-project)', USERNAME)).toBe(true)
  })

  it('never claims a name a person chose', () => {
    expect(gitlabServiceAccountNameIsDefault('Release Robot', USERNAME)).toBe(false)
    expect(gitlabServiceAccountNameIsDefault('example-project-bot', USERNAME)).toBe(false)
    // Near-miss on the retired form: only the exact shape counts as ours.
    expect(gitlabServiceAccountNameIsDefault('AgentConnect helper', USERNAME)).toBe(false)
  })
})
