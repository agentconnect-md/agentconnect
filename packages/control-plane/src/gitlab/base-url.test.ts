/**
 * The GitLab host axis (gitlab-com-integration.md §24.1): the one normalization
 * of the configured base URL, the all-or-nothing resolution beside the OAuth
 * client pair, and URL composition — including the path-prefixed shape that
 * absolute-path URL resolution silently breaks.
 */
import { describe, expect, it } from 'vitest'
import { GitlabApiClient } from './api.js'
import { GITLAB_DEFAULT_BASE_URL, normalizeGitlabBaseUrl, resolveGitlabAppConfig } from './config.js'

const PAIR = { GITLAB_CLIENT_ID: 'client-1', GITLAB_CLIENT_SECRET: 'secret-1' } as const

describe('normalizeGitlabBaseUrl', () => {
  it('refuses plain http', () => {
    expect(() => normalizeGitlabBaseUrl('http://gitlab.example.test')).toThrow(/https/)
  })

  it('refuses a scheme that is neither http nor https', () => {
    expect(() => normalizeGitlabBaseUrl('ssh://gitlab.example.test')).toThrow(/https/)
  })

  it('refuses a value that is not an absolute URL', () => {
    expect(() => normalizeGitlabBaseUrl('gitlab.example.test')).toThrow(/absolute/)
  })

  it('refuses userinfo, so a credential can never ride the base URL', () => {
    expect(() => normalizeGitlabBaseUrl('https://user:pw@gitlab.example.test')).toThrow(/userinfo/)
    expect(() => normalizeGitlabBaseUrl('https://user@gitlab.example.test')).toThrow(/userinfo/)
  })

  it('refuses a query and a fragment', () => {
    expect(() => normalizeGitlabBaseUrl('https://gitlab.example.test?a=1')).toThrow(/query/)
    expect(() => normalizeGitlabBaseUrl('https://gitlab.example.test#frag')).toThrow(/fragment/)
  })

  it('lower-cases the host and leaves the path prefix case alone', () => {
    expect(normalizeGitlabBaseUrl('https://GitLab.Example.TEST/GitLab')).toBe('https://gitlab.example.test/GitLab')
  })

  it('preserves an explicit non-default port and drops the default one', () => {
    expect(normalizeGitlabBaseUrl('https://gitlab.example.test:8443')).toBe('https://gitlab.example.test:8443')
    expect(normalizeGitlabBaseUrl('https://gitlab.example.test:443')).toBe('https://gitlab.example.test')
  })

  it('strips every trailing slash', () => {
    expect(normalizeGitlabBaseUrl('https://gitlab.example.test/')).toBe('https://gitlab.example.test')
    expect(normalizeGitlabBaseUrl('https://gitlab.example.test/gitlab//')).toBe('https://gitlab.example.test/gitlab')
  })

  it('preserves a relative URL root, which is a first-class install shape', () => {
    expect(normalizeGitlabBaseUrl('https://apps.example.test/gitlab/')).toBe('https://apps.example.test/gitlab')
    expect(normalizeGitlabBaseUrl(' https://apps.example.test:8443/team/gitlab ')).toBe(
      'https://apps.example.test:8443/team/gitlab'
    )
  })

  it('is idempotent', () => {
    const once = normalizeGitlabBaseUrl('https://GitLab.Example.test:8443/gitlab/')
    expect(normalizeGitlabBaseUrl(once)).toBe(once)
  })
})

describe('resolveGitlabAppConfig', () => {
  it('is disabled when nothing is configured', () => {
    expect(resolveGitlabAppConfig({})).toBeUndefined()
  })

  it('defaults the axis to GitLab.com when only the client pair is set', () => {
    expect(resolveGitlabAppConfig({ ...PAIR })).toEqual({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      baseUrl: GITLAB_DEFAULT_BASE_URL
    })
  })

  it('normalizes the configured base URL exactly once, at resolution', () => {
    expect(resolveGitlabAppConfig({ ...PAIR, GITLAB_BASE_URL: 'https://GitLab.Example.test:8443/gitlab/' })).toEqual({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      baseUrl: 'https://gitlab.example.test:8443/gitlab'
    })
  })

  it('refuses a base URL with no OAuth application to reach it with', () => {
    expect(() => resolveGitlabAppConfig({ GITLAB_BASE_URL: 'https://gitlab.example.test' })).toThrow(
      /GITLAB_BASE_URL is set but no gitlab oauth application is/
    )
  })

  it('still refuses a partial client pair', () => {
    expect(() => resolveGitlabAppConfig({ GITLAB_CLIENT_ID: 'client-1' })).toThrow(/GITLAB_CLIENT_SECRET/)
  })

  it('propagates an invalid base URL as a boot failure', () => {
    expect(() => resolveGitlabAppConfig({ ...PAIR, GITLAB_BASE_URL: 'http://gitlab.example.test' })).toThrow(/https/)
  })
})

describe('GitlabApiClient URL composition', () => {
  it('composes today’s GitLab.com URLs byte-for-byte when the axis is unset', () => {
    const client = new GitlabApiClient(GITLAB_DEFAULT_BASE_URL)
    expect(client.apiUrl('/projects/4455667')).toBe('https://gitlab.com/api/v4/projects/4455667')
    expect(client.apiUrl('/groups/77/service_accounts')).toBe('https://gitlab.com/api/v4/groups/77/service_accounts')
    expect(client.rootUrl('/oauth/token')).toBe('https://gitlab.com/oauth/token')
    expect(client.rootUrl('/oauth/authorize')).toBe('https://gitlab.com/oauth/authorize')
  })

  it('keeps a non-default port on both the API and OAuth surfaces', () => {
    const client = new GitlabApiClient('https://gitlab.example.test:8443')
    expect(client.apiUrl('/user')).toBe('https://gitlab.example.test:8443/api/v4/user')
    expect(client.rootUrl('/oauth/token')).toBe('https://gitlab.example.test:8443/oauth/token')
  })

  it('keeps the path prefix that absolute-path URL resolution would discard', () => {
    const base = 'https://apps.example.test:8443/gitlab'
    const client = new GitlabApiClient(base)
    expect(client.apiUrl('/projects/4455667/hooks')).toBe(
      'https://apps.example.test:8443/gitlab/api/v4/projects/4455667/hooks'
    )
    expect(client.rootUrl('/oauth/authorize')).toBe('https://apps.example.test:8443/gitlab/oauth/authorize')
    // The bug this exists to prevent: resolution against an absolute path drops
    // the prefix and addresses the instance's own root instead.
    expect(new URL('/api/v4/projects/4455667/hooks', base).toString()).toBe(
      'https://apps.example.test:8443/api/v4/projects/4455667/hooks'
    )
  })

  it('sends every request to the composed URL', async () => {
    const urls: string[] = []
    const client = new GitlabApiClient('https://apps.example.test/gitlab', async (url) => {
      urls.push(url)
      return Response.json({ id: 4242, username: 'example-admin' })
    })
    await client.fetch(client.apiUrl('/user'))
    expect(urls).toEqual(['https://apps.example.test/gitlab/api/v4/user'])
  })
})
