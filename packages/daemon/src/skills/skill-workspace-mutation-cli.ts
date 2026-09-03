#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { constants, promises as fsp, type BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

interface PathIdentity {
  dev: string
  ino: string
}

interface FileReceipt {
  path: string
  mode: number
  size: number
  sha256: string
}

interface BundleReceipt {
  treeDigest: string
  files: FileReceipt[]
}

interface ReservationAuthority {
  identity: PathIdentity
  markerIdentity: PathIdentity
}

interface ReserveSpec {
  action: 'reserve'
  cwd: string
  workspaceIdentity: PathIdentity
  relativeRoot: string
  operationId: string
  reservationName: string
  quarantineName: string
  prior?: BundleReceipt & { identity: PathIdentity }
}

interface ApplySpec {
  action: 'apply'
  cwd: string
  workspaceIdentity: PathIdentity
  relativeRoot: string
  operationId: string
  reservationName: string
  quarantineName: string
  reservation?: ReservationAuthority
  prior?: BundleReceipt & { identity: PathIdentity }
  candidate?: BundleReceipt & { sourceDir: string }
}

interface CleanupSpec {
  action: 'cleanup'
  cwd: string
  workspaceIdentity: PathIdentity
  relativeRoot: string
  name: string
  tombstoneName: string
  expected: BundleReceipt & { identity: PathIdentity }
}

interface DiscardSpec {
  action: 'discard'
  cwd: string
  workspaceIdentity: PathIdentity
  relativeRoot: string
  tombstoneName: string
  operationId?: string
  reservationName?: string
  reservation?: ReservationAuthority
  prior?: BundleReceipt & { identity: PathIdentity }
}

interface RestoreSpec {
  action: 'restore'
  cwd: string
  workspaceIdentity: PathIdentity
  relativeRoot: string
  operationId: string
  quarantineName: string
  prior: BundleReceipt & { identity: PathIdentity }
}

interface FinalizeSpec {
  action: 'finalize'
  cwd: string
  workspaceIdentity: PathIdentity
  relativeRoot: string
  operationId: string
  markerIdentity: PathIdentity
  expected: BundleReceipt & { identity: PathIdentity }
}

type MutationSpec = ReserveSpec | ApplySpec | CleanupSpec | DiscardSpec | RestoreSpec | FinalizeSpec

