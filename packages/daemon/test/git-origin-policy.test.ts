import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS } from '@agentconnect.md/protocol'
import {
  authorizeWorkspaceGitUrl,
  configureWorkspaceGitOrigins,
  permitsNoHttpsOrigin
} from '../src/workspace/git-origin-policy.js'

afterEach(() => configureWorkspaceGitOrigins(DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS))

describe('workspace Git origin policy', () => {
  it('admits any valid origin under the wildcard default', () => {
    expect(authorizeWorkspaceGitUrl('https://code.example.test/acme/repo.git')).toBe(
      'https://code.example.test/acme/repo.git'
    )
    expect(authorizeWorkspaceGitUrl('https://gitlab.com/example-group/example-project.git')).toBe(
      'https://gitlab.com/example-group/example-project.git'
    )
    expect(permitsNoHttpsOrigin()).toBe(false)
  })

  it('denies a host outside a stated exact list at the daemon boundary', () => {
    configureWorkspaceGitOrigins(['https://github.com', 'ssh://github.com', 'https://gitlab.com'])
    expect(() => authorizeWorkspaceGitUrl('https://code.example.test/acme/repo.git')).toThrow(
      'is not allowed by this daemon'
    )
    // §13.2: managed GitLab stays HTTPS-only under an exact list.
    expect(authorizeWorkspaceGitUrl('https://gitlab.com/example-group/example-project.git')).toBe(
      'https://gitlab.com/example-group/example-project.git'
    )
    expect(() => authorizeWorkspaceGitUrl('ssh://git@gitlab.com/example-group/example-project.git')).toThrow(
      'is not allowed by this daemon'
    )
  })

  it('treats an explicit empty policy as deny-all', () => {
    configureWorkspaceGitOrigins([])
    expect(() => authorizeWorkspaceGitUrl('https://github.com/acme/repo.git')).toThrow('is not allowed by this daemon')
  })

  it('allows an exact operator-configured origin without widening its port', () => {
    configureWorkspaceGitOrigins(['https://git.example:8443'])

    expect(authorizeWorkspaceGitUrl('https://git.example:8443/acme/repo.git')).toBe(
      'https://git.example:8443/acme/repo.git'
    )
    expect(() => authorizeWorkspaceGitUrl('https://git.example/acme/repo.git')).toThrow('is not allowed by this daemon')
  })
})

describe("the deployment's own code host", () => {
  const INSTANCE = 'https://gitlab.example.test'
  // The implicit code-host admission only matters under a TIGHTENED list — the
  // wildcard default admits everything already.
  beforeEach(() => configureWorkspaceGitOrigins(['https://github.com', 'ssh://github.com', 'https://gitlab.com']))

  // It is deployment configuration, and this daemon already trusts it to decide where an agent's
  // git credential may go. Making an operator restate it bought nothing and drifted.
  it('is cloneable when the spec in hand names it, without being stated in the list', () => {
    expect(authorizeWorkspaceGitUrl(`${INSTANCE}/team/repo.git`, INSTANCE)).toBe(`${INSTANCE}/team/repo.git`)
    // ...and only for the spec that names it: no process state leaks to the next caller.
    expect(() => authorizeWorkspaceGitUrl(`${INSTANCE}/team/repo.git`)).toThrow('is not allowed by this daemon')
  })

  it('admits that origin only, never anywhere else', () => {
    const prefixed = 'https://gitlab.example.test/gitlab'
    expect(authorizeWorkspaceGitUrl(`${INSTANCE}/gitlab/team/repo.git`, prefixed)).toBe(
      `${INSTANCE}/gitlab/team/repo.git`
    )
    expect(() => authorizeWorkspaceGitUrl('https://elsewhere.example.test/team/repo.git', prefixed)).toThrow(
      'is not allowed by this daemon'
    )
  })

  // `[]` is a decision about this daemon — no remote workspaces at all — not about one host.
  it('does not widen past an explicit deny-all', () => {
    configureWorkspaceGitOrigins([])
    expect(() => authorizeWorkspaceGitUrl(`${INSTANCE}/team/repo.git`, INSTANCE)).toThrow(
      'is not allowed by this daemon'
    )
    expect(permitsNoHttpsOrigin()).toBe(true)
  })

  // The startup warning reads the operator list alone: whether an instance is named is per-agent.
  it('leaves the https-only warning to the operator list', () => {
    configureWorkspaceGitOrigins(['ssh://github.com'])
    expect(permitsNoHttpsOrigin()).toBe(true)
    expect(authorizeWorkspaceGitUrl(`${INSTANCE}/team/repo.git`, INSTANCE)).toBe(`${INSTANCE}/team/repo.git`)
  })

  it('ignores a host that is not addressable as an origin', () => {
    expect(() => authorizeWorkspaceGitUrl(`${INSTANCE}/team/repo.git`, 'not a url')).toThrow(
      'is not allowed by this daemon'
    )
  })
})
