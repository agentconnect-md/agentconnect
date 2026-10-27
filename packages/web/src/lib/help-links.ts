// Help-menu link defaults; each is overridable per deployment through the HELP_* runtime keys in lib/public-env.
export const HELP_LINK_DEFAULTS = {
  mcp: 'https://www.agentconnect.md/docs/connect-automate/mcp-connector',
  docs: 'https://www.agentconnect.md/docs',
  releases: 'https://github.com/agentconnect-md/agentconnect/releases',
  support: 'mailto:contact@agentconnect.md'
}

// The docs root, read at render: window.__AC_ENV in the browser, process.env during SSR.
export function helpDocsBase(): string {
  const src = typeof window === 'undefined' ? process.env : (window.__AC_ENV ?? {})
  return src.HELP_DOCS_URL || process.env.NEXT_PUBLIC_HELP_DOCS_URL || HELP_LINK_DEFAULTS.docs
}

// One page under the docs root; Chinese readers get the site's /zh copy, which falls back to English per page.
export function docsPageUrl(path: string, locale: string): string {
  const base = helpDocsBase().replace(/\/+$/, '')
  return `${base}${locale.startsWith('zh') ? '/zh' : ''}/${path}`
}
