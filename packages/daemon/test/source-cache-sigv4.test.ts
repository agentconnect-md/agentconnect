import { describe, expect, it } from 'vitest'
import { amzDate, canonicalQuery, canonicalUri, presign, s3UriEncode, signHeaders } from '../src/source-cache/sigv4.js'

// AWS's published S3 SigV4 examples (sigv4-query-string-auth / sigv4-header-based-auth).
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
}

describe('Source Cache SigV4', () => {
  it('reproduces the AWS S3 query-string presigned GET example', () => {
    const { url, signedHeaders } = presign({
      method: 'GET',
      protocol: 'https:',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      credentials: AWS_EXAMPLE,
      region: 'us-east-1',
      datetime: '20130524T000000Z',
      expiresSeconds: 86_400
    })
    expect(signedHeaders).toBe('host')
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    )
  })

  it('reproduces the AWS S3 header-auth PUT example, pinning $ encoding through the shared core', () => {
    const { authorization } = signHeaders({
      method: 'PUT',
      protocol: 'https:',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test$file.text',
      headers: {
        date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-date': '20130524T000000Z',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        'x-amz-content-sha256': '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072'
      },
      payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
      credentials: AWS_EXAMPLE,
      region: 'us-east-1',
      datetime: '20130524T000000Z'
    })
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
        'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,' +
        'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd'
    )
  })

  it('reproduces the AWS S3 header-auth GET-with-Range example', () => {
    const { authorization } = signHeaders({
      method: 'GET',
      protocol: 'https:',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      headers: {
        range: 'bytes=0-9',
        'x-amz-date': '20130524T000000Z',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      credentials: AWS_EXAMPLE,
      region: 'us-east-1',
      datetime: '20130524T000000Z'
    })
    expect(authorization).toContain('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
  })

  it('S3-encodes every byte outside the unreserved set, keeping / in paths', () => {
    expect(s3UriEncode('a b')).toBe('a%20b')
    expect(s3UriEncode('a+b')).toBe('a%2Bb')
    expect(s3UriEncode('github:123')).toBe('github%3A123')
    expect(s3UriEncode("~-_.!'()*")).toBe('~-_.%21%27%28%29%2A')
    expect(s3UriEncode('é')).toBe('%C3%A9')
    expect(s3UriEncode('a/b')).toBe('a%2Fb')
    expect(canonicalUri('/bucket/src/o/cred/github:1/x y')).toBe('/bucket/src/o/cred/github%3A1/x%20y')
  })

  it('sorts the canonical query by encoded name and keeps value-less parameters', () => {
    expect(canonicalQuery({ 'X-Amz-Date': 'd', tagging: '', 'X-Amz-Algorithm': 'a' })).toBe(
      'X-Amz-Algorithm=a&X-Amz-Date=d&tagging='
    )
  })

  it('signs a session token into the query', () => {
    const base = {
      method: 'GET',
      protocol: 'https:' as const,
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      datetime: '20130524T000000Z',
      expiresSeconds: 300
    }
    const plain = presign({ ...base, credentials: AWS_EXAMPLE })
    const temporary = presign({ ...base, credentials: { ...AWS_EXAMPLE, sessionToken: 'tok+en/=' } })
    expect(temporary.canonicalRequest).toContain('X-Amz-Security-Token=tok%2Ben%2F%3D')
    expect(new URL(temporary.url).searchParams.get('X-Amz-Security-Token')).toBe('tok+en/=')
    expect(new URL(temporary.url).searchParams.get('X-Amz-Signature')).not.toBe(
      new URL(plain.url).searchParams.get('X-Amz-Signature')
    )
  })

  it('formats an AWS datetime', () => {
    expect(amzDate(Date.UTC(2013, 4, 24, 0, 0, 0, 999))).toBe('20130524T000000Z')
  })
})
