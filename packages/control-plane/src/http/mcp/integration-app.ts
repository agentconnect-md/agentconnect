import { INTEGRATION_SETUP_URI } from '@agentconnect.md/protocol/mcp-app'

export const INTEGRATION_APP_URI = INTEGRATION_SETUP_URI
export const INTEGRATION_APP_MIME = 'text/html;profile=mcp-app'

// Other hosts get an explanation; the trusted Console host substitutes its native dialog without reading HTML.
export const INTEGRATION_APP_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><h2>Integration configuration</h2><p>Open AgentConnect Console to configure this integration. This interface requires the Console integration configuration support.</p></body></html>'
