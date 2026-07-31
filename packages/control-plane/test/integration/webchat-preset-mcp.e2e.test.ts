import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { startWebchatPresetMcpStack, type WebchatPresetMcpStack } from '../harness/webchat-preset-mcp-stack.js'
import { DEFAULT_OWNER_ID, DEFAULT_ORG_ID } from '../../prisma/seed.js'

const kernelDescribe = process.env.AGENTCONNECT_RUN_BWRAP_E2E === '1' ? describe : describe.skip

let stack: WebchatPresetMcpStack | undefined

afterEach(async () => {
  await stack?.close()
  stack = undefined
})

kernelDescribe('preset webchat delegated MCP real-stack E2E', () => {
  it('executes a curated admin write through the isolated ACP host with the webchat owner audit identity', async () => {
    stack = await startWebchatPresetMcpStack(prisma)
    const browser = await stack.openBrowser()

    const listed = await browser.turn('admin:list')
    expect(listed.text).toContain('admin:list:')
    expect(listed.text).toContain('updateAgent')

    const called = await browser.turn(
      `admin:call updateAgent ${JSON.stringify({
        agentId: stack.otherAgentId,
        model: 'delegated-e2e-model'
      })}`
    )
    expect(called.text).toMatch(/^admin:call:updateAgent:/)

    const changed = await prisma.agent.findUniqueOrThrow({ where: { id: stack.otherAgentId } })
    expect(changed.runtimeOverrides).toMatchObject({ model: 'delegated-e2e-model' })

    const nestedList = await browser.turn('admin:call listAgents {}')
    expect(nestedList.text).toContain(stack.otherAgentId)
    expect(nestedList.text).toContain('delegated-e2e-target')

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { kind: 'mcp_tool_call', details: { path: ['tool'], equals: 'updateAgent' } }
    })
    const invocation = await prisma.mcpInvocation.findFirstOrThrow({ where: { toolName: 'updateAgent' } })
    const delegation = await prisma.webchatMcpDelegation.findUniqueOrThrow({
      where: { id: invocation.delegationId }
    })
    expect(invocation).toMatchObject({ status: 'succeeded', responseStatus: 200 })
    expect(delegation).toMatchObject({
      id: invocation.delegationId,
      conversationId: stack.conversationId,
      userId: DEFAULT_OWNER_ID,
      orgId: DEFAULT_ORG_ID,
      agentId: stack.presetAgentId
    })
    expect(audit.actorUserId).toBe(DEFAULT_OWNER_ID)
    expect(audit.orgId).toBe(DEFAULT_ORG_ID)
    expect(audit.details).toMatchObject({
      principalType: 'webchat_assertion',
      invocationId: invocation.id,
      delegationId: invocation.delegationId,
      agentId: stack.presetAgentId,
      conversationId: stack.conversationId,
      tool: 'updateAgent',
      args: { agentId: stack.otherAgentId, model: 'delegated-e2e-model' },
      status: 200
    })

    const visible = `${listed.text}\n${called.text}\n${nestedList.text}`
    for (const secret of stack.secretSentinels) expect(visible).not.toContain(secret)
    for (const secret of stack.secretSentinels) expect(JSON.stringify(audit.details)).not.toContain(secret)
    const invocations = await prisma.mcpInvocation.findMany()
    const invocationMetadata = JSON.stringify(invocations.map(({ responseBytes: _responseBytes, ...row }) => row))
    const invocationBodies = invocations
      .flatMap((row) => (row.responseBytes ? [Buffer.from(row.responseBytes).toString('utf8')] : []))
      .join('\n')
    for (const secret of stack.secretSentinels) expect(invocationMetadata).not.toContain(secret)
    for (const secret of stack.secretSentinels) expect(invocationBodies).not.toContain(secret)
    expect(visible).not.toMatch(/AC_MCP_(?:ENDPOINT|TOKEN)|authorization|assertion/i)
  }, 90_000)

  it('keeps the established relay conversation alive while CP outage narrows only admin tools', async () => {
    stack = await startWebchatPresetMcpStack(prisma)
    const browser = await stack.openBrowser()

    expect((await browser.turn('admin:list')).text).toContain('listAgents')
    await stack.stopControlPlane()

    expect((await browser.turn('echo:still-alive')).text).toBe('echo:still-alive')
    expect((await browser.turn('admin:list')).text).toBe(
      'admin:error:AgentConnect admin tools are temporarily unavailable. Retry shortly.'
    )
    expect((await browser.turn(`admin:call listAgents {}`)).text).toBe(
      'admin:error:AgentConnect admin tools are temporarily unavailable. Retry shortly.'
    )
    expect((await browser.turn('echo:still-open')).text).toBe('echo:still-open')
    expect(browser.isOpen()).toBe(true)
  }, 90_000)
})
