import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { agentChatUrl, QUICKSTART_TABS, quickstartExamples } from './agent-api'

const CHAT = 'https://relay.example.test/ai-sdk/agents/agent-1/chat'

describe('agentChatUrl', () => {
  it('uses the deployment relay and escapes the agent id', () => {
    expect(agentChatUrl('agent two', 'https://relay.example.test/')).toBe(
      'https://relay.example.test/ai-sdk/agents/agent%20two/chat'
    )
    expect(agentChatUrl('agent')).toBeNull()
  })
})

const files = Object.values(quickstartExamples(CHAT)).flat()

/** An example compiled as its file type would be; syntax errors surface as diagnostics. */
const compile = (file: string, code: string) =>
  ts.transpileModule(code, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  })

describe('quickstartExamples', () => {
  it('offers every tab, each example compiling, and keeps the key out of the browser page', () => {
    const examples = quickstartExamples(CHAT)
    expect(Object.keys(examples)).toEqual([...QUICKSTART_TABS])
    for (const { file, code } of files.filter((f) => /\.tsx?$/.test(f.file))) {
      expect(compile(file, code).diagnostics, file).toEqual([])
    }
    const page = examples.web.find((f) => f.file === 'app/page.tsx')!
    expect(page.code).not.toContain('AGENTCONNECT_API_KEY')
    expect(page.code).toContain('import { useChat } from "@ai-sdk/react"')
    for (const f of [...examples.curl, ...examples.script, examples.web[0]!]) {
      expect(f.code).toContain(CHAT)
      expect(f.code).toContain('AGENTCONNECT_API_KEY')
    }
  })

  it("forwards useChat's request with the key and streams the relay's answer back", async () => {
    const route = quickstartExamples(CHAT).web.find((f) => f.file === 'app/api/chat/route.ts')!
    const exports: { POST?: (req: Request) => Promise<Response> } = {}
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(CHAT)
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer example-key')
      expect(init?.body).toBe('{"id":"chat-1","messages":[]}')
      return new Response('data: {"type":"start"}\n\n', { status: 200 })
    })
    new Function('exports', 'fetch', 'process', compile(route.file, route.code).outputText)(exports, fetch, {
      env: { AGENTCONNECT_API_KEY: 'example-key' }
    })
    const res = await exports.POST!(
      new Request('https://site.example.test/api/chat', { method: 'POST', body: '{"id":"chat-1","messages":[]}' })
    )
    expect(fetch).toHaveBeenCalledOnce()
    expect(res.status).toBe(200)
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    expect(await res.text()).toContain('"type":"start"')
  })
})
