// The Linux local indicator (computer-use.md §6): a StatusNotifierItem with a dbusmenu that can Stop agents.
import { DBusConnection, DBusError, Variant, type Message } from './dbus.js'

const ITEM_PATH = '/StatusNotifierItem'
const MENU_PATH = '/MenuBar'
const ITEM_IFACE = 'org.kde.StatusNotifierItem'
const MENU_IFACE = 'com.canonical.dbusmenu'
const PROPS_IFACE = 'org.freedesktop.DBus.Properties'
const WATCHER = 'org.kde.StatusNotifierWatcher'
const BUS = { destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus' }

export type TrayTone = 'online' | 'busy' | 'paused' | 'unavailable'

export interface TrayState {
  tone: TrayTone
  // The indicator's status line, e.g. "controlled by claude-code".
  status: string
  // Only a pause the owner made locally may be lifted from the tray; a console Stop or viewer takeover may not.
  canResume: boolean
  // Whether Stop can still change anything; a viewer takeover counts, since the owner outranks the viewer.
  canStop: boolean
}

export interface TrayOptions {
  onStop: () => void
  onResume: () => void
  hotkeyLabel?: string
  log: (line: string) => void
  connect?: () => Promise<DBusConnection>
}

const MENU = { status: 1, separator: 2, stop: 3, resume: 4 }
const COLORS: Record<TrayTone, [number, number, number]> = {
  online: [0x2e, 0x9d, 0x57],
  busy: [0xe8, 0x8a, 0x10],
  paused: [0xd6, 0x45, 0x45],
  unavailable: [0x8a, 0x8a, 0x8a]
}

/** An ARGB32 (network byte order) disc in the tone's color; paused draws two white bars on it. */
export function iconPixels(tone: TrayTone, size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4)
  const [r, g, b] = COLORS[tone]
  const center = (size - 1) / 2
  const radius = size * 0.44
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - center, y - center)
      const alpha = Math.max(0, Math.min(1, radius - distance + 0.5))
      if (alpha === 0) continue
      const bar = tone === 'paused' && Math.abs(Math.abs(x - center) - size * 0.13) < size * 0.07
      const inBar = bar && Math.abs(y - center) < size * 0.22
      const offset = (y * size + x) * 4
      pixels[offset] = Math.round(alpha * 255)
      pixels[offset + 1] = inBar ? 255 : r
      pixels[offset + 2] = inBar ? 255 : g
      pixels[offset + 3] = inBar ? 255 : b
    }
  }
  return pixels
}

// dbusmenu reads a single underscore as a mnemonic marker.
const menuLabel = (text: string): string => text.replace(/_/g, '__')

const INTROSPECTION = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
 <interface name="org.kde.StatusNotifierItem">
  <property name="Category" type="s" access="read"/><property name="Id" type="s" access="read"/>
  <property name="Title" type="s" access="read"/><property name="Status" type="s" access="read"/>
  <property name="WindowId" type="i" access="read"/><property name="IconName" type="s" access="read"/>
  <property name="IconPixmap" type="a(iiay)" access="read"/><property name="AttentionIconName" type="s" access="read"/>
  <property name="ToolTip" type="(sa(iiay)ss)" access="read"/><property name="ItemIsMenu" type="b" access="read"/>
  <property name="Menu" type="o" access="read"/>
  <method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
  <signal name="NewTitle"/><signal name="NewIcon"/><signal name="NewToolTip"/>
  <signal name="NewStatus"><arg type="s"/></signal>
 </interface>
 <interface name="com.canonical.dbusmenu">
  <property name="Version" type="u" access="read"/><property name="TextDirection" type="s" access="read"/>
  <property name="Status" type="s" access="read"/><property name="IconThemePath" type="as" access="read"/>
  <method name="GetLayout"><arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="as" direction="in"/><arg type="u" direction="out"/><arg type="(ia{sv}av)" direction="out"/></method>
  <method name="GetGroupProperties"><arg type="ai" direction="in"/><arg type="as" direction="in"/><arg type="a(ia{sv})" direction="out"/></method>
  <method name="GetProperty"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
  <method name="Event"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="in"/><arg type="u" direction="in"/></method>
  <method name="EventGroup"><arg type="a(isvu)" direction="in"/><arg type="ai" direction="out"/></method>
  <method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
  <method name="AboutToShowGroup"><arg type="ai" direction="in"/><arg type="ai" direction="out"/><arg type="ai" direction="out"/></method>
  <signal name="ItemsPropertiesUpdated"><arg type="a(ia{sv})"/><arg type="a(ias)"/></signal>
  <signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal>
 </interface>
