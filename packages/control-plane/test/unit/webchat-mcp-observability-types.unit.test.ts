import { expect, it } from 'vitest'
import type { ControlPlaneMcpRequestStage } from '../../src/observability/webchat-mcp.js'

const onlyNestedRest: [ControlPlaneMcpRequestStage] extends ['nested_rest'] ? true : false = true

it('exposes nested REST as the only Control Plane request-duration stage', () => {
  expect(onlyNestedRest).toBe(true)
})
