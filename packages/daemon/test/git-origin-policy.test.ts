import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS } from '@agentconnect.md/protocol'
import {
  adoptDeploymentCodeHost,
  authorizeWorkspaceGitUrl,
  configureWorkspaceGitOrigins,
  permitsNoHttpsOrigin
} from '../src/workspace/git-origin-policy.js'

afterEach(() => {
  configureWorkspaceGitOrigins(DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS)
  // Adoption is process state that only a named instance moves: park it on a host no case names,
  // so one test's instance cannot widen the next one's.
  adoptDeploymentCodeHost('https://adoption-parked.example.test')
})

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

describe("the deployment's own code host", () => {
  // It is deployment configuration, and this daemon already trusts it to decide where an agent's
  // git credential may go. Making an operator restate it bought nothing and drifted.
  it('is cloneable once a spec names it, with nothing configured locally', () => {
    adoptDeploymentCodeHost('https://gitlab.example.test')
    expect(authorizeWorkspaceGitUrl('https://gitlab.example.test/team/repo.git')).toBe(
      'https://gitlab.example.test/team/repo.git'
    )
  })

  it('admits that origin only, never anywhere else', () => {
    adoptDeploymentCodeHost('https://gitlab.example.test/gitlab')
    expect(authorizeWorkspaceGitUrl('https://gitlab.example.test/gitlab/team/repo.git')).toBe(
      'https://gitlab.example.test/gitlab/team/repo.git'
    )
    expect(() => authorizeWorkspaceGitUrl('https://elsewhere.example.test/team/repo.git')).toThrow(
      'git clone origin is not allowed'
    )
  })

  it('replaces the previous answer, because a deployment addresses one instance', () => {
    adoptDeploymentCodeHost('https://first.example.test')
    adoptDeploymentCodeHost('https://second.example.test')
    expect(() => authorizeWorkspaceGitUrl('https://first.example.test/team/repo.git')).toThrow(
      'git clone origin is not allowed'
    )
    expect(authorizeWorkspaceGitUrl('https://second.example.test/team/repo.git')).toBe(
      'https://second.example.test/team/repo.git'
    )
  })

  // `[]` is a decision about this daemon — no remote workspaces at all — not about one host.
  it('does not adopt past an explicit deny-all', () => {
    configureWorkspaceGitOrigins([])
    adoptDeploymentCodeHost('https://gitlab.example.test')
    expect(() => authorizeWorkspaceGitUrl('https://gitlab.example.test/team/repo.git')).toThrow(
      'git clone origin is not allowed'
    )
    expect(permitsNoHttpsOrigin()).toBe(true)
  })

  // Managed GitLab is HTTPS-only (§13.2), and the adopted instance counts for that check — an
  // operator list with no https origin no longer means no GitLab workspace can ever clone here.
  it('counts toward the https check the managed-GitLab warning reads', () => {
    configureWorkspaceGitOrigins(['ssh://github.com'])
    adoptDeploymentCodeHost('https://gitlab.example.test')
    expect(permitsNoHttpsOrigin()).toBe(false)
    expect(authorizeWorkspaceGitUrl('https://gitlab.example.test/team/repo.git')).toBe(
      'https://gitlab.example.test/team/repo.git'
    )
  })

  // An agent without GitLab is not a statement about the deployment. Clearing here would make the
  // policy depend on whose spec arrived last; a disconnected instance is forgotten at restart.
  it('is left alone by a spec that names no instance', () => {
    adoptDeploymentCodeHost('https://gitlab.example.test')
    adoptDeploymentCodeHost(undefined)
    expect(authorizeWorkspaceGitUrl('https://gitlab.example.test/team/repo.git')).toBe(
      'https://gitlab.example.test/team/repo.git'
    )
  })
})
