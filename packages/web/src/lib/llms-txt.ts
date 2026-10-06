import { HELP_LINK_DEFAULTS } from '@/lib/help-links'

export interface LlmsTxtLinks {
  origin: string // the console origin the request arrived on, which resolves relative service URLs
  cpBase: string
  mcpEndpoint: string
  docs: string
  mcpGuide: string
}

// The console's llms.txt: every page needs sign-in, so it points readers at the docs and this deployment's API instead.
export function llmsTxt({ origin, cpBase, mcpEndpoint, docs, mcpGuide }: LlmsTxtLinks): string {
  const abs = (url: string) => new URL(url, origin).href
  const docsIndex =
    docs === HELP_LINK_DEFAULTS.docs
      ? `- [Documentation index](${docs}/llms.txt): every guide and API operation, each available as Markdown\n`
      : ''
  return `# AgentConnect console

> The web console of an AgentConnect deployment. Every page requires sign-in and shows one organization's agents, sessions and settings, so there is nothing here to read without an account. Use the documentation and this deployment's API below instead.

## Docs

${docsIndex}- [Documentation](${docs}): guides, self-hosting and API reference
- [MCP connector](${mcpGuide}): connect Claude or any MCP client to this deployment

## API

- [OpenAPI document](${abs(`${cpBase}/openapi.json`)}): this deployment's REST API; authenticate with an API key
- [MCP endpoint](${abs(mcpEndpoint)}): this deployment's MCP server, for MCP clients signed in with OAuth or an API key
`
}
