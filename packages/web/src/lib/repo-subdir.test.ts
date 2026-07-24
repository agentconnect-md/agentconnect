import { describe, expect, it } from 'vitest'
import { AgentDirValidationError, agentDirInputValue, normalizeAgentDir } from './repo-subdir'

describe('normalizeAgentDir', () => {
  it.each([undefined, null, '', '  ', '/', '.', './'])('maps root sentinel %j to repository root', (value) => {
    expect(normalizeAgentDir(value)).toBeUndefined()
  })

  it('normalizes one leading ./ for API payloads', () => {
    expect(normalizeAgentDir(' ./services/api ')).toBe('services/api')
  })

  it.each(['/tmp', 'C:/tmp', 'services\\api', '../api', 'services/../api', 'services//api'])(
    'rejects unsafe path %j',
    (value) => {
      expect(() => normalizeAgentDir(value)).toThrow(AgentDirValidationError)
    }
  )
})

describe('agentDirInputValue', () => {
  it.each([undefined, '', ' ', '/', '.', './'])('renders root sentinel %j as a blank input', (value) => {
    expect(agentDirInputValue(value)).toBe('')
  })

  it('keeps a historical invalid non-root value visible for correction', () => {
    expect(agentDirInputValue('../legacy')).toBe('../legacy')
  })
})
