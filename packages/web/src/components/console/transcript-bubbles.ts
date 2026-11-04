// Transcript speech bubbles shared by the session page and a task's dock thread; full literal strings so Tailwind's scanner sees them (STYLE.md §8).

/** An agent's bubble, tinted with the speaker's `--agent-accent`; the indigo fallback keeps a turn with no accent visible. */
export const AGENT_BUBBLE =
  'w-fit max-w-full rounded-[12px_12px_12px_4px] border px-2.5 py-2 font-sans text-[13.5px] font-normal leading-[1.55] text-(--text-primary) desktop:max-w-[calc(100%-35px)] desktop:px-3 desktop:py-[9px] border-[color:color-mix(in_oklab,var(--agent-accent,var(--indigo-500))_var(--bubble-edge),var(--surface-card))] bg-[color:color-mix(in_oklab,var(--agent-accent,var(--indigo-500))_var(--bubble-tint),var(--surface-card))]'

/** The speaking agent's name, its accent pulled 62% toward the text colour so gold or green passes contrast. */
export const AGENT_NAME =
  'font-sans text-[13px] font-semibold leading-normal text-[color:color-mix(in_oklab,var(--agent-accent,var(--indigo-500))_62%,var(--text-primary))]'

/** A person's own bubble: neutral, its tail corner mirrored. */
export const SELF_BUBBLE =
  'max-w-full rounded-[12px_12px_4px_12px] border border-(--bubble-self-edge) bg-(--bubble-self) px-3 py-[9px] font-sans text-[13.5px] font-normal leading-[1.55] text-(--text-primary)'
