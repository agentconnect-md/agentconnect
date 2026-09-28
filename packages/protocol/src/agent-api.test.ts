// A chat API protocol named on a frame a daemon decodes is a string, so a later protocol never fails an older daemon's parse.
import { describe, expect, it } from 'vitest'
import {
  AGENT_API_PROTOCOL_FEATURE,
  AgentApiGateProjections,
  AgentApiProtocol,
  API_AG_UI_V1_FEATURE,
  ApiGateEvaluationsRequest
} from './agent-api.js'
import { RelayWebchatOp } from './frames/relay-daemon.js'

const decisionId = '33333333-3333-4333-8333-333333333333'
const projection = {
  gate: { type: 'gate', decisionId, when: { type: 'boolean', values: [true] } },
  definitions: [
    {
      id: decisionId,
      name: 'On topic',
      providerId: 'typesafe',
      model: 'jev-latest',
      question: { type: 'boolean', instructions: 'Is it about the product?', criteria: { true: 'Yes', false: 'No' } }
    }
  ]
}

describe('chat API protocols on the wire', () => {
  it('lists AG-UI, which alone needs a daemon feature', () => {
    expect(AgentApiProtocol.options).toEqual(['ai-sdk-ui', 'ag-ui'])
    expect(AGENT_API_PROTOCOL_FEATURE).toEqual({ 'ag-ui': API_AG_UI_V1_FEATURE })
  })

  it('decodes a protocol this build does not know in every daemon-bound field', () => {
    expect(AgentApiGateProjections.parse({ 'ag-ui': projection, 'future-protocol': projection })).toHaveProperty(
      'future-protocol'
    )
    expect(
      RelayWebchatOp.parse({ op: 'turn', text: 'hello', user: 'Example user', origin: 'future-protocol' })
    ).toMatchObject({ origin: 'future-protocol' })
    expect(
      ApiGateEvaluationsRequest.parse({ agentId: '11111111-1111-4111-8111-111111111111', protocol: 'future-protocol' })
    ).toMatchObject({ protocol: 'future-protocol', limit: 20 })
  })

  it('still refuses an empty protocol name', () => {
    expect(RelayWebchatOp.safeParse({ op: 'turn', text: 'hello', user: 'Example user', origin: '' }).success).toBe(
      false
    )
  })
})
