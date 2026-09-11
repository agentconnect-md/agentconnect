// The ask mechanism (#1965 Gap A) ships with NO product call site — the tools that ask land in the
// changes that follow it. So the seam is driven end to end by a bridge tool that exists only here:
// a real dispatch through `executeTool`, a real `AskRequired`, and real observable work to assert
// the asking round did not do. `vi.mock` is how it reaches the ask port `McpControlServer` injects
// per call, which is the thing under test — a port the test fabricated would prove nothing.
// `askHost` comes from its own module, never through the mocked `ops.js` barrel: this file is
// imported from inside that mock's factory, so a runtime edge back into it would deadlock.
import { askHost } from '../src/mcp/ask.js'
import type { OpsDeps, SessionContext } from '../src/mcp/ops.js'
import { obj, type ToolDescriptor } from '../src/tool-schema/descriptor.js'

/** The test-only tool's name, and the key its one question travels under. */
export const ASK_STUB_TOOL = 'testAskWhichBot'
export const ASK_STUB_KEY = `${ASK_STUB_TOOL}.integrationId`

/** The ids the stub offers; the first is the guess it keeps when the host cannot be asked. */
export const ASK_STUB_IDS = ['int-a', 'int-b']

/** Advertised like any other tool, so a real `tools/list` over the bridge carries it. */
export const askStubDescriptor: ToolDescriptor = {
  name: ASK_STUB_TOOL,
  description: 'Test-only: asks the agent host which of this agent’s bots to post as.',
  inputSchema: obj({ channel: { type: 'string' }, message: { type: 'string' } }, ['channel', 'message'])
}

/** The stub's body, shaped like the tools that will use this seam: ask FIRST, keep the first
 *  candidate when the connection cannot ask, refuse a decline with a repairable error, accept only
 *  an OFFERED id back, and only then do the observable work — a post through the chosen gateway. */
export async function askStubTool(ctx: SessionContext, args: Record<string, unknown>, deps: OpsDeps): Promise<unknown> {
  const repair = `pass \`integrationId\` explicitly (one of: ${ASK_STUB_IDS.join(', ')})`
  const asked = askHost(deps.ask, ASK_STUB_KEY, {
    message: `This agent has ${ASK_STUB_IDS.length} integrations and none of them owns this conversation. Which one should send the message?`,
    fields: {
      integrationId: {
        kind: 'choice',
        title: 'Integration',
        description: 'The bot this message is sent from.',
        options: ASK_STUB_IDS.map((value) => ({ value }))
      }
    },
    required: ['integrationId']
  })
  if (asked.state === 'refused') throw new Error(`${ASK_STUB_TOOL}: no integration was chosen — ${repair}.`)
  let picked = ASK_STUB_IDS[0]!
  if (asked.state === 'answered') {
    const chosen = asked.content.integrationId
    // The answer comes from the host, so it is untrusted input: only an OFFERED id is accepted.
    if (typeof chosen !== 'string' || !ASK_STUB_IDS.includes(chosen)) {
      throw new Error(`${ASK_STUB_TOOL}: the answer named no known integration — ${repair}.`)
    }
    picked = chosen
  }
  const gw = deps.gatewayFor(picked)
  if (!gw) throw new Error(`no live connection for integration ${picked}`)
  await gw.postMessage(String(args.channel), String(args.message), undefined, { agentAuthorId: ctx.agentId })
  return { integrationId: picked }
}

/** The `vi.mock` factory body: everything the real ops module exports, with the stub routed through
 *  the REAL `executeTool` as an evaluation tool so it meets the same turn gate a product tool does. */
export function opsWithAskStub(actual: typeof import('../src/mcp/ops.js')): typeof import('../src/mcp/ops.js') {
  const executeTool: typeof actual.executeTool = (ctx, name, args, deps) =>
    name === ASK_STUB_TOOL
      ? actual.executeTool(ctx, name, args, {
          ...deps,
          evaluationTool: async (c, n, a) => (n === name ? { result: await askStubTool(c, a, deps) } : undefined)
        })
      : actual.executeTool(ctx, name, args, deps)
  return { ...actual, executeTool }
}
