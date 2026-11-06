// The composer's console commands: webchat never parses `!stop`-style text, so the picker runs each one as a console action.

/** The chat surfaces' control commands that have a console action in webchat. */
export type ControlName = 'stop' | 'model' | 'effort' | 'permission' | 'fast'

/** One value a console command can be set to; `current` marks the session's present setting. */
export interface ControlChoice {
  value: string
  label: string
  current: boolean
}

/** A console command offered in the picker. */
export interface ControlCommand {
  name: ControlName
  /** null runs on pick; a list opens a second level that the typed argument narrows. */
  choices: readonly ControlChoice[] | null
  run: (value: string | null) => void
}

/** Words that reach each command, mirroring the chat surfaces' parser so Slack habits carry over. */
export const CONTROL_WORDS: Readonly<Record<ControlName, readonly string[]>> = {
  stop: ['stop', 'cancel'],
  model: ['model', 'models'],
  effort: ['effort'],
  permission: ['permission', 'permissions', 'perm'],
  fast: ['fast']
}

/** Rank of `query` against `words`: 0 for a prefix, 1 for a substring, null for no match. */
function rankWords(words: readonly string[], query: string): number | null {
  if (!query) return 1
  if (words.some((word) => word.startsWith(query))) return 0
  return words.some((word) => word.includes(query)) ? 1 : null
}

/** The console commands a typed word reaches, prefix matches first, otherwise in the given order. */
export function matchControls(controls: readonly ControlCommand[], query: string): ControlCommand[] {
  const q = query.trim().toLowerCase()
  return controls
    .map((control, index) => ({ control, index, rank: rankWords(CONTROL_WORDS[control.name], q) }))
    .filter((entry): entry is { control: ControlCommand; index: number; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.control)
}

/** The console command a whole typed word names, case-insensitively, or undefined. */
export function resolveControl(controls: readonly ControlCommand[], word: string): ControlCommand | undefined {
  const w = word.toLowerCase()
  return controls.find((control) => CONTROL_WORDS[control.name].includes(w))
}

/** The choices a typed argument reaches by value or label, prefix matches first, otherwise in the given order. */
export function matchChoices(choices: readonly ControlChoice[], arg: string): ControlChoice[] {
  const q = arg.trim().toLowerCase()
  return choices
    .map((choice, index) => ({
      choice,
      index,
      rank: rankWords([choice.value.toLowerCase(), choice.label.toLowerCase()], q)
    }))
    .filter((entry): entry is { choice: ControlChoice; index: number; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.choice)
}

/** A recognized leading command in the draft: its `[start, end)` span, plus an argument hint while no argument is typed. */
export interface CommandHighlight {
  start: number
  end: number
  hint: string | null
}

/** The draft's leading command when it names a console command, or with `/` a skill, so the composer can mark it. */
export function commandHighlight(
  text: string,
  controls: readonly ControlCommand[],
  skills: ReadonlyArray<{ name: string; hint: string | null }>
): CommandHighlight | null {
  const match = /^(\s*)([/!])([^\s/!]+)(?=\s|$)/.exec(text)
  if (!match) return null
  const start = match[1]!.length
  const end = start + 1 + match[3]!.length
  const control = resolveControl(controls, match[3]!)
  const skill = control || match[2] !== '/' ? undefined : skills.find((candidate) => candidate.name === match[3])
  if (!control && !skill) return null
  if (!/^ ?$/.test(text.slice(end))) return { start, end, hint: null }
  const hint = control
    ? control.choices?.length
      ? `[${control.choices.map((choice) => choice.value).join('|')}]`
      : null
    : skill!.hint
  return { start, end, hint: hint || null }
}

/** Fit the command overlay to the textarea's text viewport, scrollbar gutter excluded, so both wrap and scroll alike. */
export function syncCommandMirror(mirror: HTMLElement | null, textarea: HTMLTextAreaElement | null): void {
  if (!mirror || !textarea) return
  mirror.style.width = `${textarea.clientWidth}px`
  mirror.style.height = `${textarea.clientHeight}px`
  mirror.scrollTop = textarea.scrollTop
}

/** The draft once a run command's leading line is consumed: the command never reaches the agent. */
export function draftWithoutCommandLine(text: string, start: number): string {
  const lineEnd = text.indexOf('\n', start)
  return lineEnd === -1 ? text.slice(0, start).trimEnd() : text.slice(0, start) + text.slice(lineEnd + 1)
}
