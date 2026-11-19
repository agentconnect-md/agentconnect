// A stand-in for Chrome DevTools MCP over stdio: its state file says what it lists and does, its log what it was asked.
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateFile = process.argv[2]
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'))
const log = (entry) => appendFileSync(`${stateFile}.log`, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => /^(HOME|TMPDIR|PATH|CHROME_DEVTOOLS_MCP_\w+)$/.test(name))
)
log({ event: 'start', argv: process.argv.slice(3), env, cwd: process.cwd() })

// Every child numbers its pages from its own base, as the real one's numbers change with every child.
const initial = read()
const base = (initial.starts ?? 0) * 10 + 1
writeFileSync(stateFile, JSON.stringify({ ...initial, starts: (initial.starts ?? 0) + 1 }))

const TOOLS = [
  'list_pages',
  'take_snapshot',
  'take_screenshot',
  'wait_for',
  'list_console_messages',
  'get_console_message',
  'get_css_styles',
  'lighthouse_audit',
  'screencast_start',
  'screencast_stop',
  'set_logpoints'
]
const text = (value) => ({ content: [{ type: 'text', text: value }] })
const pageOf = (args) => {
  const page = read().pages[Number(args.pageId) - base]
  if (!page) throw new Error(`No page found with id ${args.pageId}`)
  return page
}

function handle(name, args) {
  const state = read()
  if (state.hang?.includes(name)) return new Promise(() => undefined)
  if (name === 'list_pages') {
    return {
      ...text('## Pages'),
      structuredContent: { pages: state.pages.map((page, index) => ({ ...page, id: base + index })) }
    }
  }
  if (name === 'take_snapshot') {
    const page = pageOf(args)
    return text(
      `uid=1_0 RootWebArea "${page.title}" url="${page.url}"\nuid=1_1 link "${state.leak ?? ''}"\ndebugger at ws://127.0.0.1:9/devtools/page/${state.leak ?? 'X'}`
    )
  }
  if (name === 'take_screenshot') {
    pageOf(args)
    if (state.screenshot) {
      const path = join(mkdtempSync(join(tmpdir(), 'chrome-devtools-mcp-')), 'screenshot.jpeg')
      writeFileSync(path, state.screenshot === 'oversized' ? Buffer.alloc(5_000_001) : Buffer.from('big jpeg'))
      return text(`Took a screenshot of the current page's viewport.\nSaved screenshot to ${path}.`)
    }
    return {
      content: [
        { type: 'text', text: "Took a screenshot of the current page's viewport." },
        { type: 'image', data: Buffer.from('jpeg').toString('base64'), mimeType: 'image/jpeg' }
      ]
    }
  }
  if (name === 'wait_for') return text(`Element matching ${JSON.stringify(args.text)} found.`)
  return text(`${name} ok`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim()) void dispatch(JSON.parse(line))
  }
})
process.stdin.on('end', () => process.exit(0))

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

async function dispatch(message) {
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    if (initial.startupDelayMs) await new Promise((resolve) => setTimeout(resolve, initial.startupDelayMs))
    return send({
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake_chrome_devtools', version: '0.0.0' }
      }
    })
  }
  if (message.method === 'tools/list')
    return send({
      id: message.id,
      result: { tools: TOOLS.map((name) => ({ name, inputSchema: { type: 'object', properties: {} } })) }
    })
  if (message.method === 'tools/call') {
    const { name, arguments: args = {} } = message.params
    log({ event: 'call', name, args })
    try {
      return send({ id: message.id, result: await handle(name, args) })
    } catch (error) {
      return send({ id: message.id, result: { ...text(error.message), isError: true } })
    }
  }
  return send({ id: message.id, result: {} })
}
