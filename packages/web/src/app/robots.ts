import type { MetadataRoute } from 'next'

// Crawlers must reach console pages to read their noindex metadata and remove existing search results.
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: '*', allow: '/' }] }
}
