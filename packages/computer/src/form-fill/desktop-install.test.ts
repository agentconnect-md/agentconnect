import { describe, expect, it } from 'vitest'
import { extensionId, extensionKey } from './package.js'
import {
  configuredFormFillPort,
  DESKTOP_EXTENSION_DIR,
  desktopInstallPlan,
  desktopUninstallCommands,
  detectBrowsers,
  formFillCheck,
  installedExtensionId,
  type ProbeFs
} from './desktop-install.js'

const build = {
  buildId: 'build-a',
  files: { 'manifest.json': '{"manifest_version":3,"version":"2.1.0"}', 'worker.js': '' }
}
const ID = extensionId(extensionKey('build-a'))

function fs(files: Record<string, string>): ProbeFs {
  return { exists: (path) => path in files, read: (path) => files[path] }
}

const policy = (id: string) =>
  JSON.stringify({ ExtensionInstallForcelist: [`${id};file:///opt/agentconnect/form-fill/update.xml`] })

describe('detectBrowsers (computer-form-fill-and-vault.md §8, §11 S6)', () => {
  it('finds system Chromium (Debian or Fedora layout) and Google Chrome with their policy directories', () => {
    expect(detectBrowsers(fs({ '/usr/lib/chromium/chromium': '', '/opt/google/chrome/chrome': '' }))).toEqual([
      { name: 'Chromium', binary: '/usr/lib/chromium/chromium', policyDir: '/etc/chromium/policies/managed' },
      { name: 'Google Chrome', binary: '/opt/google/chrome/chrome', policyDir: '/etc/opt/chrome/policies/managed' }
    ])
    expect(detectBrowsers(fs({ '/usr/lib64/chromium-browser/chromium-browser': '' }))[0]).toMatchObject({
      name: 'Chromium',
      policyDir: '/etc/chromium/policies/managed'
    })
  })

  it('names a snap or Flatpak browser as unsupported instead of writing policy it would not read', () => {
    expect(detectBrowsers(fs({ '/usr/bin/chromium-browser': 'exec /snap/bin/chromium "$@"' }))).toEqual([
      { name: 'Chromium', binary: '/snap/bin/chromium', unsupported: 'the snap package is not supported yet' }
    ])
    expect(detectBrowsers(fs({ '/var/lib/flatpak/app/com.google.Chrome': '' }))).toEqual([
      {
        name: 'Google Chrome',
        binary: 'flatpak:com.google.Chrome',
        unsupported: 'the Flatpak package is not supported yet'
      }
    ])
  })
})

describe('desktopInstallPlan', () => {
  it('stages the CRX, its manifest and one policy per browser, and installs them as root with fixed modes', () => {
    const browsers = detectBrowsers(fs({ '/usr/lib/chromium/chromium': '', '/opt/google/chrome/chrome': '' }))
    const plan = desktopInstallPlan({ build, port: 7682, browsers, stageDir: '/tmp/stage' })
    expect(plan.id).toBe(ID)
    expect(plan.files.map((file) => file.target)).toEqual([
      `${DESKTOP_EXTENSION_DIR}/form-fill.crx`,
      `${DESKTOP_EXTENSION_DIR}/update.xml`,
      '/etc/chromium/policies/managed/agentconnect-form-fill.json',
      '/etc/opt/chrome/policies/managed/agentconnect-form-fill.json'
    ])
    const policy = JSON.parse(String(plan.files[2]!.content)) as Record<string, unknown>
    expect(policy).toEqual({
      ExtensionInstallForcelist: [`${ID};file://${DESKTOP_EXTENSION_DIR}/update.xml`],
      '3rdparty': { extensions: { [ID]: { endpoint: 'ws://127.0.0.1:7682/' } } }
    })
    expect(String(plan.files[1]!.content)).toContain(`codebase='file://${DESKTOP_EXTENSION_DIR}/form-fill.crx'`)
    expect(plan.commands[0]).toEqual([
      'install',
      '-d',
      '-m',
      '0755',
      DESKTOP_EXTENSION_DIR,
      '/etc/chromium/policies/managed',
      '/etc/opt/chrome/policies/managed'
    ])
    expect(plan.commands.slice(1)).toContainEqual([
      'install',
      '-m',
      '0644',
      '/tmp/stage/policy.json',
      '/etc/opt/chrome/policies/managed/agentconnect-form-fill.json'
    ])
    expect(desktopUninstallCommands(browsers)).toEqual([
      [
        'rm',
        '-f',
        '/etc/chromium/policies/managed/agentconnect-form-fill.json',
        '/etc/opt/chrome/policies/managed/agentconnect-form-fill.json'
      ],
      ['rm', '-rf', DESKTOP_EXTENSION_DIR]
    ])
  })
})

describe('formFillCheck', () => {
  const chromium = { '/usr/lib/chromium/chromium': '' }
  const check = (files: Record<string, string>, port: number | 'none' = 7682) =>
    formFillCheck({
      build,
      port: port === 'none' ? undefined : port,
      browsers: detectBrowsers(fs(files)),
      command: 'agentconnect-computer',
      fs: fs(files)
    })

  it('is ok when the installed policy names this build and the daemon serves the endpoint', () => {
    expect(check({ ...chromium, '/etc/chromium/policies/managed/agentconnect-form-fill.json': policy(ID) })).toEqual({
      name: 'form fill',
      status: 'ok',
      detail: 'installed for Chromium on port 7682'
    })
  })

  it('says what to run when it is missing, from another build, or has no endpoint', () => {
    expect(check(chromium)).toMatchObject({ status: 'info', fix: 'run: agentconnect-computer form-fill install' })
    expect(
      check({ ...chromium, '/etc/chromium/policies/managed/agentconnect-form-fill.json': policy('a'.repeat(32)) })
    ).toMatchObject({
      status: 'warn',
      detail: 'Chromium has the extension of another build',
      fix: 'run: agentconnect-computer form-fill install, then restart the browser'
    })
    expect(
      check({ ...chromium, '/etc/chromium/policies/managed/agentconnect-form-fill.json': policy(ID) }, 'none')
    ).toMatchObject({
      status: 'warn'
    })
  })

  it('warns about an unsupported browser and reads a malformed policy as none', () => {
    expect(check({ '/snap/bin/chromium': '' })).toMatchObject({
      status: 'warn',
      detail: 'Chromium: the snap package is not supported yet'
    })
    expect(
      installedExtensionId(
        '/etc/chromium/policies/managed',
        fs({ '/etc/chromium/policies/managed/agentconnect-form-fill.json': '{' })
      )
    ).toBeUndefined()
  })
})

describe('configuredFormFillPort', () => {
  it('takes the config, else the container entrypoint’s FORM_FILL_PORT', () => {
    expect(configuredFormFillPort(7700, { FORM_FILL_PORT: '7682' })).toBe(7700)
    expect(configuredFormFillPort(undefined, { FORM_FILL_PORT: '7682' })).toBe(7682)
    expect(configuredFormFillPort(undefined, { FORM_FILL_PORT: '' })).toBeUndefined()
  })
})
