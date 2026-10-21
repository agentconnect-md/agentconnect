// X11 local controls (computer-use.md §6): human keyboard and button activity via XInput2 raw events, plus the stop hotkey.
import {
  OP_GET_KEYBOARD_MAPPING,
  OP_GET_MODIFIER_MAPPING,
  OP_GRAB_KEY,
  X11Connection,
  X11Error,
  queryExtension,
  request
} from './x11.js'

const XI_QUERY_VERSION = 47
const XI_SELECT_EVENTS = 46
const XI_QUERY_DEVICE = 48
const XI_ALL_DEVICES = 0
const XI_ALL_MASTER_DEVICES = 1
const XI_HIERARCHY_CHANGED = 11
const XI_RAW_KEY_PRESS = 13
const XI_RAW_BUTTON_PRESS = 15
const KEY_PRESS = 2
const GENERIC_EVENT = 35
const BAD_ACCESS = 10
const NUM_LOCK = 0xff7f
const LOCK_MASK = 2

export const DEFAULT_STOP_HOTKEY = 'Ctrl+Alt+Shift+Escape'

const MODIFIERS: Record<string, number> = {
  shift: 1,
  ctrl: 4,
  control: 4,
  alt: 8,
  super: 64,
  meta: 64,
  win: 64
}

const NAMED_KEYS: Record<string, number> = {
  escape: 0xff1b,
  esc: 0xff1b,
  pause: 0xff13,
  break: 0xff6b,
  scrolllock: 0xff14,
  backspace: 0xff08,
  delete: 0xffff,
  insert: 0xff63,
  home: 0xff50,
  end: 0xff57,
  space: 0x20
}

export interface Hotkey {
  modifiers: number
  keysym: number
  label: string
}

/** Parses `Ctrl+Alt+Shift+Escape`-style specs; a key needs at least one modifier unless it is Pause or Break. */
export function parseHotkey(spec: string): Hotkey | undefined {
  const parts = spec
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  const key = parts.pop()?.toLowerCase()
  if (!key) return undefined
  let modifiers = 0
  for (const part of parts) {
    const mask = MODIFIERS[part.toLowerCase()]
    if (mask === undefined) return undefined
    modifiers |= mask
  }
  let keysym = NAMED_KEYS[key]
  const fn = /^f([1-9]|1\d|2[0-4])$/.exec(key)
  if (keysym === undefined && fn) keysym = 0xffbe + Number(fn[1]) - 1
  if (keysym === undefined && /^[a-z0-9]$/.test(key)) keysym = key.charCodeAt(0)
  if (keysym === undefined) return undefined
  if (modifiers === 0 && keysym !== NAMED_KEYS.pause && keysym !== NAMED_KEYS.break) return undefined
  return { modifiers, keysym, label: spec }
}

/** One XI2 event's type and source device, or undefined for anything that is not an XInput GenericEvent. */
export function decodeXiEvent(event: Buffer, xiOpcode: number): { evtype: number; sourceid: number } | undefined {
  if ((event[0]! & 0x7f) !== GENERIC_EVENT || event[1] !== xiOpcode || event.length < 32) return undefined
  return { evtype: event.readUInt16LE(8), sourceid: event.readUInt16LE(20) }
}

/** XIQueryDevice reply → the ids of XTEST devices, whose events are synthesized (Cua Driver, xdotool), not a person. */
export function xtestDevices(reply: Buffer): Set<number> {
  const ids = new Set<number>()
  const count = reply.readUInt16LE(8)
  let offset = 32
  for (let i = 0; i < count && offset + 12 <= reply.length; i++) {
    const id = reply.readUInt16LE(offset)
    const classes = reply.readUInt16LE(offset + 6)
    const nameLength = reply.readUInt16LE(offset + 8)
    const name = reply.subarray(offset + 12, offset + 12 + nameLength).toString('utf8')
    if (/XTEST/i.test(name)) ids.add(id)
    offset += 12 + nameLength + ((4 - (nameLength % 4)) % 4)
    for (let c = 0; c < classes && offset + 4 <= reply.length; c++) offset += reply.readUInt16LE(offset + 2) * 4
  }
  return ids
}

