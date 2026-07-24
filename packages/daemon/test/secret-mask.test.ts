import { describe, it, expect } from 'vitest'
import {
  MIN_MASKABLE_SECRET_LENGTH,
  expandSecretVariants,
  maskableSecrets,
  maskSecretsDeep,
  maskSecretsInText,
  secretPlaceholder
} from '../src/session/secret-mask.js'

describe('maskableSecrets', () => {
  it('returns [] for an absent agent or no configured secrets', () => {
    expect(maskableSecrets(undefined)).toEqual([])
    expect(maskableSecrets({})).toEqual([])
    expect(maskableSecrets({ runtimeOverrides: { secrets: [] } })).toEqual([])
  })

  it('drops values too short to mask and keeps the rest', () => {
    const entries = maskableSecrets({
      runtimeOverrides: {
        secrets: [
          { name: 'SHORT', value: 'abc' }, // < MIN_MASKABLE_SECRET_LENGTH — unmaskable
          { name: 'OK', value: 'abcd' }
        ]
      }
    })
    expect(entries).toEqual([{ name: 'OK', value: 'abcd' }])
    expect('abc'.length).toBeLessThan(MIN_MASKABLE_SECRET_LENGTH)
  })

  it('orders longest value first so a substring secret cannot split a longer match', () => {
    const entries = maskableSecrets({
      runtimeOverrides: {
        secrets: [
          { name: 'INNER', value: 'token' },
          { name: 'OUTER', value: 'token-with-suffix' }
        ]
      }
    })
    expect(entries.map((e) => e.name)).toEqual(['OUTER', 'INNER'])
    expect(maskSecretsInText('use token-with-suffix here', entries)).toBe('use [secret:OUTER] here')
  })
})

describe('expandSecretVariants', () => {
  const AUTH = 'YWxpY2U6czNjcjN0LXdpdGgtbGVuZ3Ro' // 32-char base64
  const DOCKER = `{"auths":{"ghcr.io":{"auth":"${AUTH}"}}}`
  const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZ2VudCJ9.c2lnbmF0dXJl'
  const KUBE = [
    'apiVersion: v1',
    'clusters:',
    '- name: kubernetes',
    '  cluster:',
    '    server: https://10.0.0.1:6443',
    'users:',
    '- name: kubernetes-admin',
    '  user:',
    `    token: ${TOKEN}`,
    ''
  ].join('\n')

  it('a plain token expands to just itself', () => {
    expect(expandSecretVariants('sk-plain-value')).toEqual(['sk-plain-value'])
  })

  it('JSON: masks the pretty-printed rendering and the credential leaf', () => {
    const variants = expandSecretVariants(DOCKER)
    expect(variants).toContain(DOCKER)
    expect(variants).toContain(JSON.stringify(JSON.parse(DOCKER), null, 2))
    expect(variants).toContain(AUTH)
  })

  it('YAML kubeconfig: masks the token but not common identifiers', () => {
    const variants = expandSecretVariants(KUBE)
    expect(variants).toContain(KUBE)
    expect(variants).toContain(TOKEN)
    expect(variants).not.toContain('kubernetes')
    expect(variants).not.toContain('kubernetes-admin')
    expect(variants).not.toContain('https://10.0.0.1:6443')
  })

  it('credential-shaped runs survive without any parseable structure', () => {
    const pemLine = 'MIIC0DCCAbigAwIBAgIUXo0/8DCCAbigAwIBAgIUXo08x'
    const variants = expandSecretVariants(`-----BEGIN KEY-----\n${pemLine}\nshort\n-----END KEY-----`)
    expect(variants).toContain(pemLine)
    expect(variants.every((v) => v !== 'short')).toBe(true)
  })

  it('does not mask hostname-shaped runs (long cluster endpoints)', () => {
    const fqdn = '5A1B2C3D4E5F6A7B8C9D.gr7.us-west-2.eks.amazonaws.com'
    const variants = expandSecretVariants(
      `clusters:\n- cluster:\n    server: https://${fqdn}\nusers:\n- user:\n    token: ${'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZ2VudCJ9.c2ln'}\n`
    )
    expect(variants).not.toContain(fqdn)
    expect(variants).toContain('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZ2VudCJ9.c2ln')
  })

  it('does not blow up on YAML anchors/aliases', () => {
    const value = 'a: &x\n  self: ok-value\nb: *x\n'
    expect(expandSecretVariants(value)).toContain(value)
  })
})

