import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { VM_BIN, VM_IMAGE_DIR, VM_STATE_DIR, resolveVmSettings, vmPreflight } from '../src/vm/settings.js'
import { ByteCountFromEnv, positiveIntFromEnv } from '../src/vm/env.js'

const ROOT = '/var/agentconnect'

describe('resolveVmSettings', () => {
  it('derives every path from the daemon root when the deployment says nothing', () => {
    const settings = resolveVmSettings(ROOT, {})
    expect(settings.imagePath).toBe(join(ROOT, VM_IMAGE_DIR))
    expect(settings.binaryPath).toBe(join(ROOT, VM_BIN))
    expect(settings.statePath).toBe(join(ROOT, VM_STATE_DIR))
    // One vCPU: more guests at one beat fewer at two for work that waits on a network.
    expect(settings.cpuPerVm).toBe(1)
    expect(settings.memoryBytes).toBe(2 * 1024 ** 3)
  })

  it('lets a deployment override the image, helper and sizes', () => {
    const settings = resolveVmSettings(ROOT, {
      AC_VM_IMAGE: '/images/trixie',
      AC_VM_BINARY: '/usr/local/bin/agentconnect-vmm',
      AC_VM_CPUS: '2',
      AC_VM_MEMORY: '4GiB',
      AC_VM_DATA_DISK: '64GiB',
      AC_VM_MAX_GUESTS: '6',
      AC_VM_TOTAL_VCPUS: '12'
    })
    expect(settings.imagePath).toBe('/images/trixie')
    expect(settings.binaryPath).toBe('/usr/local/bin/agentconnect-vmm')
    expect(settings.cpuPerVm).toBe(2)
    expect(settings.memoryBytes).toBe(4 * 1024 ** 3)
    expect(settings.dataDiskBytes).toBe(64 * 1024 ** 3)
    expect(settings.maxConcurrentVms).toBe(6)
    expect(settings.maxTotalVcpus).toBe(12)
  })

  // A mistyped ceiling that reads as "use the default" is how a host ends up oversubscribed
  // with nothing in the log to say why.
  it('refuses a malformed ceiling rather than falling back to the default', () => {
    expect(() => resolveVmSettings(ROOT, { AC_VM_MAX_GUESTS: 'lots' })).toThrow(/AC_VM_MAX_GUESTS/)
    expect(() => resolveVmSettings(ROOT, { AC_VM_CPUS: '0' })).toThrow(/positive integer/)
    expect(() => resolveVmSettings(ROOT, { AC_VM_MEMORY: 'big' })).toThrow(/AC_VM_MEMORY/)
  })
})

describe('env parsers', () => {
  it('reads the same size spellings the helper itself accepts', () => {
    expect(ByteCountFromEnv('2GiB', 'X')).toBe(2 * 1024 ** 3)
    expect(ByteCountFromEnv('2048', 'X')).toBe(2048)
    expect(ByteCountFromEnv('512M', 'X')).toBe(512 * 1024 ** 2)
    expect(ByteCountFromEnv('  1gb ', 'X')).toBe(1000 ** 3)
  })

  it('treats absent and empty alike, so an unset variable is not a zero', () => {
    expect(ByteCountFromEnv(undefined, 'X')).toBeUndefined()
    expect(ByteCountFromEnv('  ', 'X')).toBeUndefined()
    expect(positiveIntFromEnv(undefined, 'X')).toBeUndefined()
    expect(positiveIntFromEnv('', 'X')).toBeUndefined()
  })
})

describe('vmPreflight', () => {
  const settings = resolveVmSettings(ROOT, {})
  const complete = () => true
  const mac = { platform: 'darwin', arch: 'arm64' }

  it('passes on Apple Silicon with a helper and an image present', () => {
    expect(vmPreflight(settings, mac, complete)).toBeUndefined()
  })

  // Fail-closed: degrading to a local child process is agent code on this host with the daemon
  // user's authority, which is the one outcome the mode exists to prevent.
  it('refuses off macOS, and points at what to use instead', () => {
    const refusal = vmPreflight(settings, { platform: 'linux', arch: 'arm64' }, complete)
    expect(refusal).toMatch(/needs macOS/)
    expect(refusal).toMatch(/--k8s/)
  })

  it('refuses on Intel, because the guest image is arm64', () => {
    expect(vmPreflight(settings, { platform: 'darwin', arch: 'x64' }, complete)).toMatch(/Apple Silicon/)
  })

  // The framework reports a missing entitlement as "invalid virtual machine configuration", so an
  // unbuilt helper has to be named here or the operator debugs the wrong thing.
  it('names the build command when the helper is missing', () => {
    const refusal = vmPreflight(settings, mac, (path) => !path.endsWith('agentconnect-vmm'))
    expect(refusal).toMatch(/make -C packages\/vmm build/)
  })

  it('names the missing image file and how to build one', () => {
    const refusal = vmPreflight(settings, mac, (path) => !path.endsWith('disk.img'))
    expect(refusal).toMatch(/disk\.img/)
    expect(refusal).toMatch(/make -C packages\/vmm image/)
  })
})