const SAFE_SEGMENT = /^\.?[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/
const SAFE_BUNDLE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/
const RESERVED_FIRST = new Set(['.git', '.agentconnect'])
const SAFE_OPERATION = /^[a-f0-9-]{36}$/
const SAFE_QUARANTINE = /^\.agentconnect-skill-(?:new|old|trash)-[a-f0-9-]{36}$/
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

function fail(message: string): never {
  throw new Error(message)
}

function identity(stat: BigIntStats): PathIdentity {
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function validateIdentity(value: PathIdentity | undefined): asserts value is PathIdentity {
  if (!value || !/^\d+$/.test(value.dev) || !/^\d+$/.test(value.ino)) fail('invalid filesystem identity')
}

function validateReservation(value: ReservationAuthority | undefined): asserts value is ReservationAuthority {
  if (!value) fail('missing skill mutation reservation authority')
  validateIdentity(value.identity)
  validateIdentity(value.markerIdentity)
}

function validateRelativeRoot(value: string): string[] {
  if (isAbsolute(value) || value.includes('\\') || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 1_024) {
    fail('unsafe skill mutation path')
  }
  const parts = value.split('/')
  if (parts.length < 2 || parts.length > 8 || parts.at(-2) !== 'skills' || !SAFE_BUNDLE.test(parts.at(-1)!)) {
    fail('unsafe skill mutation path')
  }
  for (const part of parts.slice(0, -1)) {
    if (part.length > 128 || !SAFE_SEGMENT.test(part)) fail('unsafe skill mutation path')
  }
  if (RESERVED_FIRST.has(parts[0]!.toLowerCase())) fail('reserved skill mutation path')
  return parts
}

function validateReceipt(receipt: BundleReceipt): void {
  if (!/^[a-f0-9]{64}$/.test(receipt.treeDigest) || !Array.isArray(receipt.files) || receipt.files.length === 0) {
    fail('invalid skill mutation receipt')
  }
  let total = 0
  const seen = new Set<string>()
  for (const file of receipt.files) {
    const parts = file.path.split('/')
    if (
      !file.path ||
      isAbsolute(file.path) ||
      file.path.includes('\\') ||
      file.path.includes('\0') ||
      CONTROL_RE.test(file.path) ||
      parts.some((part) => !part || part === '.' || part === '..') ||
      parts.length > 32 ||
      (file.mode !== 0o600 && file.mode !== 0o700) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > 512 * 1024 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      seen.has(file.path)
    ) {
      fail('invalid skill mutation receipt')
    }
    total += file.size
    if (total > 4 * 1024 * 1024) fail('invalid skill mutation receipt')
    seen.add(file.path)
  }
  if (!seen.has('SKILL.md') || digest(receipt.files) !== receipt.treeDigest) fail('invalid skill mutation receipt')
}

function digest(files: FileReceipt[]): string {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex')
}

function under(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function checkedWorkspace(cwdInput: string, expected: PathIdentity): Promise<string> {
  const lexical = await fsp.lstat(cwdInput, { bigint: true })
  if (!lexical.isDirectory() || lexical.isSymbolicLink() || !sameIdentity(identity(lexical), expected)) {
    fail('skill mutation workspace identity changed')
  }
  const cwd = await fsp.realpath(cwdInput)
  const canonical = await fsp.lstat(cwd, { bigint: true })
  if (!canonical.isDirectory() || canonical.isSymbolicLink() || !sameIdentity(identity(canonical), expected)) {
    fail('skill mutation workspace identity changed')
  }
  return cwd
}

async function safeTarget(
  cwdInput: string,
  relativeRoot: string,
  createParents: boolean,
  workspaceIdentity: PathIdentity
): Promise<string> {
  const parts = validateRelativeRoot(relativeRoot)
  const cwd = await checkedWorkspace(cwdInput, workspaceIdentity)
  let parent = cwd
  for (const part of parts.slice(0, -1)) {
    const next = join(parent, part)
    if (createParents) {
      let created = false
      try {
        await fsp.mkdir(next)
        created = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (created) {
        await syncDirectory(next)
        await syncDirectory(parent)
      }
    } else {
      try {
        await fsp.lstat(next)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('skill mutation parent is missing')
        throw error
      }
    }
    const stat = await fsp.lstat(next)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('skill mutation parent is unsafe')
    parent = await fsp.realpath(next)
    if (!under(cwd, parent)) fail('skill mutation parent escapes workspace')
  }
  return join(parent, parts.at(-1)!)
}

/** Resolve a target without creating parents. A missing ancestor proves the
 * target and every journaled sibling artifact are absent; existing ancestors
 * still receive the full no-link containment checks. */
async function safeTargetWhenParentExists(
  cwdInput: string,
  relativeRoot: string,
  workspaceIdentity: PathIdentity
): Promise<string | undefined> {
  const parts = validateRelativeRoot(relativeRoot)
  const cwd = await checkedWorkspace(cwdInput, workspaceIdentity)
  let parent = cwd
  for (const part of parts.slice(0, -1)) {
    const next = join(parent, part)
    let stat
    try {
      stat = await fsp.lstat(next)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('skill mutation parent is unsafe')
    parent = await fsp.realpath(next)
    if (!under(cwd, parent)) fail('skill mutation parent escapes workspace')
  }
  return join(parent, parts.at(-1)!)
}

async function boundedRead(path: string, expected: FileReceipt): Promise<Buffer> {
  const before = await fsp.lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(expected.size)) {
    fail('skill mutation source changed')
  }
  const handle = await fsp.open(path, READ_FLAGS)
  try {
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      !sameIdentity(identity(before), identity(opened)) ||
      opened.size !== BigInt(expected.size)
    ) {
      fail('skill mutation source changed')
    }
    const body = Buffer.alloc(expected.size)
    let offset = 0
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset)
      if (bytesRead === 0) fail('skill mutation source changed')
      offset += bytesRead
    }
    const probe = Buffer.alloc(1)
    if ((await handle.read(probe, 0, 1, offset)).bytesRead !== 0) fail('skill mutation source changed')
    if (createHash('sha256').update(body).digest('hex') !== expected.sha256) fail('skill mutation source changed')
    return body
  } finally {
    await handle.close()
  }
}

async function inspectBundle(
  root: string,
  expected: BundleReceipt,
  operationId?: string,
  markerIdentity?: PathIdentity
): Promise<PathIdentity> {
  validateReceipt(expected)
  const rootStat = await fsp.lstat(root, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('skill mutation bundle root is unsafe')
  const files = new Map(expected.files.map((file) => [file.path, file]))
  const directories = new Set<string>()
  for (const file of expected.files) {
    const parts = file.path.split('/')
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'))
  }
  const seen = new Set<string>()
  let entries = 0
  const walk = async (dir: string, prefix = ''): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      entries += 1
      if (entries > 1_024) fail('skill mutation bundle has too many entries')
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const abs = join(dir, entry.name)
      const stat = await fsp.lstat(abs)
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) fail('skill mutation bundle contains a link')
      if (
        prefix === '' &&
        operationId &&
        rel === `.agentconnect-installing-${operationId}` &&
        (await markerMatches(root, operationId, markerIdentity))
      ) {
        continue
      }
      if (entry.isDirectory() && stat.isDirectory()) {
        if (!directories.has(rel)) fail('skill mutation bundle contains an unexpected directory')
        await walk(abs, rel)
        continue
      }
      const receipt = files.get(rel)
      if (!receipt || !entry.isFile() || !stat.isFile()) fail('skill mutation bundle contains an unexpected entry')
      const body = await boundedRead(abs, receipt)
      const mode = stat.mode & 0o111 ? 0o700 : 0o600
      if (mode !== receipt.mode || body.length !== receipt.size) fail('skill mutation bundle does not match receipt')
      seen.add(rel)
    }
  }
  await walk(root)
  if (seen.size !== files.size) fail('skill mutation bundle is incomplete')
  const rootAfter = await fsp.lstat(root, { bigint: true })
  if (!sameIdentity(identity(rootStat), identity(rootAfter))) fail('skill mutation bundle changed during inspection')
  return identity(rootAfter)
}

