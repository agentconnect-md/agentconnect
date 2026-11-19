import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMPUTER_BROWSER_TOOLS } from '@agentconnect.md/protocol/computer-browser'
import {
  CHROME_DEVTOOLS_MCP_VERSION,
  chromeChildArgs,
  chromeChildEnv,
  chromeDevtoolsMcpBin,
  contractFromUpstream,
  EXTRA_CHROME_TOOLS,
  upstreamName
} from './chrome-contract.js'

// No browser listens here: listing tools never connects, and the child must start nothing of its own.
const ENDPOINT = { port: 9, path: '/devtools/browser/00000000-0000-4000-8000-000000000000' }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'computer-chrome-contract-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function listTools(args: string[]) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [chromeDevtoolsMcpBin()!, ...args],
    env: chromeChildEnv(dir),
    cwd: dir,
    stderr: 'pipe'
  })
  const client = new Client({ name: 'contract-test', version: '0' })
  await client.connect(transport)
  try {
    return { version: client.getServerVersion()?.version, tools: (await client.listTools()).tools }
  } finally {
    await client.close()
  }
}

// The pinned child against computer-browser-v1: an upgrade that renames or reshapes a tool fails here (§5.8).
describe.skipIf(process.platform === 'win32')('the pinned Chrome DevTools MCP against computer-browser-v1', () => {
  it('is installed at the pinned version, and --version touches no network', () => {
    const bin = chromeDevtoolsMcpBin()
    expect(bin).toBeDefined()
    const out = spawnSync(process.execPath, [bin!, '--version'], { env: chromeChildEnv(dir), encoding: 'utf8' })
    expect(out.stdout.trim()).toBe(CHROME_DEVTOOLS_MCP_VERSION)
    // The update check stamps this file before it fetches the registry; with the variable set it never runs.
    expect(existsSync(join(dir, '.cache', 'chrome-devtools-mcp'))).toBe(false)
  })

  it('serves every v1 tool under the contract’s schema, and only the five known extras besides', async () => {
    // Scripts on, so the list holds all twenty; the daemon's own flags otherwise, since they shape the schemas.
    const args = chromeChildArgs({ endpoint: ENDPOINT, dir, maxImageDimension: 1280, scripts: true })
    const { version, tools } = await listTools(args)
    expect(version).toBe(CHROME_DEVTOOLS_MCP_VERSION)
    const upstream = new Map(tools.map((tool) => [tool.name, tool]))
    const names = COMPUTER_BROWSER_TOOLS.map((tool) => upstreamName(tool.name))
    expect([...upstream.keys()].sort()).toEqual([...names, ...EXTRA_CHROME_TOOLS].sort())
    for (const tool of COMPUTER_BROWSER_TOOLS) {
      const served = upstream.get(upstreamName(tool.name))!
      expect(
        contractFromUpstream(
          {
            name: served.name,
            ...(served.description ? { description: served.description } : {}),
            inputSchema: served.inputSchema as Record<string, unknown>
          },
          names
        )
      ).toEqual({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
    }
  })

  it('drops the script tools under the flags the daemon passes without scripts', async () => {
    const { tools } = await listTools(chromeChildArgs({ endpoint: ENDPOINT, dir, maxImageDimension: 1280 }))
    const names = tools.map((tool) => tool.name)
    expect(names).not.toContain('evaluate_script')
    expect(names).not.toContain('set_logpoints')
    expect(names).toContain('take_snapshot')
    const navigate = tools.find((tool) => tool.name === 'navigate_page')!
    expect(Object.keys((navigate.inputSchema as { properties: object }).properties)).not.toContain('initScript')
  })
})