/** The XISelectEvents mask bytes (one 4-byte unit) for the given event types. */
export function eventMask(...types: number[]): Buffer {
  const mask = Buffer.alloc(4)
  for (const type of types) mask[type >> 3]! |= 1 << (type & 7)
  return mask
}

export interface X11LocalOptions {
  hotkey: Hotkey | undefined
  onHumanInput: () => void
  onStopHotkey: () => void
  log: (line: string) => void
  connect?: () => Promise<X11Connection>
}

export interface X11LocalState {
  // Undefined when keyboard activity is watched; otherwise why it is not.
  keyboardProblem: string | undefined
  // Undefined when the hotkey is grabbed; otherwise why it is not.
  hotkeyProblem: string | undefined
}

// Watches human input and holds the stop hotkey for as long as the X connection lives.
export class X11LocalControls implements X11LocalState {
  keyboardProblem: string | undefined = 'not started'
  hotkeyProblem: string | undefined = 'not started'
  private xiOpcode: number | undefined
  private xtest = new Set<number>()
  private grabbed: { keycode: number; modifiers: number } | undefined
  private lastHotkeyAt = 0
  private closing = false

  private constructor(
    private readonly x: X11Connection,
    private readonly options: X11LocalOptions
  ) {}

  static async start(options: X11LocalOptions): Promise<X11LocalControls> {
    const x = await (options.connect ?? (() => X11Connection.connect()))()
    const controls = new X11LocalControls(x, options)
    x.listen((event) => void controls.onEvent(event))
    x.whenClosed((error) => {
      controls.keyboardProblem = 'the X connection closed'
      controls.hotkeyProblem = 'the X connection closed'
      if (!controls.closing) options.log(`X11 local controls stopped: ${error?.message ?? 'connection closed'}`)
    })
    await controls.watchKeyboard().catch((error: Error) => {
      controls.keyboardProblem = error.message
    })
    await controls.grabHotkey().catch((error: Error) => {
      controls.hotkeyProblem = error.message
    })
    return controls
  }

  close(): void {
    this.closing = true
    this.x.close()
  }

  private async watchKeyboard(): Promise<void> {
    const opcode = await queryExtension(this.x, 'XInputExtension')
    if (opcode === undefined) throw new Error('the X server has no XInput extension')
    const version = Buffer.alloc(4)
    version.writeUInt16LE(2, 0)
    version.writeUInt16LE(2, 2)
    const reply = await this.x.request(request(opcode, XI_QUERY_VERSION, version))
    const major = reply.readUInt16LE(8)
    const minor = reply.readUInt16LE(10)
    // Raw events reach a root-window listener during other clients' grabs only from XI 2.1.
    if (major < 2 || (major === 2 && minor < 1)) throw new Error(`XInput ${major}.${minor} is older than 2.1`)
    this.xiOpcode = opcode
    await this.refreshDevices()
    const select = Buffer.alloc(8 + 2 * 8)
    select.writeUInt32LE(this.x.setup.root, 0)
    select.writeUInt16LE(2, 4)
    select.writeUInt16LE(XI_ALL_MASTER_DEVICES, 8)
    select.writeUInt16LE(1, 10)
    eventMask(XI_RAW_KEY_PRESS, XI_RAW_BUTTON_PRESS).copy(select, 12)
    select.writeUInt16LE(XI_ALL_DEVICES, 16)
    select.writeUInt16LE(1, 18)
    eventMask(XI_HIERARCHY_CHANGED).copy(select, 20)
    await this.x.checked(request(opcode, XI_SELECT_EVENTS, select))
    this.keyboardProblem = undefined
  }

  private async refreshDevices(): Promise<void> {
    const body = Buffer.alloc(4)
    body.writeUInt16LE(XI_ALL_DEVICES, 0)
    this.xtest = xtestDevices(await this.x.request(request(this.xiOpcode!, XI_QUERY_DEVICE, body)))
  }

