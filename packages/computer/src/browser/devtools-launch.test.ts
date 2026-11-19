import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  awaitDevtoolsState,
  callerArgs,
  clearRemoteDebugging,
  devtoolsFlags,
  devtoolsStatePath,
  isGoogleChrome,
  PORT_FILE,
  readDevtoolsState,
  writeDevtoolsState
} from './devtools-launch.js'
import { chosenBrowser, launchBrowser } from './launcher.js'

const posix = process.platform !== 'win32'
const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-devtools-launch-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the launch state file (computer-use.md §5.8)', () => {
  it('round-trips, and reads anything unclear as the tier off with the mark hidden', () => {
    const dir = temp()
    expect(readDevtoolsState(dir)).toBeUndefined()
    writeDevtoolsState(dir, { tier: true, hideWebdriver: false, egressPort: 41_000 })
    expect(readDevtoolsState(dir)).toEqual({ tier: true, hideWebdriver: false, egressPort: 41_000 })
    if (posix) expect(statSync(devtoolsStatePath(dir)).mode & 0o777).toBe(0o600)
    writeFileSync(devtoolsStatePath(dir), JSON.stringify({ tier: 'yes', egressPort: 70_000 }))
    expect(readDevtoolsState(dir)).toEqual({ tier: false, hideWebdriver: true })
    writeFileSync(devtoolsStatePath(dir), 'not json')
    expect(readDevtoolsState(dir)).toBeUndefined()
  })

  it('waits for a daemon still starting, and gives up as off', async () => {
    const dir = temp()
    setTimeout(() => writeDevtoolsState(dir, { tier: true, hideWebdriver: true }), 60)
    expect(await awaitDevtoolsState(dir, 2000, 10)).toEqual({ tier: true, hideWebdriver: true })
    expect(await awaitDevtoolsState(temp(), 50, 10)).toBeUndefined()
  })
})

