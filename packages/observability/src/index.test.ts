import { describe, expect, it } from 'vitest'
import { shouldIgnoreUndiciRequest, undiciClientSpanName } from './index.js'

describe('shouldIgnoreUndiciRequest', () => {
  it.each(['/bottelegram-secret/getMe', '/bottelegram-secret/setMyProfilePhoto'])(
    'suppresses token-bearing Telegram Bot API path %s',
    (path) => {
      expect(shouldIgnoreUndiciRequest({ origin: 'https://api.telegram.org', path })).toBe(true)
    }
  )

  it('keeps unrelated outgoing requests instrumented', () => {
    expect(shouldIgnoreUndiciRequest({ origin: 'https://api.example.test', path: '/bottelegram-secret/getMe' })).toBe(
      false
    )
    expect(shouldIgnoreUndiciRequest({ origin: 'https://api.telegram.org', path: '/file/example' })).toBe(false)
  })
})

describe('undiciClientSpanName', () => {
  const name = (path: string, origin = 'https://api.example.test', method = 'GET') =>
    undiciClientSpanName({ origin, path, method })

  it('names the destination so a waterfall is readable', () => {
    expect(name('/repositories/12345')).toBe('GET api.example.test/repositories/{id}')
    expect(name('/repos/example-org/example-repo/pulls/7', 'https://api.example.test', 'POST')).toBe(
      'POST api.example.test/repos/example-org/example-repo/pulls/{id}'
    )
    expect(name('/api/chat.postMessage', 'https://slack.example.test', 'POST')).toBe(
      'POST slack.example.test/api/chat.postMessage'
    )
  })

  it('redacts a token carried in the path', () => {
    // The same shape `shouldIgnoreUndiciRequest` drops outright; the naming
    // function must not leak it either if that hook is ever bypassed.
    expect(
      name('/bot7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage', 'https://api.telegram.org', 'POST')
    ).toBe('POST api.telegram.org/{id}/sendMessage')
    // A token without punctuation to break on is still opaque: long, mixed case,
    // letters and digits together.
    expect(name('/v1/keys/sk0aBcDeFgHiJkLmNoPqRsTuV')).toBe('GET api.example.test/v1/keys/{id}')
  })

  it('never carries the query string into the name', () => {
    expect(name('/oauth/token?client_secret=super-secret&code=abc')).toBe('GET api.example.test/oauth/token')
    expect(name('/users#fragment')).toBe('GET api.example.test/users')
  })

  it('collapses high-entropy segments of every shape', () => {
    // numeric id, uuid, sha digest, unhyphenated hex, digits inside a word
    expect(name('/v1/items/908172')).toBe('GET api.example.test/v1/items/{id}')
    expect(name('/v1/items/f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe('GET api.example.test/v1/items/{id}')
    expect(name('/blobs/da39a3ee5e6b4b0d3255bfef95601890afd80709')).toBe('GET api.example.test/blobs/{id}')
    expect(name('/blobs/deadbeefdeadbeefdeadbeefdeadbeef')).toBe('GET api.example.test/blobs/{id}')
    expect(name('/im/v1/messages/om4d9a2f7b13c05e8460711')).toBe('GET api.example.test/im/v1/messages/{id}')
  })

  it('keeps short, hand-written route words intact', () => {
    expect(name('/open-apis/im/v1/messages')).toBe('GET api.example.test/open-apis/im/v1/messages')
    expect(name('/oidc/.well-known/openid-configuration')).toBe(
      'GET api.example.test/oidc/.well-known/openid-configuration'
    )
    expect(name('/')).toBe('GET api.example.test/')
  })

  it('keeps a non-default port and an unusual method bounded', () => {
    expect(name('/readyz', 'http://daemon.example.test:8443')).toBe('GET daemon.example.test:8443/readyz')
    expect(name('/things', 'https://api.example.test', 'not-a-method')).toBe('HTTP api.example.test/things')
  })

  it('leaves the default name in place when the URL cannot be parsed', () => {
    expect(undiciClientSpanName({ origin: 'not a url', path: '/things', method: 'GET' })).toBeUndefined()
  })
})
