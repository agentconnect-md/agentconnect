import { describe, expect, it } from 'vitest'
import { plistPath, servicePlist, startArgs } from './service-macos.js'

describe('macOS LaunchAgent', () => {
  it("runs the store's stable entry inside the app's Node, so an upgrade never replaces what holds the grants", () => {
    const plist = servicePlist(
      [
        '/Users/ada/Applications/AgentConnect Computer.app/Contents/MacOS/agentconnect-computer',
        '/Users/ada/.agentconnect/computer/current/dist/agentconnect-computer.mjs'
      ],
      '/Users/ada/.agentconnect/computer/daemon.log'
    )
    expect(plist).toContain(
      '<key>ProgramArguments</key><array><string>/Users/ada/Applications/AgentConnect Computer.app/Contents/MacOS/agentconnect-computer</string><string>/Users/ada/.agentconnect/computer/current/dist/agentconnect-computer.mjs</string><string>run</string></array>'
    )
    expect(plist).toContain('<key>AssociatedBundleIdentifiers</key><array><string>md.agentconnect.computer</string>')
    expect(plist).toContain('<key>LimitLoadToSessionType</key><string>Aqua</string>')
    expect(plist).toContain('<key>NODE_OPTIONS</key><string></string>')
  })

  it('escapes paths for XML', () => {
    expect(servicePlist(['/a&b/<app>'], '/log')).toContain('<string>/a&amp;b/&lt;app&gt;</string><string>run</string>')
  })

  it('starts a job the menu bar quit, which launchd keeps loaded without a process', () => {
    expect(startArgs({ loaded: true, pid: 42 }, 501)).toBeUndefined()
    expect(startArgs({ loaded: true }, 501)).toEqual(['kickstart', 'gui/501/md.agentconnect.computer'])
    expect(startArgs({ loaded: false }, 501)).toEqual(['bootstrap', 'gui/501', plistPath()])
  })
})