describe('maskableSecrets with structured values', () => {
  it('masks a grepped kubeconfig line through the leaf variant', () => {
    const token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZ2VudCJ9.c2lnbmF0dXJl'
    const agent = {
      runtimeOverrides: {
        secrets: [{ name: 'KUBECONFIG_DATA', value: `users:\n- user:\n    token: ${token}\n` }]
      }
    }
    const masked = maskSecretsInText(`$ grep token kubeconfig\n    token: ${token}`, maskableSecrets(agent))
    expect(masked).not.toContain(token)
    expect(masked).toContain(secretPlaceholder('KUBECONFIG_DATA'))
  })

  it('memoizes per agent object (hot path)', () => {
    const agent = { runtimeOverrides: { secrets: [{ name: 'A', value: 'long-enough-value' }] } }
    expect(maskableSecrets(agent)).toBe(maskableSecrets(agent))
  })
})

describe('maskSecretsInText', () => {
  const entries = [{ name: 'TestSA', value: 's3cret-value' }]

  it('replaces every literal occurrence with the key-named placeholder', () => {
    expect(maskSecretsInText('a s3cret-value and s3cret-value again', entries)).toBe(
      `a ${secretPlaceholder('TestSA')} and ${secretPlaceholder('TestSA')} again`
    )
  })

  it('treats regex metacharacters in the value literally', () => {
    const meta = [{ name: 'RX', value: 'a.b*c(d)' }]
    expect(maskSecretsInText('x a.b*c(d) y aXbYcZdW', meta)).toBe('x [secret:RX] y aXbYcZdW')
  })

  it('leaves text without a match untouched', () => {
    expect(maskSecretsInText('nothing to hide', entries)).toBe('nothing to hide')
  })
})

describe('maskSecretsDeep', () => {
  const entries = [{ name: 'TestSA', value: 's3cret-value' }]

  it('masks strings nested in objects and arrays, leaving other primitives alone', () => {
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawInput: { command: 'curl -H "Auth: s3cret-value"' },
      rawOutput: { output: 'TestSA=s3cret-value\n', exitCode: 0 },
      content: [{ type: 'content', content: { type: 'text', text: 'value is s3cret-value' } }],
      count: 3,
      ok: true,
      nothing: null
    }
    const masked = maskSecretsDeep(update, entries)
    expect(masked.rawInput.command).toBe('curl -H "Auth: [secret:TestSA]"')
    expect(masked.rawOutput).toEqual({ output: 'TestSA=[secret:TestSA]\n', exitCode: 0 })
    expect((masked.content[0] as any).content.text).toBe('value is [secret:TestSA]')
    expect(masked.count).toBe(3)
    expect(masked.ok).toBe(true)
    expect(masked.nothing).toBeNull()
    expect(JSON.stringify(masked)).not.toContain('s3cret-value')
  })

  it('returns the SAME reference when nothing matches (no-allocation hot path)', () => {
    const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'all clear' } }
    expect(maskSecretsDeep(update, entries)).toBe(update)
    expect(maskSecretsDeep(update, [])).toBe(update)
  })

  it('is copy-on-write: the original object is never mutated', () => {
    const update = { content: { text: 'holds s3cret-value' }, sibling: { text: 'clean' } }
    const masked = maskSecretsDeep(update, entries)
    expect(update.content.text).toBe('holds s3cret-value')
    expect(masked.content.text).toBe('holds [secret:TestSA]')
    // untouched branches keep their identity inside the masked copy
    expect(masked.sibling).toBe(update.sibling)
  })
})
