// The content domain's boot checks (artifacts.md §5.5): a classifiable DNS name, never same-site with the deployment.
import { describe, expect, it } from 'vitest'
import { contentDomainConflicts, contentDomainProblem } from './content-domain.js'

describe('contentDomainProblem', () => {
  it.each(['example-usercontent.net', 'usercontent.example.net', 'example-usercontent.co.uk', 'content.lan'])(
    'accepts %s',
    (domain) => expect(contentDomainProblem(domain)).toBeUndefined()
  )

  it.each([
    ['192.0.2.10', /IP address/],
    ['2001:db8::1', /scheme, port or path/],
    ['usercontent', /single-label/],
    ['localhost', /single-label/],
    ['artifacts.localhost', /localhost/],
    ['co.uk', /public suffix/],
    ['*.example-usercontent.net', /wildcard/],
    ['https://example-usercontent.net', /scheme, port or path/],
    ['example-usercontent.net:8443', /scheme, port or path/],
    ['Example-Usercontent.net', /lower case/],
    ['example_usercontent.net', /letters, digits and hyphens/],
    ['-bad.example.net', /letters, digits and hyphens/],
    ['example..net', /letters, digits and hyphens/],
    [`${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(30)}.net`, /at most/]
  ])('refuses %s', (domain, message) => expect(contentDomainProblem(domain)).toMatch(message))
})

describe('contentDomainConflicts', () => {
  const domain = 'example-usercontent.net'

  it('passes origins on other sites, including another registrable domain under a multi-label suffix', () => {
    expect(
      contentDomainConflicts('usercontent.co.uk', [
        { name: 'PUBLIC_WEB_URL', url: 'https://console.example.co.uk' },
        { name: 'AC_FILE_TRANSFER.publicEndpoint', url: 'https://192.0.2.10:9443' },
        { name: 'LOGTO_MGMT_ENDPOINT', url: 'http://logto:3001' }
      ])
    ).toEqual([])
  })

  it.each([
    'PUBLIC_WEB_URL',
    'CORS_ORIGIN',
    'PUBLIC_CP_URL',
    'PUBLIC_RELAY_URL',
    'PUBLIC_MCP_URL',
    'OIDC_ISSUER',
    'LOGTO_MGMT_ENDPOINT',
    'S3_ENDPOINT',
    'S3_PUBLIC_BASE_URL',
    'AC_FILE_TRANSFER.publicEndpoint'
  ])('refuses %s on the same site', (name) => {
    expect(contentDomainConflicts(domain, [{ name, url: 'https://other.example-usercontent.net/path' }])).toEqual([
      `${name} is on the content domain`
    ])
    expect(contentDomainConflicts('usercontent.example.test', [{ name, url: 'https://console.example.test' }])).toEqual(
      [`${name} is same-site with it (both under example.test)`]
    )
  })

  it('refuses the registrable domain itself, and a content domain under a known host', () => {
    expect(
      contentDomainConflicts('usercontent.example.com', [{ name: 'PUBLIC_WEB_URL', url: 'https://example.com' }])
    ).toHaveLength(1)
    expect(contentDomainConflicts('example.com', [{ name: 'PUBLIC_CP_URL', url: 'https://api.example.com' }])).toEqual([
      'PUBLIC_CP_URL is on the content domain'
    ])
  })

  it('treats hosts under a private public suffix as separate sites, as browsers do', () => {
    expect(
      contentDomainConflicts('content.github.io', [{ name: 'PUBLIC_WEB_URL', url: 'https://console.github.io' }])
    ).toEqual([])
  })
})
