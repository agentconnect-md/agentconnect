// How an artifact's entry opens (artifacts.md §9); mirrors the console's `artifactKind` so the list filter matches its icons.

export const ARTIFACT_KINDS = ['page', 'document', 'image', 'pdf', 'code', 'other'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

const TEXT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/ecmascript',
  'application/typescript',
  'application/x-sh',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/sql',
  'application/x-ndjson'
])
const MARKDOWN_RE = /\.(md|markdown)$/i

/** HTML is a page, Markdown a document, then image, PDF, any text or code, and everything else. */
export function artifactKind(mediaType: string, path: string): ArtifactKind {
  const type = (mediaType.toLowerCase().split(';')[0] ?? '').trim()
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'page'
  if (type === 'text/markdown' || type === 'text/x-markdown' || MARKDOWN_RE.test(path)) return 'document'
  if (type.startsWith('image/')) return 'image'
  if (type === 'application/pdf') return 'pdf'
  if (type.startsWith('text/') || TEXT_TYPES.has(type) || type.endsWith('+json') || type.endsWith('+xml')) return 'code'
  return 'other'
}
