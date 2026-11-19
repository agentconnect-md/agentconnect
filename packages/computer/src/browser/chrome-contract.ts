// Adapts `computer-browser-v1` to the pinned Chrome DevTools MCP child: its command, flags, names and arguments (computer-use.md §5.8).
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMPUTER_BROWSER_TOOL_PREFIX,
  type ComputerBrowserInputSchema
} from '@agentconnect.md/protocol/computer-browser'
import type { DevtoolsEndpoint } from './devtools-endpoint.js'

/** The version the image installs and the contract test checks; an upgrade reruns that test before it lands. */
export const CHROME_DEVTOOLS_MCP_VERSION = '1.13.0'

const BIN = join('out', 'Default', 'gen', 'src', 'bin', 'chrome-devtools-mcp.js')

// Arguments that name a file the child would read or write, open a context outside the profile, or run a script.
export const STRIPPED_CHROME_ARGS = ['filePath', 'sourcePath', 'isolatedContext', 'initScript']

// Its tools outside the contract that the categories it keeps still serve; never offered, refused on every call.
export const EXTRA_CHROME_TOOLS = [
  'get_css_styles',
  'lighthouse_audit',
  'screencast_start',
  'screencast_stop',
  'set_logpoints'
]

/** The child's entry script: beside the bundle in the image, else the workspace's pinned dev dependency. */
export function chromeDevtoolsMcpBin(): string | undefined {
  const beside = join(dirname(fileURLToPath(import.meta.url)), 'chrome-devtools-mcp', BIN)
  if (existsSync(beside)) return beside
  try {
    const manifest = createRequire(import.meta.url).resolve('chrome-devtools-mcp/package.json')
    const bin = join(dirname(manifest), BIN)
    return existsSync(bin) ? bin : undefined
  } catch {
    return undefined
  }
}

/** The upstream name behind a v1 tool. */
export const upstreamName = (name: string): string => name.slice(COMPUTER_BROWSER_TOOL_PREFIX.length)

/** The flags of §5.8: the checked endpoint, nothing reported or fetched, the four categories off, no files, JPEG under a cap. */
export function chromeChildArgs(options: {
  endpoint: DevtoolsEndpoint
  // Its own empty directory, the only filesystem root it gets.
  dir: string
  maxImageDimension: number
  scripts?: boolean
  fileRoots?: string[]
}): string[] {
  const { endpoint, dir, maxImageDimension, fileRoots } = options
  return [
    '--wsEndpoint',
    `ws://127.0.0.1:${endpoint.port}${endpoint.path}`,
    '--no-usage-statistics',
    '--no-performance-crux',
    '--no-category-emulation',
    '--no-category-performance',
    '--no-category-network',
    '--no-category-memory',
    '--no-file-navigations',
    '--experimental-structured-content',
    ...(options.scripts ? [] : ['--no-javascript-evaluation']),
    '--screenshotFormat',
    'jpeg',
    '--screenshotMaxWidth',
    String(maxImageDimension),
    // A full page keeps four screens' height before it is scaled down; past 2 MB the child writes a file (§5.8).
    '--screenshotMaxHeight',
    String(maxImageDimension * 4),
    ...(fileRoots?.length ? fileRoots : [dir]).flatMap((root) => ['--filesystemRoot', root])
  ]
}

/** Its whole environment: a home and TMPDIR of its own, no update check, no statistics, no config file found. */
export function chromeChildEnv(dir: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    PATH: base.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: dir,
    TMPDIR: dir,
    LANG: 'C.UTF-8',
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
    CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: '1'
  }
}

/** A call's arguments as the child gets them: stripped of the removed ones; the page id is translated by the caller. */
export function upstreamArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args }
  for (const name of STRIPPED_CHROME_ARGS) delete out[name]
  return out
}

// Upstream tool names that a description mentions, prefixed as the contract's are.
function renamed(text: string, names: string[]): string {
  let out = text
  for (const name of names) {
    out = name.includes('_')
      ? out.replace(new RegExp(`\\b${name}\\b`, 'g'), `${COMPUTER_BROWSER_TOOL_PREFIX}${name}`)
      : out.replace(new RegExp(`\\b${name}(?=\\(\\))`, 'g'), `${COMPUTER_BROWSER_TOOL_PREFIX}${name}`)
  }
  return out
}

/** The v1 form of one upstream tool, for the contract test: the adapter's whole reshaping of names and schemas. */
export function contractFromUpstream(
  tool: { name: string; description?: string; inputSchema: Record<string, unknown> },
  names: string[]
): { name: string; description: string; inputSchema: ComputerBrowserInputSchema } {
  const {
    $schema: _schema,
    properties = {},
    required,
    ...rest
  } = tool.inputSchema as Record<string, unknown> & {
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
  const kept: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (STRIPPED_CHROME_ARGS.includes(key)) continue
    const property: Record<string, unknown> = key === 'pageId' ? { ...value, type: 'string' } : { ...value }
    if (typeof property.description === 'string') property.description = renamed(property.description, names)
    kept[key] = property
  }
  const requiredKept = required?.filter((key) => !STRIPPED_CHROME_ARGS.includes(key))
  return {
    name: `${COMPUTER_BROWSER_TOOL_PREFIX}${tool.name}`,
    description: renamed(tool.description ?? '', names),
    inputSchema: {
      ...(rest as { type: 'object'; additionalProperties: false }),
      properties: kept,
      ...(requiredKept ? { required: requiredKept } : {})
    }
  }
}

/** The audit's arguments: an address reduced to its origin (§5.8); typed text is reduced later, as for computer_*. */
export function chromeAuditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out = upstreamArgs(args)
  for (const field of ['text', 'value', 'promptText']) {
    const value = out[field]
    if (typeof value === 'string') out[field] = `<${value.length} chars>`
  }
  if (Array.isArray(out.elements))
    out.elements = out.elements.flatMap((element: { uid?: string; value?: string } | null) =>
      element && typeof element.uid === 'string'
        ? [
            {
              uid: element.uid,
              ...(typeof element.value === 'string' ? { value: `<${element.value.length} chars>` } : {})
            }
          ]
        : []
    )
  if (typeof out.url === 'string') {
    try {
      const url = new URL(out.url)
      out.url = url.origin === 'null' ? url.protocol : url.origin
      if (url.protocol === 'javascript:') out.script = url.href
    } catch {
      out.url = '[invalid]'
    }
  }
  return out
}
