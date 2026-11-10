// The slice of the extension APIs the worker uses (Chromium MV3), so no @types package is needed.
declare namespace chrome {
  namespace runtime {
    const id: string
    function getManifest(): { version: string }
    const onStartup: { addListener(listener: () => void): void }
    const onInstalled: { addListener(listener: () => void): void }
  }
  namespace tabs {
    interface Tab {
      id?: number
      url?: string
      title?: string
    }
    function query(query: { active: boolean; lastFocusedWindow: boolean }): Promise<Tab[]>
  }
  namespace scripting {
    interface InjectionResult<T> {
      frameId: number
      documentId: string
      result?: T
    }
    function executeScript<A extends unknown[], T>(injection: {
      target: { tabId: number; allFrames?: boolean; frameIds?: number[]; documentIds?: string[] }
      func: (...args: A) => T
      args?: A
    }): Promise<InjectionResult<Awaited<T>>[]>
  }
  namespace webNavigation {
    interface Frame {
      url: string
      documentId: string
    }
    function getFrame(details: { tabId: number; frameId: number }): Promise<Frame | null>
    interface Event<T> {
      addListener(listener: (details: T) => void): void
      removeListener(listener: (details: T) => void): void
    }
    const onBeforeNavigate: Event<{ tabId: number; frameId: number }>
    const onCommitted: Event<{ tabId: number; frameId: number }>
  }
  namespace storage {
    const managed: { get(keys: string | string[]): Promise<Record<string, unknown>> }
    const onChanged: { addListener(listener: (changes: Record<string, unknown>, area: string) => void): void }
  }
  namespace alarms {
    function create(name: string, info: { periodInMinutes: number }): Promise<void> | void
    const onAlarm: { addListener(listener: (alarm: { name: string }) => void): void }
  }
}
