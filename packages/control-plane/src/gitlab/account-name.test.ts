/**
 * Agent service-account naming (gitlab-com-integration.md §7.2): the username is
 * `<agentSlug>-<agentId12>-<root36>`, readable but carrying its own uniqueness;
 * the display name is the agent's own name.
 */
import { describe, expect, it } from 'vitest'
import {
  GITLAB_ACCOUNT_SLUG_MAX,
  gitlabAccountSlug,
  gitlabAccountUsernameMatchesScheme,
  gitlabAgentAccountDisplayName,
  gitlabAgentAccountUsername
} from './api.js'

const AGENT = '5b350c0a-eba7-4f7a-9c11-2d5e6f7a8b90'
const OTHER = '3f6a1c2e-8b4d-4f7a-9c11-2d5e6f7a8b90'
const ROOT = 123456789n
const USERNAME = 'gitlab-pilot-5b350c0aeba7-21i3v9'

/** GitLab slug rules: bounded to the safe set, starts and ends alphanumeric, no
 *  consecutive specials, and never the `.git`/`.atom` suffixes. */
function isValidGitlabUsername(username: string): boolean {
  return (
    /^[A-Za-z0-9](?:[A-Za-z0-9]|[_.-][A-Za-z0-9])*$/.test(username) &&
    !username.endsWith('.git') &&
    !username.endsWith('.atom')
  )
}

describe('gitlabAccountSlug', () => {
  it('lower-cases the agent name and folds anything outside [a-z0-9] to a dash', () => {
    expect(gitlabAccountSlug('GitLab Pilot')).toBe('gitlab-pilot')
    expect(gitlabAccountSlug('prêt <à> porter')).toBe('pr-t-porter')
  })

  it('collapses runs and trims the ends', () => {
    expect(gitlabAccountSlug('  ***Release___Robot!!!  ')).toBe('release-robot')
    expect(gitlabAccountSlug('--a--b--')).toBe('a-b')
  })

  it('caps the slug without leaving a trailing dash', () => {
    expect(gitlabAccountSlug('a'.repeat(80))).toBe('a'.repeat(GITLAB_ACCOUNT_SLUG_MAX))
    // The cap lands exactly on the separator, which then has to go.
    expect(gitlabAccountSlug('abcdefghijklmnopqrs tuv')).toBe('abcdefghijklmnopqrs')
  })

  it('falls back to `agent` when nothing survives', () => {
    expect(gitlabAccountSlug('***')).toBe('agent')
    expect(gitlabAccountSlug('')).toBe('agent')
    expect(gitlabAccountSlug('日本語')).toBe('agent')
  })
})

describe('gitlabAgentAccountUsername', () => {
  it('reads as the agent, then twelve hex of its id, then the root in base 36', () => {
    expect(gitlabAgentAccountUsername(AGENT, 'GitLab Pilot', ROOT)).toBe(USERNAME)
  })

  it('gives one agent a distinct account per top-level group', () => {
    expect(gitlabAgentAccountUsername(AGENT, 'pilot', ROOT)).not.toBe(gitlabAgentAccountUsername(AGENT, 'pilot', 999n))
  })

  it('separates two agents that share a name and a root', () => {
    expect(gitlabAgentAccountUsername(AGENT, 'pilot', ROOT)).not.toBe(gitlabAgentAccountUsername(OTHER, 'pilot', ROOT))
  })

  it('is a valid GitLab username for every name that reaches it', () => {
    for (const name of ['GitLab Pilot', '***', '', '日本語', '-'.repeat(40), 'a.b.c', 'x'.repeat(200), '.git']) {
      expect(isValidGitlabUsername(gitlabAgentAccountUsername(AGENT, name, ROOT))).toBe(true)
    }
  })
})

describe('gitlabAccountUsernameMatchesScheme', () => {
  it('accepts a username this scheme could have produced', () => {
    expect(gitlabAccountUsernameMatchesScheme(USERNAME, AGENT, ROOT)).toBe(true)
    expect(gitlabAccountUsernameMatchesScheme('agent-5b350c0aeba7-21i3v9', AGENT, ROOT)).toBe(true)
  })

  it('stays true after an agent rename — the slug is creation-time only', () => {
    const created = gitlabAgentAccountUsername(AGENT, 'Old Name', ROOT)
    expect(gitlabAccountUsernameMatchesScheme(created, AGENT, ROOT)).toBe(true)
  })

  it('rejects the earlier machine scheme, so it converges once', () => {
    expect(gitlabAccountUsernameMatchesScheme(`agentconnect-a${AGENT.replace(/-/g, '')}-g${ROOT}`, AGENT, ROOT)).toBe(
      false
    )
  })

  it('rejects another agent’s or another root’s key suffix', () => {
    expect(gitlabAccountUsernameMatchesScheme(USERNAME, OTHER, ROOT)).toBe(false)
    expect(gitlabAccountUsernameMatchesScheme(USERNAME, AGENT, 999n)).toBe(false)
  })

  it('rejects a slug half that is empty, over-long, or outside the safe set', () => {
    expect(gitlabAccountUsernameMatchesScheme('-5b350c0aeba7-21i3v9', AGENT, ROOT)).toBe(false)
    expect(gitlabAccountUsernameMatchesScheme(`${'a'.repeat(21)}-5b350c0aeba7-21i3v9`, AGENT, ROOT)).toBe(false)
    expect(gitlabAccountUsernameMatchesScheme('Pilot-5b350c0aeba7-21i3v9', AGENT, ROOT)).toBe(false)
    expect(gitlabAccountUsernameMatchesScheme('a_b-5b350c0aeba7-21i3v9', AGENT, ROOT)).toBe(false)
  })
})

describe('gitlabAgentAccountDisplayName', () => {
  it('names the account after the agent', () => {
    expect(gitlabAgentAccountDisplayName('Release Robot', USERNAME)).toBe('Release-Robot')
    expect(gitlabAgentAccountDisplayName('reviewer', USERNAME)).toBe('reviewer')
  })

  it('folds anything outside the safe set and caps the name', () => {
    expect(gitlabAgentAccountDisplayName('prêt <à> porter', USERNAME)).toBe('pr-t-porter')
    expect(gitlabAgentAccountDisplayName('a'.repeat(120), USERNAME)).toBe('a'.repeat(48))
  })

  it('falls back to the machine username when nothing survives', () => {
    expect(gitlabAgentAccountDisplayName('***', USERNAME)).toBe(USERNAME)
    expect(gitlabAgentAccountDisplayName('', USERNAME)).toBe(USERNAME)
  })
})