async function ensureDirectoryPath(root: string, path: string): Promise<void> {
  let current = root
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part)
    try {
      await fsp.mkdir(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = await fsp.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('skill mutation destination parent is unsafe')
  }
}

function operationMarkerName(operationId: string): string {
  return `.agentconnect-installing-${operationId}`
}

async function reserve(spec: ReserveSpec): Promise<ReservationAuthority> {
  if (
    !SAFE_OPERATION.test(spec.operationId) ||
    !SAFE_QUARANTINE.test(spec.reservationName) ||
    !SAFE_QUARANTINE.test(spec.quarantineName)
  ) {
    fail('invalid reservation operation')
  }
  if (spec.prior) validateReceipt(spec.prior)
  const target = await safeTarget(spec.cwd, spec.relativeRoot, true, spec.workspaceIdentity)
  const quarantine = join(dirname(target), spec.quarantineName)
  try {
    const current = await fsp.lstat(target, { bigint: true })
    if (!spec.prior || !sameIdentity(identity(current), spec.prior.identity)) fail('refusing to replace unowned skill')
    await inspectBundle(target, spec.prior)
    await fsp.rename(target, quarantine)
    await syncParent(quarantine)
    const quarantined = await inspectBundle(quarantine, spec.prior)
    if (!sameIdentity(quarantined, spec.prior.identity)) fail('skill changed while quarantining')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (spec.prior) fail('owned skill disappeared during reservation')
  }

  // mkdir is the atomic no-clobber publication claim. Candidate bytes are
  // populated only after this root + marker identity are fsynced into the
  // external journal, so a concurrent workspace writer can make us fail but
  // can never have its destination replaced by rename().
  await fsp.mkdir(target, { mode: 0o700 })
  const reservationIdentity = identity(await fsp.lstat(target, { bigint: true }))
  const marker = join(target, operationMarkerName(spec.operationId))
  await fsp.mkdir(marker, { mode: 0o700 })
  const markerIdentity = identity(await fsp.lstat(marker, { bigint: true }))
  await syncDirectory(marker)
  await syncDirectory(target)
  await syncParent(target)

  const reservationAfter = identity(await fsp.lstat(target, { bigint: true }))
  if (
    !sameIdentity(reservationIdentity, reservationAfter) ||
    !(await markerMatches(target, spec.operationId, markerIdentity))
  ) {
    fail('skill mutation reservation changed while reserving')
  }
  await checkedWorkspace(spec.cwd, spec.workspaceIdentity)
  return { identity: reservationAfter, markerIdentity }
}