  private async grabHotkey(): Promise<void> {
    const hotkey = this.options.hotkey
    if (!hotkey) throw new Error('disabled in config')
    const { minKeycode, maxKeycode } = this.x.setup
    const mapping = await this.x.request(
      request(OP_GET_KEYBOARD_MAPPING, 0, Buffer.from([minKeycode, maxKeycode - minKeycode + 1, 0, 0]))
    )
    const keycode = keycodeFor(mapping, minKeycode, hotkey.keysym)
    if (keycode === undefined) throw new Error(`no key on this keyboard produces ${hotkey.label}`)
    const numLock = numLockMask(
      await this.x.request(request(OP_GET_MODIFIER_MAPPING, 0, Buffer.alloc(0))),
      keycodeFor(mapping, minKeycode, NUM_LOCK)
    )
    // The grab must ignore Caps Lock and Num Lock, so it is taken once per combination of them.
    const extras = [0, LOCK_MASK, numLock, LOCK_MASK | numLock].filter((mask, i, all) => all.indexOf(mask) === i)
    try {
      for (const extra of extras) await this.x.checked(grabKey(this.x.setup.root, hotkey.modifiers | extra, keycode))
    } catch (error) {
      if (error instanceof X11Error && error.code === BAD_ACCESS)
        throw new Error(`${hotkey.label} is taken by another app`)
      throw error
    }
    this.grabbed = { keycode, modifiers: hotkey.modifiers }
    this.hotkeyProblem = undefined
  }

  private async onEvent(event: Buffer): Promise<void> {
    const type = event[0]! & 0x7f
    if (type === KEY_PRESS && this.grabbed && event[1] === this.grabbed.keycode) {
      // Holding the keys autorepeats; one press is one Stop.
      const now = Date.now()
      if (now - this.lastHotkeyAt > 1000) this.options.onStopHotkey()
      this.lastHotkeyAt = now
      return
    }
    if (this.xiOpcode === undefined) return
    const xi = decodeXiEvent(event, this.xiOpcode)
    if (!xi) return
    if (xi.evtype === XI_HIERARCHY_CHANGED) {
      await this.refreshDevices().catch(() => undefined)
      return
    }
    if ((xi.evtype === XI_RAW_KEY_PRESS || xi.evtype === XI_RAW_BUTTON_PRESS) && !this.xtest.has(xi.sourceid)) {
      this.options.onHumanInput()
    }
  }
}

/** The first keycode whose keysym list holds the keysym, from a GetKeyboardMapping reply. */
export function keycodeFor(mapping: Buffer, minKeycode: number, keysym: number): number | undefined {
  const perKeycode = mapping[1]!
  const count = perKeycode ? mapping.readUInt32LE(4) / perKeycode : 0
  for (let column = 0; column < perKeycode; column++) {
    for (let i = 0; i < count; i++) {
      if (mapping.readUInt32LE(32 + (i * perKeycode + column) * 4) === keysym) return minKeycode + i
    }
  }
  return undefined
}

/** The modifier bit Num Lock sits on, from a GetModifierMapping reply; 0 when it is unmapped. */
export function numLockMask(modifiers: Buffer, numLockKeycode: number | undefined): number {
  if (numLockKeycode === undefined) return 0
  const perModifier = modifiers[1]!
  for (let modifier = 0; modifier < 8; modifier++) {
    for (let i = 0; i < perModifier; i++) {
      if (modifiers[32 + modifier * perModifier + i] === numLockKeycode) return 1 << modifier
    }
  }
  return 0
}

function grabKey(root: number, modifiers: number, keycode: number): Buffer {
  const body = Buffer.alloc(12)
  body.writeUInt32LE(root, 0)
  body.writeUInt16LE(modifiers, 4)
  body[6] = keycode
  body[7] = 1
  body[8] = 1
  // owner_events = false sits in the request's second byte.
  return request(OP_GRAB_KEY, 0, body)
}