describe('the launcher’s flags (computer-use.md §3.10)', () => {
  it('passes the switch with the AutomationControlled flag, which the webdriver choice drops', () => {
    expect(devtoolsFlags({ tier: true, hideWebdriver: true }, true, {})).toEqual([
      '--remote-debugging-port=0',
      '--disable-blink-features=AutomationControlled'
    ])
    expect(devtoolsFlags({ tier: true, hideWebdriver: false }, true, {})).toEqual(['--remote-debugging-port=0'])
  })

  it('never passes the switch with the tier off, without a state, or to a browser that is not Google Chrome', () => {
    expect(devtoolsFlags({ tier: false, hideWebdriver: true }, true, {})).toEqual([])
    expect(devtoolsFlags(undefined, true, {})).toEqual([])
    expect(devtoolsFlags({ tier: true, hideWebdriver: true }, false, {})).toEqual([])
    for (const flags of [
      devtoolsFlags({ tier: true, hideWebdriver: true }, true, {}),
      devtoolsFlags({ tier: true, hideWebdriver: false, egressPort: 41_000 }, true, {})
    ])
      expect(flags.some((flag) => flag.startsWith('--remote-allow-origins'))).toBe(false)
  })

  it("puts the browser behind the daemon's own forwarder without the WebRTC policy, unless a managed pod names one", () => {
    expect(
      devtoolsFlags({ tier: true, hideWebdriver: true, egressPort: 41_000 }, true, { FORM_FILL_PORT: '7682' })
    ).toEqual([
      '--remote-debugging-port=0',
      '--disable-blink-features=AutomationControlled',
      '--proxy-server=http://127.0.0.1:41000',
      '--proxy-bypass-list=<-loopback>;127.0.0.1:7682'
    ])
    expect(
      devtoolsFlags({ tier: true, hideWebdriver: true, egressPort: 41_000 }, true, {
        AGENTCONNECT_EGRESS_PORT: '7691'
      })
    ).toEqual(['--remote-debugging-port=0', '--disable-blink-features=AutomationControlled'])
  })

  it.skipIf(!posix)(
    "knows Google Chrome by the binary or Google's launcher a path resolves to, not by its name",
    () => {
      const dir = temp()
      const google = join(dir, 'usr', 'lib', 'google', 'chrome')
      mkdirSync(google, { recursive: true })
      writeFileSync(join(google, 'chrome'), '')
      // The tail of Google's own launcher script.
      writeFileSync(join(google, 'google-chrome'), '#!/bin/bash\nHERE=x\nexec -a "$0" "$HERE/chrome" "$@"\n')
      // The image's layout: /opt/google links to /usr/lib/google.
      mkdirSync(join(dir, 'opt'))
      symlinkSync(join(dir, 'usr', 'lib', 'google'), join(dir, 'opt', 'google'))
      const chromium = join(dir, 'usr', 'lib', 'chromium', 'chromium')
      mkdirSync(join(chromium, '..'), { recursive: true })
      writeFileSync(chromium, '')
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      symlinkSync(join(dir, 'opt', 'google', 'chrome', 'google-chrome'), join(bin, 'google-chrome-stable'))
      symlinkSync(join(dir, 'opt', 'google', 'chrome', 'chrome'), join(bin, 'x-www-browser'))
      symlinkSync(chromium, join(bin, 'google-chrome'))
      writeFileSync(join(bin, 'google-chrome-beta'), '#!/bin/sh\nexec chromium "$@"\n')
      const dirs = [google, join(dir, 'opt', 'google', 'chrome')]
      expect(isGoogleChrome(join(bin, 'google-chrome-stable'), dirs)).toBe(true)
      expect(isGoogleChrome(join(bin, 'x-www-browser'), dirs)).toBe(true)
      expect(isGoogleChrome(join(google, 'chrome'), dirs)).toBe(true)
      // A link named google-chrome that leads to Chromium, a script of another name, and a missing path.
      expect(isGoogleChrome(join(bin, 'google-chrome'), dirs)).toBe(false)
      expect(isGoogleChrome(join(bin, 'google-chrome-beta'), dirs)).toBe(false)
      expect(isGoogleChrome(chromium, dirs)).toBe(false)
      expect(isGoogleChrome(join(bin, 'missing'), dirs)).toBe(false)
      writeFileSync(join(google, 'google-chrome'), '#!/bin/sh\nexec /usr/lib/chromium/chromium "$@"\n')
      expect(isGoogleChrome(join(bin, 'google-chrome-stable'), dirs)).toBe(false)
    }
  )

  it("drops a caller's single-dash switches too, which Chrome takes on POSIX, and nothing after a bare --", () => {
    expect(
      callerArgs([
        '-remote-allow-origins=https://site.example',
        '-no-proxy-server',
        '-proxy-server=direct://',
        '-x',
        '--',
        '--remote-allow-origins=*'
      ])
    ).toEqual({
      kept: ['-x', '--', '--remote-allow-origins=*'],
      dropped: ['-remote-allow-origins=https://site.example', '-no-proxy-server', '-proxy-server=direct://']
    })
  })

  it("drops a caller's endpoint, origin, proxy and webdriver switches, and keeps the rest", () => {
    expect(
      callerArgs([
        '--remote-debugging-port=9222',
        '--remote-debugging-address=0.0.0.0',
        '--remote-allow-origins=*',
        '--proxy-server=http://203.0.113.5:3128',
        '--proxy-bypass-list=*',
        '--no-proxy-server',
        '--disable-blink-features=Other',
        '--ozone-platform=x11',
        '--no-proxy-serverish',
        'https://example.test/'
      ])
    ).toEqual({
      kept: ['--ozone-platform=x11', '--no-proxy-serverish', 'https://example.test/'],
      dropped: [
        '--remote-debugging-port=9222',
        '--remote-debugging-address=0.0.0.0',
        '--remote-allow-origins=*',
        '--proxy-server=http://203.0.113.5:3128',
        '--proxy-bypass-list=*',
        '--no-proxy-server',
        '--disable-blink-features=Other'
      ]
    })
  })

  it.skipIf(!posix)('takes the browser BROWSER names when it is installed, as the entrypoint does', () => {
    const dir = temp()
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    for (const name of ['google-chrome', 'chromium']) {
      writeFileSync(join(bin, name), '')
      chmodSync(join(bin, name), 0o755)
    }
    const env = { PATH: bin, AGENTCONNECT_COMPUTER_IMAGE: '1' }
    expect(chosenBrowser({ ...env, BROWSER: 'chromium' })).toBe(join(bin, 'chromium'))
    expect(chosenBrowser({ ...env, BROWSER: join(bin, 'chromium') })).toBe(join(bin, 'chromium'))
    expect(chosenBrowser({ ...env, BROWSER: 'firefox' })).toBe(join(bin, 'google-chrome'))
    expect(chosenBrowser({ ...env, BROWSER: 'none' })).toBe(join(bin, 'google-chrome'))
    expect(chosenBrowser(env)).toBe(join(bin, 'google-chrome'))
  })
})

