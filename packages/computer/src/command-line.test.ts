import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COMPUTER_APPROVAL_META_KEY,
  computerAuditArgs,
  type ComputerFilesMode,
  type ComputerShellMode
} from '@agentconnect.md/protocol/computer'
import { auditSinks, redactArgs, type AuditRecord } from './audit.js'
import { CommandLine, commandEnv, commandLineSupported, narrowedCommandLine } from './command-line.js'
import { Computer, type ToolOutput } from './computer.js'
import { startHttpServer, type RunningHttpServer } from './http-server.js'
import type { McpPrincipal } from './mcp-access.js'
import { FakeDriver, testConfig } from './testing.js'
import { createComputerMcpServer } from './tools.js'

const posix = process.platform !== 'win32'
const AGENT = '00000000-0000-4000-8000-0000000000cc'

let root: string
let home: string
let data: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'computer-command-line-'))
  home = join(root, 'home')
  data = join(home, '.agentconnect', 'computer')
  mkdirSync(data, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function runner(overrides: Partial<ConstructorParameters<typeof CommandLine>[0]> = {}) {
  const records: AuditRecord[] = []
  const line = new CommandLine({
    audit: (record) => records.push(record),
    dataDir: data,
    home,
    shell: '/bin/sh',
    env: { PATH: process.env.PATH, HOME: home, AGENTCONNECT_REGISTER_TOKEN: 'secret' },
    ...overrides
  })
  return { line, records }
}

const json = (output: ToolOutput): Record<string, unknown> =>
  JSON.parse(output.content.find((block) => block.type === 'text')!.text!) as Record<string, unknown>

describe.skipIf(!posix)('the command-line tier', () => {
  it('runs a command in the home directory and returns its exit code and output', async () => {
    const { line, records } = runner()
    const output = await line.exec('a/s', { command: 'pwd; echo err >&2; exit 3' })
    expect(output.isError).toBeUndefined()
    expect(json(output)).toMatchObject({ exitCode: 3, stdout: `${home}\n`, stderr: 'err\n', truncated: false })
    expect(records.at(-1)).toMatchObject({
      tool: 'computer_exec',
      outcome: 'ok',
      args: { command: 'pwd; echo err >&2; exit 3', exitCode: 3, outputBytes: home.length + 5 }
    })
    expect(JSON.stringify(records)).not.toContain(`${home}\n`)
  })

  it('hides the daemon’s own settings from a command', async () => {
    const { line } = runner()
    expect(json(await line.exec('a/s', { command: 'env' })).stdout).not.toContain('AGENTCONNECT_')
    expect(commandEnv({ AGENTCONNECT_X: '1', DISPLAY: ':0' })).toEqual({ DISPLAY: ':0' })
  })

  it('keeps only the tail of a long output and says how much there was', async () => {
    const { line } = runner()
    const result = json(await line.exec('a/s', { command: "head -c 100000 /dev/zero | tr '\\0' a" }))
    expect(result).toMatchObject({ truncated: true, stdoutBytes: 100_000 })
    expect((result.stdout as string).length).toBe(32 * 1024)
  })

  it('kills a command and everything it started when it runs past its timeout', async () => {
    const { line } = runner()
    const marker = join(root, 'survived')
    const output = await line.exec('a/s', { command: `(sleep 1; touch ${marker}) & sleep 30`, timeoutMs: 200 })
    expect(json(output)).toMatchObject({ error: 'timeout', timedOut: true, signal: 'SIGKILL' })
    await new Promise((resolve) => setTimeout(resolve, 1300))
    expect(() => statSync(marker)).toThrow()
  })

  it('kills a background child at the timeout even after its shell exited', async () => {
    const { line } = runner()
    const started = Date.now()
    const output = await line.exec('a/s', { command: 'sleep 30 &', timeoutMs: 200 })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(json(output)).toMatchObject({ error: 'timeout', timedOut: true })
    expect(line.runningCount()).toBe(0)
  })

  it('stops a background child on halt after its shell exited', async () => {
    const owner: { stop?: string } = {}
    const { line } = runner({ halted: () => owner.stop })
    const started = Date.now()
    const running = line.exec('a/s', { command: 'sleep 30 &' })
    await new Promise((resolve) => setTimeout(resolve, 150))
    owner.stop = 'emergency stop'
    line.halt(owner.stop)
    await running
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(line.runningCount()).toBe(0)
  })

  it('ends whatever a finished command left running in its group', async () => {
    const { line } = runner()
    const marker = join(root, 'leftover')
    const output = await line.exec('a/s', { command: `(sleep 1; touch ${marker}) >/dev/null 2>&1 &` })
    expect(json(output)).toMatchObject({ exitCode: 0 })
    await new Promise((resolve) => setTimeout(resolve, 1300))
    expect(() => statSync(marker)).toThrow()
  })

  it('kills running commands when the owner stops agents, and refuses new ones until resumed', async () => {
    let halted: string | undefined
    const { line } = runner({ halted: () => halted })
    const running = line.exec('a/s', { command: 'sleep 30' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(line.runningCount()).toBe(1)
    halted = 'emergency stop'
    line.halt(halted)
    expect(json(await running)).toMatchObject({ error: 'human_in_control', signal: 'SIGKILL' })
    expect(json(await line.exec('a/s', { command: 'true' }))).toMatchObject({ error: 'human_in_control' })
    halted = undefined
    expect((await line.exec('a/s', { command: 'true' })).isError).toBeUndefined()
  })

  it('refuses every call while the Control Plane’s authority is missing', async () => {
    const { line } = runner({ refusal: () => 'computer revoked' })
    expect(json(await line.exec('a/s', { command: 'true' }))).toMatchObject({ error: 'unavailable' })
    expect(json(await line.listDir('a/s', { path: '~' }))).toMatchObject({ error: 'unavailable' })
  })

  it('caps how many commands one session runs at once', async () => {
    const { line } = runner()
    const long = Array.from({ length: 4 }, () => line.exec('a/s', { command: 'sleep 1' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(json(await line.exec('a/s', { command: 'true' }))).toMatchObject({ error: 'exec_busy' })
    expect((await line.exec('b/s', { command: 'true' })).isError).toBeUndefined()
    line.halt('test over')
    await Promise.all(long)
  })

  it('fences the file tools to the roots, never the data directory, and resolves symlinks first', async () => {
    const { line } = runner()
    mkdirSync(join(home, 'docs'))
    writeFileSync(join(root, 'outside.txt'), 'secret')
    symlinkSync(join(root, 'outside.txt'), join(home, 'docs', 'link.txt'))
    await expect(line.fenced('docs/a.txt', undefined)).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(line.fenced(join(data, 'config.json'), undefined)).rejects.toMatchObject({ code: 'path_refused' })
    await expect(line.fenced('~/docs/link.txt', undefined)).rejects.toMatchObject({ code: 'path_refused' })
    await expect(line.fenced(join(root, 'outside.txt'), undefined)).rejects.toMatchObject({ code: 'path_refused' })
    await expect(line.fenced('~/docs/new.txt', undefined)).resolves.toBe(join(home, 'docs', 'new.txt'))
    await expect(line.fenced(join(root, 'outside.txt'), [root])).resolves.toBe(join(root, 'outside.txt'))
    await expect(line.fenced('~/docs/a.txt', [join(root, 'elsewhere')])).rejects.toMatchObject({
      code: 'path_refused'
    })
    expect(json(await line.listDir('a/s', { path: '~' }))).toMatchObject({ path: home })
  })

  it('reads text by lines, an image as an image, and refuses a binary file', async () => {
    const { line } = runner()
    writeFileSync(join(home, 'a.txt'), 'one\ntwo\nthree\nfour')
    expect(json(await line.readFile('a/s', { path: '~/a.txt', offset: 2, limit: 2 }))).toMatchObject({
      fromLine: 2,
      lines: 2,
      truncated: true,
      content: 'two\nthree'
    })
    writeFileSync(join(home, 'p.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const image = await line.readFile('a/s', { path: '~/p.png' })
    expect(image.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'iVBORw==' })
    writeFileSync(join(home, 'b.bin'), Buffer.from([1, 0, 2]))
    expect(json(await line.readFile('a/s', { path: '~/b.bin' }))).toMatchObject({ error: 'binary_file' })
    expect(json(await line.readFile('a/s', { path: '~/none.txt' }))).toMatchObject({ error: 'not_found' })
  })

  it('writes a file whole, keeps its mode, and audits the size and hash, never the content', async () => {
    const { line, records } = runner()
    const path = join(home, 'notes.txt')
    writeFileSync(path, 'old', { mode: 0o600 })
    const result = json(await line.writeFile('a/s', { path: '~/notes.txt', content: 'new text' }))
    expect(result).toMatchObject({ path, bytes: 8, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(readFileSync(path, 'utf8')).toBe('new text')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const audited = records.at(-1)!
    expect(audited).toMatchObject({ tool: 'computer_write_file', args: { bytes: 8, sha256: result.sha256 } })
    expect(redactArgs(audited.args).content).toBe('<8 chars>')
    expect(computerAuditArgs(audited.args)).toMatchObject({ textLength: 8 })
    expect(JSON.stringify(computerAuditArgs(audited.args))).not.toContain('new text')
    expect(json(await line.writeFile('a/s', { path: '~/missing/x.txt', content: 'x' }))).toMatchObject({
      error: 'not_found'
    })
  })

  it('narrows a token by the pushed policy, where an unset field reads off', () => {
    const on = { shell: 'on', files: 'read-write' } as const
    expect(narrowedCommandLine(on, undefined)).toEqual(on)
    expect(narrowedCommandLine(on, { agentMode: 'control' })).toEqual({ shell: 'off', files: 'off' })
    expect(narrowedCommandLine(on, { agentMode: 'control', shell: 'ask', files: 'read' })).toEqual({
      shell: 'ask',
      files: 'read'
    })
    expect(narrowedCommandLine(on, { agentMode: 'view', shell: 'off', files: 'read' })).toEqual({
      shell: 'off',
      files: 'read'
    })
    expect(
      narrowedCommandLine({ shell: 'ask', files: 'off' }, { agentMode: 'control', shell: 'on', files: 'read' })
    ).toEqual({ shell: 'ask', files: 'off' })
  })

  it('runs only on Linux for now', () => {
    expect(commandLineSupported('linux')).toBe(true)
    expect(commandLineSupported('darwin')).toBe(false)
    expect(commandLineSupported('win32')).toBe(false)
  })
})

describe('pausing and taking over', () => {
  it('halts the command line on an owner pause or a lost authority, never on a viewer takeover', () => {
    const halts: string[] = []
    const computer = new Computer({ driver: new FakeDriver(), config: testConfig(), onHalt: (r) => halts.push(r) })
    computer.takeOver('console:u1')
    expect(computer.haltReason()).toBeUndefined()
    expect(halts).toEqual([])
    computer.handBack('console:u1')
    computer.pause('emergency stop')
    expect(computer.haltReason()).toBe('emergency stop')
    computer.resume()
    computer.suspend('computer revoked')
    expect(halts).toEqual(['emergency stop', 'computer revoked'])
  })
})

let running: RunningHttpServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

describe.skipIf(!posix)('the command-line tools over MCP', () => {
  async function start(shell: ComputerShellMode, files: ComputerFilesMode) {
    const records: AuditRecord[] = []
    const config = testConfig({ actionScreenshot: false })
    const computer = new Computer({ driver: new FakeDriver(), config })
    const line = new CommandLine({
      audit: auditSinks((r) => records.push(r)),
      dataDir: data,
      home,
      shell: '/bin/sh'
    })
    let policy = { shell, files }
    const principal: McpPrincipal = {
      client: `${AGENT}/sess-1`,
      viewOnly: false,
      agent: { agentId: AGENT, sessionId: 'sess-1' }
    }
    running = await startHttpServer({
      host: config.host,
      port: 0,
      computer,
      authenticate: () => principal,
      createMcpServer: ({ client, agent }) =>
        createComputerMcpServer({
          computer,
          client,
          ...(agent ? { agent } : {}),
          commandLine: { runner: line, shell: () => policy.shell, files: () => policy.files, roots: () => undefined }
        }),
      log: () => undefined
    })
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)))
    return { client, records, narrow: (next: typeof policy) => (policy = next) }
  }
  const text = (result: unknown) =>
    JSON.parse((result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>

  it('offers only the tools the tier allows', async () => {
    const { client } = await start('off', 'read')
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['computer_read_file', 'computer_list_dir']))
    expect(names).not.toContain('computer_exec')
    expect(names).not.toContain('computer_write_file')
    await client.close()
  })

  it('runs a command under ask only with a person’s approval on the call, and audits it', async () => {
    const { client, records } = await start('ask', 'off')
    expect(text(await client.callTool({ name: 'computer_exec', arguments: { command: 'echo hi' } }))).toMatchObject({
      error: 'approval_required'
    })
    const allowed = await client.callTool({
      name: 'computer_exec',
      arguments: { command: 'echo hi' },
      _meta: { [COMPUTER_APPROVAL_META_KEY]: 'allowed' }
    })
    expect(text(allowed)).toMatchObject({ exitCode: 0, stdout: 'hi\n' })
    expect(records.at(-1)).toMatchObject({ tool: 'computer_exec', agentId: AGENT, approval: 'allowed' })
    await client.close()
  })

  it('drops the tools a narrowed policy no longer allows from the next request', async () => {
    const { client, narrow } = await start('on', 'read-write')
    narrow({ shell: 'off', files: 'read' })
    await expect(client.callTool({ name: 'computer_exec', arguments: { command: 'true' } })).rejects.toThrow(
      /not found/
    )
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).not.toContain('computer_write_file')
    expect(names).toContain('computer_read_file')
    await client.close()
  })
})