async function populateReservation(
  source: string,
  target: string,
  receipt: BundleReceipt,
  operationId: string,
  authority: ReservationAuthority
): Promise<PathIdentity> {
  validateReceipt(receipt)
  validateReservation(authority)
  await inspectBundle(source, receipt)
  const rootIdentity = identity(await fsp.lstat(target, { bigint: true }))
  if (
    !sameIdentity(rootIdentity, authority.identity) ||
    !(await markerMatches(target, operationId, authority.markerIdentity))
  ) {
    fail('skill mutation reservation authority changed')
  }
  // The in-place mkdir claim is no-clobber but not an atomic directory swap.
  // Keep the runtime's discovery manifest absent until every support file is
  // durable, so a concurrent warm reader sees either no skill or a complete one.
  const publicationOrder = [
    ...receipt.files.filter((file) => file.path !== 'SKILL.md'),
    ...receipt.files.filter((file) => file.path === 'SKILL.md')
  ]
  for (const file of publicationOrder) {
    if (file.path === 'SKILL.md') {
      await syncDirectoryTree(target, {
        ...receipt,
        files: publicationOrder.filter((candidate) => candidate.path !== 'SKILL.md')
      })
    }
    await ensureDirectoryPath(target, file.path)
    const body = await boundedRead(join(source, ...file.path.split('/')), file)
    const output = await fsp.open(join(target, ...file.path.split('/')), WRITE_FLAGS, file.mode)
    try {
      await output.writeFile(body)
      await output.chmod(file.mode)
      await output.sync()
    } finally {
      await output.close()
    }
  }
  const publishedIdentity = await inspectBundle(target, receipt, operationId, authority.markerIdentity)
  if (!sameIdentity(rootIdentity, publishedIdentity)) fail('skill mutation destination was replaced')
  await syncDirectoryTree(target, receipt)
  // The caller may durably commit a ready ledger immediately after this helper
  // returns, so the containing directory entry must reach disk first.
  await syncParent(target)
  return publishedIdentity
}

