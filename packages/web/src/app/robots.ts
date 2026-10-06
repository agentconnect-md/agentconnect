import type { MetadataRoute } from 'next'

// Every console page is behind sign-in, so crawlers have nothing to index; /llms.txt stays reachable for AI readers.
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: '*', allow: '/llms.txt', disallow: '/' }] }
}
