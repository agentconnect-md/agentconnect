// Minimal leveled logger. The daemon had no logging wired to `logging.level`
// (config parsed it but nothing consumed it), so startup was silent. This gives
// visible, level-gated milestones: agents loaded, runtimes ready, slack connected, …
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 }

export interface Logger {
  trace: (msg: string) => void
  debug: (msg: string) => void
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export function makeLogger(level: LogLevel = 'info'): Logger {
  const threshold = ORDER[level] ?? ORDER.info
  const emit = (lvl: LogLevel, msg: string) => {
    if (ORDER[lvl] < threshold) return
    const line = `[agentconnect] ${lvl.toUpperCase().padEnd(5)} ${msg}`
    if (ORDER[lvl] >= ORDER.warn) console.error(line)
    else console.log(line)
  }
  return {
    trace: (m) => emit('trace', m),
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m)
  }
}
