import { CODE_HOST_SETUP_URI, INTEGRATION_SETUP_URI } from '@agentconnect.md/protocol/mcp-app'

export const NATIVE_APP_MIME = 'text/html;profile=mcp-app'

/** Other hosts get an explanation; the trusted Console host substitutes its native dialog without reading HTML. */
function fallbackHtml(heading: string, what: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><h2>${heading}</h2><p>Open AgentConnect Console to ${what}. This interface requires the Console native configuration support.</p></body></html>`
}

/** Every `ui://` resource this server predeclares, and the tool that points at one through `_meta.ui.resourceUri`. */
export const NATIVE_APPS = [
  {
    uri: INTEGRATION_SETUP_URI,
    name: 'Integration setup',
    html: fallbackHtml('Integration configuration', 'configure this integration')
  },
  {
    uri: CODE_HOST_SETUP_URI,
    name: 'Code host connections',
    html: fallbackHtml('Code host connections', 'manage the organization’s GitHub, GitLab and Gitea connections')
  }
] as const

export function nativeApp(uri: string): (typeof NATIVE_APPS)[number] | undefined {
  return NATIVE_APPS.find((app) => app.uri === uri)
}
