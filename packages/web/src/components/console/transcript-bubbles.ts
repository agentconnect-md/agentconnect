// Transcript turn styles shared by the session page and a task's dock thread; full literal strings so Tailwind's scanner sees them (STYLE.md §8).

/** One block of an agent's answer, as prose inside its bubble. */
export const AGENT_PROSE =
  'min-w-0 max-w-full break-words font-sans text-[14px] font-normal leading-[1.6] text-(--text-primary)'

/** An agent's message: everyone else's neutral bubble, as wide at most as theirs (86%), holding its prose, cards and thread's task card. */
export const AGENT_BUBBLE =
  'flex w-fit min-w-0 max-w-[86%] flex-col gap-[10px] rounded-[12px_12px_12px_4px] border border-(--bubble-self-edge) bg-(--bubble-self) px-3 py-[9px]'

/** The speaking agent's name, its accent pulled 62% toward the text colour so gold or green passes contrast. */
export const AGENT_NAME =
  'font-sans text-[13px] font-semibold leading-normal text-[color:color-mix(in_oklab,var(--agent-accent,var(--indigo-500))_62%,var(--text-primary))]'

/** The agent turn's fold line beside its name: its duration and any failures, one click to open the work. */
export const TURN_FOLD =
  'inline-flex min-w-0 cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) hover:text-(--text-secondary)'

/** A person's own bubble: neutral, its tail corner mirrored. */
export const SELF_BUBBLE =
  'max-w-full rounded-[12px_12px_4px_12px] border border-(--bubble-self-edge) bg-(--bubble-self) px-3 py-[9px] font-sans text-[13.5px] font-normal leading-[1.55] text-(--text-primary)'

/** A person's bubble on the left, its tail corner there: someone else's message, or one delivered into an agent's session. */
export const DELIVERED_BUBBLE =
  'w-fit max-w-full rounded-[12px_12px_12px_4px] border border-(--bubble-self-edge) bg-(--bubble-self) px-3 py-[9px] font-sans text-[13.5px] font-normal leading-[1.55] text-(--text-primary)'