async function syncDirectoryTree(root: string, receipt: BundleReceipt): Promise<void> {
  if (process.platform === 'win32') return
  const dirs = new Set<string>([root])
  for (const file of receipt.files) {
    let current = dirname(join(root, ...file.path.split('/')))
    while (under(root, current)) {
      dirs.add(current)
      if (current === root) break
      current = dirname(current)
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    const handle = await fsp.open(dir, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fsp.open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncParent(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fsp.open(dirname(path), constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function markerMatches(root: string, operationId: string, expected?: PathIdentity): Promise<boolean> {
  try {
    const marker = join(root, operationMarkerName(operationId))
    const before = await fsp.lstat(marker, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) return false
    const directory = await fsp.opendir(marker)
    try {
      if ((await directory.read()) !== null) return false
    } finally {
      await directory.close()
    }
    const after = await fsp.lstat(marker, { bigint: true })
    const found = identity(after)
    return (
      after.isDirectory() &&
      !after.isSymbolicLink() &&
      sameIdentity(identity(before), found) &&
      (!expected || sameIdentity(found, expected))
    )
  } catch {
    return false
  }
}

async function apply(spec: ApplySpec): Promise<Record<string, PathIdentity | undefined>> {
  if (
    !SAFE_OPERATION.test(spec.operationId) ||
    !SAFE_QUARANTINE.test(spec.reservationName) ||
    !SAFE_QUARANTINE.test(spec.quarantineName)
  ) {
    fail('invalid operation')
  }
  if (spec.prior) validateReceipt(spec.prior)
  if (spec.candidate) {
    validateReceipt(spec.candidate)
    validateReservation(spec.reservation)
    if (spec.prior) fail('candidate prior must be quarantined during reservation')
  } else if (spec.reservation) {
    fail('unexpected reservation authority')
  }
  const target = await safeTarget(spec.cwd, spec.relativeRoot, true, spec.workspaceIdentity)
  const quarantine = join(dirname(target), spec.quarantineName)
  let quarantineIdentity: PathIdentity | undefined
  if (!spec.candidate) {
    try {
      const current = await fsp.lstat(target, { bigint: true })
      if (!spec.prior || !sameIdentity(identity(current), spec.prior.identity))
        fail('refusing to replace unowned skill')
      await inspectBundle(target, spec.prior)
      await fsp.rename(target, quarantine)
      await syncParent(quarantine)
      quarantineIdentity = await inspectBundle(quarantine, spec.prior)
      if (!sameIdentity(quarantineIdentity, spec.prior.identity)) fail('skill changed while quarantining')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (spec.prior) fail('owned skill disappeared during mutation')
    }
  }
  let targetIdentity: PathIdentity | undefined
  if (spec.candidate) {
    const reservationIdentity = await populateReservation(
      spec.candidate.sourceDir,
      target,
      spec.candidate,
      spec.operationId,
      spec.reservation!
    )
    targetIdentity = await inspectBundle(target, spec.candidate, spec.operationId, spec.reservation!.markerIdentity)
    if (!sameIdentity(reservationIdentity, targetIdentity)) fail('skill mutation destination changed while publishing')
  }
  await checkedWorkspace(spec.cwd, spec.workspaceIdentity)
  return { quarantineIdentity, targetIdentity }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fsp.lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function removeExpectedArtifact(
  path: string,
  expected: BundleReceipt & { identity: PathIdentity },
  requireComplete: boolean
): Promise<void> {
  const stat = await fsp.lstat(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(identity(stat), expected.identity)) {
    fail('cleanup target was replaced')
  }
  if (requireComplete) {
    const found = await inspectBundle(path, expected)
    if (!sameIdentity(found, expected.identity)) fail('cleanup target was replaced')
  }
  await fsp.rm(path, { recursive: true, force: false })
  await syncParent(path)
}

/** Before reservation identities are durably journaled, correct code cannot
 * have written a candidate byte. Recovery may therefore remove only the two
 * content-free crash shapes (empty root, or root + empty marker). Anything
 * else could be user/attacker content and fails closed. */
async function removePreByteReservation(path: string, operationId: string): Promise<void> {
  const stat = await fsp.lstat(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('discard reservation is unsafe')
  const entries = await fsp.readdir(path)
  if (entries.length === 0) {
    const after = await fsp.lstat(path, { bigint: true })
    if (!sameIdentity(identity(stat), identity(after))) fail('discard reservation changed')
    await fsp.rmdir(path)
    await syncParent(path)
    return
  }
  if (entries.length !== 1 || entries[0] !== operationMarkerName(operationId)) {
    fail('refusing to discard an unowned reservation')
  }
  if (!(await markerMatches(path, operationId))) fail('discard reservation marker is unsafe')
  const after = await fsp.lstat(path, { bigint: true })
  if (!sameIdentity(identity(stat), identity(after))) fail('discard reservation changed')
  await fsp.rmdir(join(path, operationMarkerName(operationId)))
  await fsp.rmdir(path)
  await syncParent(path)
}

/** Remove a reservation whose root and marker identities were persisted before
 * any candidate byte was permitted. The marker stays until all other entries
 * are gone, so an interrupted deletion remains resumable under the same inode
 * authority. */
async function removeOwnedReservation(
  path: string,
  operationId: string,
  authority: ReservationAuthority
): Promise<void> {
  validateReservation(authority)
  const stat = await fsp.lstat(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(identity(stat), authority.identity)) {
    fail('discard reservation identity changed')
  }
  const markerName = operationMarkerName(operationId)
  if (!(await markerMatches(path, operationId, authority.markerIdentity))) {
    const entries = await fsp.readdir(path)
    if (entries.length === 0) {
      const after = await fsp.lstat(path, { bigint: true })
      if (!sameIdentity(identity(after), authority.identity)) fail('discard reservation identity changed')
      await fsp.rmdir(path)
      await syncParent(path)
      return
    }
    fail('discard reservation marker changed')
  }

  let entries = 0
  const directory = await fsp.opendir(path)
  for await (const entry of directory) {
    entries += 1
    if (entries > 4_096) fail('discard reservation has too many entries')
    if (entry.name === markerName) continue
    const current = await fsp.lstat(path, { bigint: true })
    if (!sameIdentity(identity(current), authority.identity)) fail('discard reservation identity changed')
    await fsp.rm(join(path, entry.name), { recursive: true, force: false })
  }
  await syncDirectory(path)
  const after = await fsp.lstat(path, { bigint: true })
  if (
    !sameIdentity(identity(after), authority.identity) ||
    !(await markerMatches(path, operationId, authority.markerIdentity))
  ) {
    fail('discard reservation authority changed')
  }
  await fsp.rmdir(join(path, markerName))
  const empty = await fsp.readdir(path)
  const finalStat = await fsp.lstat(path, { bigint: true })
  if (empty.length !== 0 || !sameIdentity(identity(finalStat), authority.identity)) {
    fail('discard reservation changed before removal')
  }
  await fsp.rmdir(path)
  await syncParent(path)
}

async function moveAndRemoveOwnedReservation(
  path: string,
  tombstone: string,
  operationId: string,
  authority: ReservationAuthority
): Promise<void> {
  const stat = await fsp.lstat(path, { bigint: true })
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !sameIdentity(identity(stat), authority.identity) ||
    !(await markerMatches(path, operationId, authority.markerIdentity))
  ) {
    fail('discard reservation authority changed')
  }
  if (await pathExists(tombstone)) fail('discard tombstone already exists')
  await fsp.rename(path, tombstone)
  await syncParent(tombstone)
  const moved = await fsp.lstat(tombstone, { bigint: true })
  if (!sameIdentity(identity(moved), authority.identity)) fail('discard reservation changed while moving')
  await removeOwnedReservation(tombstone, operationId, authority)
}

async function cleanup(spec: CleanupSpec): Promise<void> {
  if (!SAFE_QUARANTINE.test(spec.name) || !SAFE_QUARANTINE.test(spec.tombstoneName)) fail('invalid cleanup name')
  const target = await safeTargetWhenParentExists(spec.cwd, spec.relativeRoot, spec.workspaceIdentity)
  if (!target) return
  const quarantine = join(dirname(target), spec.name)
  const tombstone = join(dirname(target), spec.tombstoneName)
  const quarantineExists = await pathExists(quarantine)
  const tombstoneExists = await pathExists(tombstone)
  if (quarantineExists && tombstoneExists) fail('cleanup artifacts conflict')
  if (quarantineExists) {
    const found = await inspectBundle(quarantine, spec.expected)
    if (!sameIdentity(found, spec.expected.identity)) fail('cleanup target was replaced')
    await fsp.rename(quarantine, tombstone)
    await syncParent(tombstone)
    await removeExpectedArtifact(tombstone, spec.expected, true)
  } else if (tombstoneExists) {
    // A prior cleanup may have crashed during recursive removal. The root inode
    // remains the durable authority even when its receipt is now incomplete.
    await removeExpectedArtifact(tombstone, spec.expected, false)
  }
  await checkedWorkspace(spec.cwd, spec.workspaceIdentity)
}

async function discard(spec: DiscardSpec): Promise<void> {
  if (
    !SAFE_QUARANTINE.test(spec.tombstoneName) ||
    (spec.reservationName !== undefined && !SAFE_QUARANTINE.test(spec.reservationName))
  ) {
    fail('invalid discard name')
  }
  if (spec.operationId && !SAFE_OPERATION.test(spec.operationId)) fail('invalid discard operation')
  if (spec.reservation) validateReservation(spec.reservation)
  if (spec.prior) validateReceipt(spec.prior)
  const target = await safeTargetWhenParentExists(spec.cwd, spec.relativeRoot, spec.workspaceIdentity)
  if (!target) return
  const tombstone = join(dirname(target), spec.tombstoneName)

  if (await pathExists(tombstone)) {
    if (!spec.operationId || !spec.reservation) fail('refusing to discard an unknown tombstone')
    await removeOwnedReservation(tombstone, spec.operationId, spec.reservation)
  }
  if (!(await pathExists(target))) return
  const targetStat = await fsp.lstat(target, { bigint: true })
  if (spec.prior && sameIdentity(identity(targetStat), spec.prior.identity)) {
    const found = await inspectBundle(target, spec.prior)
    if (!sameIdentity(found, spec.prior.identity)) fail('prior skill changed during recovery')
    return
  }
  if (!spec.operationId) fail('invalid discard operation')
  if (!spec.reservation) {
    await removePreByteReservation(target, spec.operationId)
    return
  }
  await moveAndRemoveOwnedReservation(target, tombstone, spec.operationId, spec.reservation)
  await checkedWorkspace(spec.cwd, spec.workspaceIdentity)
}

async function restore(spec: RestoreSpec): Promise<PathIdentity> {
  if (!SAFE_OPERATION.test(spec.operationId) || !SAFE_QUARANTINE.test(spec.quarantineName)) fail('invalid restore')
  const target = await safeTarget(spec.cwd, spec.relativeRoot, false, spec.workspaceIdentity)
  const quarantine = join(dirname(target), spec.quarantineName)
  try {
    const live = await inspectBundle(target, spec.prior)
    if (sameIdentity(live, spec.prior.identity)) return live
    fail('restore target was replaced')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // A mutation that failed before quarantining leaves nothing here; say so rather than surfacing a bare ENOENT on a name only this journal knows.
  if (!(await pathExists(quarantine))) fail('no quarantined prior skill to restore')
  const found = await inspectBundle(quarantine, spec.prior)
  if (!sameIdentity(found, spec.prior.identity)) fail('restore source was replaced')
  try {
    await fsp.lstat(target)
    fail('refusing to overwrite content planted during recovery')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await fsp.rename(quarantine, target)
  await syncParent(target)
  const restored = await inspectBundle(target, spec.prior)
  if (!sameIdentity(restored, spec.prior.identity)) fail('restored skill identity changed')
  await checkedWorkspace(spec.cwd, spec.workspaceIdentity)
  return restored
}

async function finalize(spec: FinalizeSpec): Promise<PathIdentity> {
  if (!SAFE_OPERATION.test(spec.operationId)) fail('invalid finalize operation')
  validateIdentity(spec.markerIdentity)
  const target = await safeTarget(spec.cwd, spec.relativeRoot, false, spec.workspaceIdentity)
  const found = await inspectBundle(target, spec.expected, spec.operationId, spec.markerIdentity)
  if (!sameIdentity(found, spec.expected.identity)) fail('finalize target was replaced')
  const marker = join(target, operationMarkerName(spec.operationId))
  if (await markerMatches(target, spec.operationId, spec.markerIdentity)) {
    await fsp.rmdir(marker)
  }
  const finalized = await inspectBundle(target, spec.expected)
  if (!sameIdentity(finalized, spec.expected.identity)) fail('finalized skill identity changed')
  await syncDirectoryTree(target, spec.expected)
  await syncParent(target)
  await checkedWorkspace(spec.cwd, spec.workspaceIdentity)
  return finalized
}

async function main(): Promise<void> {
  const specPath = process.argv[2]
  if (!specPath || !isAbsolute(specPath)) fail('expected an absolute mutation spec path')
  const stat = await fsp.lstat(specPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail('invalid mutation spec')
  const spec = JSON.parse(await fsp.readFile(specPath, 'utf8')) as MutationSpec
  let result: unknown
  if (spec.action === 'reserve') result = await reserve(spec)
  else if (spec.action === 'apply') result = await apply(spec)
  else if (spec.action === 'cleanup') result = await cleanup(spec)
  else if (spec.action === 'discard') result = await discard(spec)
  else if (spec.action === 'restore') result = await restore(spec)
  else if (spec.action === 'finalize') result = await finalize(spec)
  else fail('unknown mutation action')
  process.stdout.write(`${JSON.stringify(result ?? {})}\n`)
}

main().catch((error) => {
  process.stderr.write(`agentconnect skill mutation: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