describe('the chrome://inspect checkbox (computer-use.md §3.10)', () => {
  it('removes devtools.remote_debugging from Local State and keeps everything else', () => {
    const dir = temp()
    const path = join(dir, 'Local State')
    const state = {
      os_crypt: { encrypted_key: 'abc' },
      devtools: { remote_debugging: { 'user-enabled': true }, other: 1 },
      profile: { info_cache: { Default: { name: 'Person 1' } } }
    }
    writeFileSync(path, JSON.stringify(state), { mode: 0o600 })
    expect(clearRemoteDebugging(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      os_crypt: { encrypted_key: 'abc' },
      devtools: { other: 1 },
      profile: { info_cache: { Default: { name: 'Person 1' } } }
    })
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(clearRemoteDebugging(path)).toBe(false)
    expect(clearRemoteDebugging(join(dir, 'missing'))).toBe(false)
    writeFileSync(path, '{not json')
    expect(clearRemoteDebugging(path)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('{not json')
  })
})

// A stand-in Google Chrome that records its arguments and exits.
function fakeChrome(dir: string): { path: string; calls: () => string[][] } {
  const log = join(dir, 'calls.log')
  const path = join(dir, 'bin', 'google-chrome')
  mkdirSync(join(dir, 'bin'))
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`)
  chmodSync(path, 0o755)
  const calls = (): string[][] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split(' '))
      : []
  return { path, calls }
}

function profileWithPortFile(dir: string): string {
  const profile = join(dir, 'browser', 'main')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, PORT_FILE), '40000\n/devtools/browser/00000000-0000-4000-8000-000000000001')
  writeFileSync(join(profile, 'Local State'), JSON.stringify({ devtools: { remote_debugging: { x: 1 } }, keep: true }))
  return profile
}

describe('launchBrowser with the tier (computer-use.md §3.10)', () => {
  it.skipIf(!posix)('with the tier on: deletes the old port file, passes the switch and the flag', async () => {
    const dir = temp()
    const chrome = fakeChrome(dir)
    const profile = profileWithPortFile(dir)

    await launchBrowser({
      profile,
      sources: [],
      browser: chrome.path,
      chrome: true,
      devtools: { tier: true, hideWebdriver: true }
    })

    expect(existsSync(join(profile, PORT_FILE))).toBe(false)
    await expect
      .poll(() => chrome.calls()[0])
      .toEqual([
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-crash-restore-bubble',
        '--remote-debugging-port=0',
        '--disable-blink-features=AutomationControlled'
      ])
  })

  it.skipIf(!posix)('with the tier off: no switch, and the saved checkbox setting cleared', async () => {
    const dir = temp()
    const chrome = fakeChrome(dir)
    const profile = profileWithPortFile(dir)

    await launchBrowser({
      profile,
      sources: [],
      browser: chrome.path,
      chrome: true,
      devtools: { tier: false, hideWebdriver: true }
    })

    expect(JSON.parse(readFileSync(join(profile, 'Local State'), 'utf8'))).toEqual({ devtools: {}, keep: true })
    expect(existsSync(join(profile, PORT_FILE))).toBe(false)
    await expect.poll(() => chrome.calls()[0]?.some((flag) => flag.startsWith('--remote-debugging'))).toBe(false)
  })

  it.skipIf(!posix)(
    'clears the saved setting with the tier off, which the image passes when there is no state yet',
    async () => {
      const dir = temp()
      const chrome = fakeChrome(dir)
      const profile = profileWithPortFile(dir)

      await launchBrowser({
        profile,
        sources: [],
        browser: chrome.path,
        chrome: true,
        devtools: { tier: false, hideWebdriver: true }
      })

      expect(JSON.parse(readFileSync(join(profile, 'Local State'), 'utf8'))).toEqual({ devtools: {}, keep: true })
      await expect.poll(() => chrome.calls()[0]).toHaveLength(4)
    }
  )

  it.skipIf(!posix)("drops the caller's launcher-only switches on the image, and logs them", async () => {
    const dir = temp()
    const chrome = fakeChrome(dir)
    const profile = profileWithPortFile(dir)
    const lines: string[] = []

    await launchBrowser({
      profile,
      sources: [],
      browser: chrome.path,
      chrome: true,
      env: { AGENTCONNECT_COMPUTER_IMAGE: '1' },
      args: ['--ozone-platform=x11', '--remote-allow-origins=*', '--proxy-server=direct://', 'https://example.test/'],
      devtools: { tier: true, hideWebdriver: true, egressPort: 41_000 },
      log: (line) => lines.push(line)
    })

    await expect
      .poll(() => chrome.calls()[0])
      .toEqual([
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-crash-restore-bubble',
        '--no-sandbox',
        '--password-store=basic',
        '--remote-debugging-port=0',
        '--disable-blink-features=AutomationControlled',
        '--proxy-server=http://127.0.0.1:41000',
        '--proxy-bypass-list=<-loopback>;127.0.0.1:7682',
        '--ozone-platform=x11',
        'https://example.test/'
      ])
    expect(lines).toContain("browser: dropped the caller's switches --remote-allow-origins=* --proxy-server=direct://")
  })
})
