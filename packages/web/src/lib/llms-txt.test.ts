import { describe, expect, it } from 'vitest'
import { HELP_LINK_DEFAULTS } from '@/lib/help-links'
import { llmsTxt } from '@/lib/llms-txt'

const links = {
  origin: 'https://console.example.test',
  cpBase: 'https://api.example.test/v1',
  mcpEndpoint: 'https://api.example.test/v1/mcp',
  docs: HELP_LINK_DEFAULTS.docs,
  mcpGuide: HELP_LINK_DEFAULTS.mcp
}

describe('llmsTxt', () => {
  it("links this deployment's OpenAPI document and MCP endpoint", () => {
    const body = llmsTxt(links)
    expect(body).toContain('(https://api.example.test/v1/openapi.json)')
    expect(body).toContain('(https://api.example.test/v1/mcp)')
    expect(body).toContain(`(${HELP_LINK_DEFAULTS.docs}/llms.txt)`)
  })

  it('resolves relative service URLs against the console origin', () => {
    const body = llmsTxt({ ...links, cpBase: '/cp/v1', mcpEndpoint: '/cp/v1/mcp' })
    expect(body).toContain('(https://console.example.test/cp/v1/openapi.json)')
    expect(body).toContain('(https://console.example.test/cp/v1/mcp)')
  })

  it('omits the docs index when a deployment points at its own docs', () => {
    const body = llmsTxt({ ...links, docs: 'https://docs.example.test' })
    expect(body).not.toContain('llms.txt')
    expect(body).toContain('[Documentation](https://docs.example.test)')
  })
})
