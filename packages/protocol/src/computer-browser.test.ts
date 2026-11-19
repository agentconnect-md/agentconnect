import { describe, expect, it } from 'vitest'
import { COMPUTER_BROWSER_TOOL_PREFIX, COMPUTER_BROWSER_TOOLS, computerBrowserTool } from './computer-browser.js'
import { ComputerChannelTokenClaims } from './computer-channel-token.js'

const READS = [
  'chrome_list_pages',
  'chrome_take_snapshot',
  'chrome_take_screenshot',
  'chrome_wait_for',
  'chrome_list_console_messages',
  'chrome_get_console_message'
]

describe('computer-browser-v1 (computer-use.md §5.8)', () => {
  it('names twenty prefixed tools, and only the reading ones go without the lease', () => {
    expect(COMPUTER_BROWSER_TOOLS).toHaveLength(20)
    expect(new Set(COMPUTER_BROWSER_TOOLS.map((tool) => tool.name)).size).toBe(20)
    for (const tool of COMPUTER_BROWSER_TOOLS) expect(tool.name.startsWith(COMPUTER_BROWSER_TOOL_PREFIX)).toBe(true)
    expect(COMPUTER_BROWSER_TOOLS.filter((tool) => !tool.lease).map((tool) => tool.name)).toEqual(READS)
    expect(computerBrowserTool('chrome_upload_file')?.requires).toBe('files')
    expect(computerBrowserTool('chrome_evaluate_script')?.requires).toBe('shell')
    expect(computerBrowserTool('chrome_lighthouse_audit')).toBeUndefined()
  })

  it('takes page ids as strings everywhere but the two tools that take none, and no file or script arguments', () => {
    for (const tool of COMPUTER_BROWSER_TOOLS) {
      const { properties, required = [] } = tool.inputSchema
      if (tool.name === 'chrome_list_pages' || tool.name === 'chrome_new_page') {
        expect(properties.pageId).toBeUndefined()
      } else {
        expect(properties.pageId?.type).toBe('string')
        expect(required).toContain('pageId')
      }
      for (const stripped of ['filePath', 'sourcePath', 'isolatedContext', 'initScript'])
        expect(properties[stripped]).toBeUndefined()
      expect(tool.inputSchema.additionalProperties).toBe(false)
    }
  })

  it('keeps the tier in an mcp token, and an older token without it reads as off', () => {
    const mcp = {
      aud: 'mcp',
      cmp: '00000000-0000-4000-8000-000000000001',
      kid: 'k',
      iat: 1,
      exp: 2,
      ses: 's',
      agt: '00000000-0000-4000-8000-000000000002',
      mode: 'control'
    }
    expect(ComputerChannelTokenClaims.parse({ ...mcp, br: true })).toMatchObject({ br: true })
    expect(ComputerChannelTokenClaims.parse(mcp)).not.toHaveProperty('br')
  })
})
