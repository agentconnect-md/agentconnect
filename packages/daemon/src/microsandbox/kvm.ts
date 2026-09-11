import { closeSync, constants, openSync, readFileSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'

export const KVM_DEVICE = '/dev/kvm'

/** What THIS PROCESS reaches — a group added after it started is in the user database but not in it. */
export interface KvmObservation {
  errorCode?: string
  username: string
  uid: number
  group?: { gid: number; name?: string; heldByProcess: boolean; heldByUser: boolean }
}

/** The operator-facing sentence a failed observation earns, or undefined when KVM is reachable. */
export function kvmPreflightFailure(observation: KvmObservation): string | undefined {
  const { errorCode, username, uid, group } = observation
  if (!errorCode) return undefined
  const head = `microsandbox requires KVM, but this daemon cannot open ${KVM_DEVICE}`
  if (errorCode === 'ENOENT') {
    return `${head}: the device is absent — enable hardware virtualization on this host, or nested virtualization when the host is itself a virtual machine`
  }
  if (errorCode !== 'EACCES' && errorCode !== 'EPERM') return `${head} (${errorCode})`
  // The process already holds the device's group, so membership is not what is denying it.
  if (!group || group.heldByProcess) {
    return `${head}: permission denied (${errorCode}) — check the device's owner, mode and ACL`
  }
  const name = group.name ?? String(group.gid)
  if (group.heldByUser) {
    return `${head}: user "${username}" is a member of group "${name}" but this process is not, so the membership postdates the process — restart the login session that owns the daemon (for the installed user service, "systemctl restart user@${uid}.service"), not just the service`
  }
  return `${head}: add user "${username}" to group "${name}" ("usermod -aG ${name} ${username}"), then start the daemon from a new login session`
}

/** Opens the device the way the guest will — O_RDWR, as this process, now. */
export function observeKvm(): KvmObservation {
  const { username, uid } = userInfo()
  try {
    closeSync(openSync(KVM_DEVICE, constants.O_RDWR))
    return { username, uid }
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code ?? 'unknown'
    const group = errorCode === 'EACCES' || errorCode === 'EPERM' ? deviceGroup(username) : undefined
    return { errorCode, username, uid, ...(group ? { group } : {}) }
  }
}

export function assertKvmAvailable(observe: () => KvmObservation = observeKvm): void {
  const failure = kvmPreflightFailure(observe())
  if (failure) throw new Error(failure)
}

function deviceGroup(username: string): KvmObservation['group'] {
  let gid: number
  try {
    gid = statSync(KVM_DEVICE).gid
  } catch {
    return undefined
  }
  const held = new Set([...(process.getgroups?.() ?? []), ...(process.getgid ? [process.getgid()] : [])])
  const heldByProcess = held.has(gid)
  const entry = groupEntry(gid)
  // A primary group lists no members, but then the process carries it and the question is moot.
  return {
    gid,
    ...(entry ? { name: entry.name } : {}),
    heldByProcess,
    heldByUser: heldByProcess || !!entry?.members.includes(username)
  }
}

function groupEntry(gid: number): { name: string; members: string[] } | undefined {
  let file: string
  try {
    file = readFileSync('/etc/group', 'utf8')
  } catch {
    return undefined
  }
  for (const line of file.split('\n')) {
    const [name, , id, members] = line.split(':')
    if (name && id && Number(id) === gid) return { name, members: (members ?? '').split(',').filter(Boolean) }
  }
  return undefined
}