</node>`

type Props = [string, Variant][]

// Registers with the session's StatusNotifierWatcher and keeps the icon, tooltip and menu in step with the Computer.
export class Tray {
  // Undefined while a tray shows the icon; otherwise why it cannot.
  problem: string | undefined = 'not started'
  private state: TrayState = { tone: 'online', status: 'online', canResume: false, canStop: true }
  private revision = 1
  private readonly name: string

  private constructor(
    private readonly bus: DBusConnection,
    private readonly options: TrayOptions
  ) {
    this.name = `org.kde.StatusNotifierItem-${process.pid}-1`
  }

  static async start(options: TrayOptions): Promise<Tray> {
    const bus = await (options.connect ?? (() => DBusConnection.session()))()
    const tray = new Tray(bus, options)
    bus.serve((message) => tray.handle(message))
    bus.onSignal((message) => tray.onSignal(message))
    bus.onClose(() => {
      tray.problem = 'the session bus closed'
      options.log('tray stopped: the session bus closed')
    })
    await bus.call({ ...BUS, member: 'RequestName', signature: 'su', body: [tray.name, 4] })
    await bus.call({
      ...BUS,
      member: 'AddMatch',
      signature: 's',
      body: [
        `type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${WATCHER}'`
      ]
    })
    await tray.register()
    return tray
  }

  update(state: TrayState): void {
    const before = this.state
    this.state = state
    if (before.tone !== state.tone) this.emit('NewIcon')
    if (before.status !== state.status) {
      this.emit('NewToolTip')
      this.emit('NewTitle')
    }
    if (
      before.tone !== state.tone ||
      before.status !== state.status ||
      before.canResume !== state.canResume ||
      before.canStop !== state.canStop
    ) {
      this.revision++
      this.bus.emit({
        path: MENU_PATH,
        interface: MENU_IFACE,
        member: 'LayoutUpdated',
        signature: 'ui',
        body: [this.revision, 0]
      })
    }
  }

  close(): void {
    this.bus.close()
  }

  private async register(): Promise<void> {
    try {
      await this.bus.call({
        destination: WATCHER,
        path: '/StatusNotifierWatcher',
        interface: WATCHER,
        member: 'RegisterStatusNotifierItem',
        signature: 's',
        body: [this.name]
      })
      this.problem = undefined
    } catch (error) {
      this.problem =
        error instanceof DBusError && /ServiceUnknown|NameHasNoOwner/.test(error.errorName)
          ? 'no system tray in this session (no StatusNotifierWatcher)'
          : `the tray refused the icon: ${(error as Error).message}`
      this.options.log(`tray: ${this.problem}`)
    }
  }

  private onSignal(message: Message): void {
    if (message.member !== 'NameOwnerChanged' || message.body[0] !== WATCHER) return
    // A panel restart brings a new watcher, which knows nothing of the icon until it registers again.
    if (message.body[2]) void this.register()
    else this.problem = 'the system tray went away'
  }

  private emit(member: string): void {
    this.bus.emit({ path: ITEM_PATH, interface: ITEM_IFACE, member })
  }

  private title(): string {
    return `AgentConnect Desktop: ${this.state.status}`
  }

  private itemProps(): Props {
    const pixmaps = [22, 44].map((size) => [size, size, iconPixels(this.state.tone, size)])
    return [
      ['Category', new Variant('s', 'ApplicationStatus')],
      ['Id', new Variant('s', 'agentconnect-desktop')],
      ['Title', new Variant('s', this.title())],
      ['Status', new Variant('s', 'Active')],
      ['WindowId', new Variant('i', 0)],
      ['IconName', new Variant('s', '')],
      ['IconPixmap', new Variant('a(iiay)', pixmaps)],
      ['OverlayIconName', new Variant('s', '')],
      ['AttentionIconName', new Variant('s', '')],
      ['ToolTip', new Variant('(sa(iiay)ss)', ['', pixmaps, 'AgentConnect Desktop', this.state.status])],
      ['ItemIsMenu', new Variant('b', true)],
      ['Menu', new Variant('o', MENU_PATH)]
    ]
  }

  private menuProps(): Props {
    return [
      ['Version', new Variant('u', 3)],
      ['TextDirection', new Variant('s', 'ltr')],
      ['Status', new Variant('s', 'normal')],
      ['IconThemePath', new Variant('as', [])]
    ]
  }

  /** The menu's items by id; the tray never offers a control that loosens a pause it did not make (§6). */
  menuItems(): Map<number, Props> {
    const hotkey = this.options.hotkeyLabel ? ` (${this.options.hotkeyLabel})` : ''
    return new Map<number, Props>([
      [0, [['children-display', new Variant('s', 'submenu')]]],
      [
        MENU.status,
        [
          ['label', new Variant('s', menuLabel(`Agents: ${this.state.status}`))],
          ['enabled', new Variant('b', false)]
        ]
      ],
      [MENU.separator, [['type', new Variant('s', 'separator')]]],
      [
        MENU.stop,
        [
          ['label', new Variant('s', `Stop all agent input${hotkey}`)],
          ['enabled', new Variant('b', this.state.canStop)]
        ]
      ],
      [
        MENU.resume,
        [
          ['label', new Variant('s', 'Resume agent input')],
          ['visible', new Variant('b', this.state.canResume)]
        ]
      ]
    ])
  }

  private layout(id: number, depth: number): unknown[] {
    const items = this.menuItems()
    const children =
      id === 0 && depth !== 0
        ? [...items.keys()].filter((key) => key !== 0).map((key) => new Variant('(ia{sv}av)', this.layout(key, 0)))
        : []
    return [id, items.get(id) ?? [], children]
  }

  private clicked(id: number): void {
    if (id === MENU.stop) this.options.onStop()
    // Agents send no input while paused, so none can reach this item (computer-use.md §6).
    if (id === MENU.resume && this.state.canResume) this.options.onResume()
  }

  private properties(path: string | undefined, iface: string): Props | undefined {
    if (path === ITEM_PATH && iface === ITEM_IFACE) return this.itemProps()
    if (path === MENU_PATH && iface === MENU_IFACE) return this.menuProps()
    return undefined
  }

  handle(message: Message): { signature: string; body: unknown[] } | undefined {
    const { path, member } = message
    const args = message.body
    if (message.interface === 'org.freedesktop.DBus.Introspectable' && member === 'Introspect') {
      return { signature: 's', body: [INTROSPECTION] }
    }
    if (message.interface === 'org.freedesktop.DBus.Peer' && member === 'Ping') return { signature: '', body: [] }
    if (message.interface === PROPS_IFACE) {
      const props = this.properties(path, String(args[0]))
      if (!props) return undefined
      if (member === 'GetAll') return { signature: 'a{sv}', body: [props] }
      if (member === 'Get') {
        const found = props.find(([name]) => name === args[1])
        if (!found) throw new DBusError('org.freedesktop.DBus.Error.UnknownProperty', String(args[1]))
        return { signature: 'v', body: [found[1]] }
      }
      return undefined
    }
    if (path === ITEM_PATH && (message.interface === ITEM_IFACE || !message.interface)) {
      // Clicks open the menu (ItemIsMenu); nothing happens without a menu choice.
      if (['Activate', 'SecondaryActivate', 'ContextMenu', 'Scroll'].includes(member ?? ''))
        return { signature: '', body: [] }
      return undefined
    }
    if (path !== MENU_PATH || (message.interface && message.interface !== MENU_IFACE)) return undefined
    switch (member) {
      case 'GetLayout':
        return { signature: 'u(ia{sv}av)', body: [this.revision, this.layout(Number(args[0]), Number(args[1]))] }
      case 'GetGroupProperties': {
        const items = this.menuItems()
        const ids = (args[0] as number[]).length ? (args[0] as number[]) : [...items.keys()]
        return {
          signature: 'a(ia{sv})',
          body: [ids.filter((id) => items.has(id)).map((id) => [id, items.get(id)])]
        }
      }
      case 'GetProperty': {
        const found = this.menuItems()
          .get(Number(args[0]))
          ?.find(([name]) => name === args[1])
        if (!found) throw new DBusError('org.freedesktop.DBus.Error.InvalidArgs', 'no such menu property')
        return { signature: 'v', body: [found[1]] }
      }
      case 'Event':
        if (args[1] === 'clicked') this.clicked(Number(args[0]))
        return { signature: '', body: [] }
      case 'EventGroup':
        for (const [id, event] of args[0] as [number, string][]) if (event === 'clicked') this.clicked(id)
        return { signature: 'ai', body: [[]] }
      case 'AboutToShow':
        return { signature: 'b', body: [false] }
      case 'AboutToShowGroup':
        return { signature: 'aiai', body: [[], []] }
      default:
        return undefined
    }
  }
}
