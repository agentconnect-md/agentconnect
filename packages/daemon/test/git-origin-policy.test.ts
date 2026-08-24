import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS } from '@agentconnect.md/protocol'
import { authorizeWorkspaceGitUrl, configureWorkspaceGitOrigins } from '../src/workspace/git-origin-policy.js'

afterEach(() => configureWorkspaceGitOrigins(DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS))

describe('workspace Git origin policy', () => {
  it('denies an unconfigured host at the daemon boundary', () => {
    expect(() => authorizeWorkspaceGitUrl('https://code.example.test/acme/repo.git')).toThrow(
      'git clone origin is not allowed'
    )
    // §13.2: managed GitLab is HTTPS-only and part of the default policy now.
    expect(authorizeWorkspaceGitUrl('https://gitlab.com/example-group/example-project.git')).toBe(
      'https://gitlab.com/example-group/example-project.git'
    )
    expect(() => authorizeWorkspaceGitUrl('ssh://git@gitlab.com/example-group/example-project.git')).toThrow(
      'git clone origin is not allowed'
    )
  })

  it('treats an explicit empty policy as deny-all', () => {
    configureWorkspaceGitOrigins([])
    expect(() => authorizeWorkspaceGitUrl('https://github.com/acme/repo.git')).toThrow(
      'git clone origin is not allowed'
    )
  })

  it('allows an exact operator-configured origin without widening its port', () => {
    configureWorkspaceGitOrigins(['https://git.example:8443'])

    expect(authorizeWorkspaceGitUrl('https://git.example:8443/acme/repo.git')).toBe(
      'https://git.example:8443/acme/repo.git'
    )
    expect(() => authorizeWorkspaceGitUrl('https://git.example/acme/repo.git')).toThrow(
      'git clone origin is not allowed'
    )
  })
})
