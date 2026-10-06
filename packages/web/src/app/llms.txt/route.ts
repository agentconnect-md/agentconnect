import { cpBase, mcpEndpointUrl } from '@/lib/endpoints'
import { HELP_LINK_DEFAULTS } from '@/lib/help-links'
import { llmsTxt, publicOrigin } from '@/lib/llms-txt'

// Each deployment's service URLs are runtime config, so the file is rendered per request.
export const dynamic = 'force-dynamic'

export function GET(request: Request) {
  const body = llmsTxt({
    origin: publicOrigin(request.headers, request.url),
    cpBase: cpBase(),
    mcpEndpoint: mcpEndpointUrl(),
    docs: process.env.HELP_DOCS_URL || process.env.NEXT_PUBLIC_HELP_DOCS_URL || HELP_LINK_DEFAULTS.docs,
    mcpGuide: process.env.HELP_MCP_URL || process.env.NEXT_PUBLIC_HELP_MCP_URL || HELP_LINK_DEFAULTS.mcp
  })
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
