import { isIP } from 'node:net'

export interface BucketAddressing {
  protocol: 'https:' | 'http:'
  host: string
  /** Raw path prefix before the object key: `/<bucket>/` (path style) or `/`. */
  basePath: string
  style: 'path' | 'virtual'
}

/** Path style when asked, for an IP-literal or localhost endpoint, or for a dotted bucket the TLS name would not cover. */
export function addressFor(endpoint: string, bucket: string, forcePathStyle: boolean): BucketAddressing {
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('object store endpoint must be http(s)')
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  const pathStyle = forcePathStyle || isIP(hostname) !== 0 || hostname === 'localhost' || bucket.includes('.')
  return pathStyle
    ? { protocol: url.protocol, host: url.host, basePath: `/${bucket}/`, style: 'path' }
    : { protocol: url.protocol, host: `${bucket}.${url.host}`, basePath: '/', style: 'virtual' }
}
