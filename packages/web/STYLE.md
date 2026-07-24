# Console styling conventions (Tailwind migration)

The console is migrating from inline `style={{}}` objects to Tailwind 4 utility
classes. Design tokens stay in `src/app/globals.css` (`:root` + the
`data-theme='dark'` remap) and remain the single source of truth — utilities
reference them, never restate them.

## Golden rules

1. **Colors always go through tokens, via var-shorthand utilities.**
   `bg-(--surface-card)`, `text-(--text-secondary)`, `border-(--border-subtle)`,
   `border-t-(--brand)`. Never resolve a token to hex. Literal colors that had
   no token stay literal: `text-[#cdd6e0]`, `text-white`.
   Var-shorthand is used for **color positions only** — sizes are always
   literal (`text-[13px]`, never `text-(length:--x)`).

2. **`font:` shorthand decomposes to four utilities — the line-height part is
   mandatory.** The CSS `font:` shorthand resets `line-height` to `normal`
   when no `/LH` is given, while Tailwind preflight sets `html { line-height:
1.5 }`. So:
   - `font: '600 16px var(--font-sans)'` → `font-sans text-[16px] font-semibold leading-normal`
   - `font: '400 13px/1.55 var(--font-sans)'` → `font-sans text-[13px] font-normal leading-[1.55]`
   - `font: '500 11px var(--font-mono)'` → `font-mono text-[11px] font-medium leading-normal`
     **`leading-normal` is redefined in our `@theme` to CSS `normal`** (not
     Tailwind's stock 1.5) because replicating the shorthand reset is what the
     whole console needs. Omitting it changes vertical rhythm.
     A bare `fontSize: 12` (no shorthand) translates to `text-[12px]` with **no**
     leading utility — those elements inherited 1.5 before and must keep doing so.
     (Side effect, accepted: the shorthand also used to reset
     `font-feature-settings`; utilities restore inheritance of the body's
     `'cv01','ss03'` — a consistency fix, not a bug.)

3. **Spacing/size: multiples of 4px use the scale, everything else is arbitrary
   px.** `gap: 8` → `gap-2`, `padding: 16` → `p-4`, `width: 40` → `w-10`,
   `minHeight: 72` → `min-h-18`; but `gap: 7` → `gap-[7px]`, `padding: '13px
14px'` → `px-[14px] py-[13px]`, `width: 46` → `w-[46px]`. Never rem literals.

4. **Radius maps to the token scale** (globals.css `:root` overrides Tailwind's
   defaults, so these resolve to the app values): 4 → `rounded-xs`, 6 →
   `rounded-sm`, 8 → `rounded-md`, 12 → `rounded-lg`, 16 → `rounded-xl`,
   999/`'50%'`-on-a-square → `rounded-full`. Odd values stay arbitrary
   (`rounded-[7px]`).

5. **Shadows always use the var-shorthand**: `shadow-(--shadow-xs)`,
   `shadow-(--shadow-md)`, … Never the named `shadow-xs`/`shadow-sm` utilities:
   Tailwind inlines its own default shadow values at build time (to inject the
   `--tw-shadow-color` machinery), so those IGNORE the app's `--shadow-*`
   tokens — and with them the dark theme's deepened shadows. (Radius named
   utilities are safe — they reference `var(--radius-*)` at runtime; verified.)

6. **Borders**: `border: '1px solid var(--border-subtle)'` → `border
border-(--border-subtle)` (preflight supplies `solid`). Dashed → add
   `border-dashed`. Single side → `border-t` etc. `border: 0` → `border-0`.
   The ellipsis trio `overflow:hidden; textOverflow:ellipsis;
whiteSpace:nowrap` → `truncate`.

7. **One breakpoint: `desktop:` (≥769px) / `max-desktop:` (≤768px).** The stock
   `sm:`–`2xl:` variants are **disabled** in `@theme` — the app's mobile
   boundary is `max-width: 768px` (see `useIsMobile`), and stock `md:` would
   disagree at exactly 768px. Inside an `if (isMobile)` fork you normally need
   no variant at all.

8. **What stays as inline `style`**: values computed from data — status colors
   from a map, `orgColor(id)`, progress-bar `width: pct%`, grid templates held
   in a variable. Boolean toggles do NOT qualify: write a ternary between two
   complete literal class strings (`c.enabled ? '' : 'opacity-55'`). **Never
   assemble a class name from fragments** — Tailwind's scanner only sees full
   literals in the source text. (A `const GRID = 'grid-cols-[2fr_1fr_44px]'`
   literal is fine; `` `grid-cols-[${x}]` `` is not.)

9. **Semantic classes** (`card`, `row`, `mono`, `modalhead`, …) stay where
   they're used; they now live in `@layer components`, so utilities on the same
   element override them (`className="psub mt-0"` works). Don't re-implement an
   existing semantic class with utilities — compose with it.

10. **`if (isMobile)` forks are style-only in this migration** — translate the
    styles inside both branches, never merge, drop, or restructure the
    branches themselves.

11. **The mobile CSS hacks in globals.css** (`[style*='grid-template-columns:
1fr 1fr']`, `div:has(> .card.stat)` — both `!important`) target inline
    styles / class structures. When migrating the code they target, express
    the same responsive behavior with utilities in the same change: modal
    two-up form grids → `grid grid-cols-1 desktop:grid-cols-2` with full-width
    fields `desktop:col-span-2`; stat strips → `grid grid-cols-2
desktop:grid-cols-4`. The hack rules stay in globals.css (harmless — they
    agree with the utilities) until the final cleanup pass removes them.

12. **No new globals.css classes** for one-off styling. If something genuinely
    can't be a utility (rare), keep a minimal inline `style` with a comment.

13. **Hover/press states and motion come from the design system, not per
    component.** The tokens are `--duration-fast|normal|slow` (120/200/320ms)
    and `--ease-standard|out|in-out`; `@theme` points Tailwind's bare
    `transition-*` utilities at fast + standard, so `transition-colors` is
    already correct and **`duration-*` utilities should not appear** — a literal
    duration is how the console drifts back apart. globals.css carries one
    grouped `transition: var(--transition-interactive)` rule listing every
    interactive class; add new ones to that list rather than writing a local
    `transition:`. The hover VALUES are fixed per control kind:

    | Kind                                                      | Hover                                                    |
    | --------------------------------------------------------- | -------------------------------------------------------- |
    | Solid button (`.dsbtn-primary`, `.sendbtn`)               | `--brand-hover` (one step darker)                        |
    | Bordered control (`.iconbtn`, `.chip`, `.selbtn`, `.sso`) | `--surface-hover` + `--border-strong`                    |
    | Ghost row (`.dmi`, `.fopt`, `.row.click`, menu items)     | `--surface-hover`                                        |
    | Card that navigates (`.card.click`)                       | `--border-strong` + `--shadow-md` — a lift, never a fill |
    | Tab / segment (`.tab`, `.pill`)                           | `--text-primary` only                                    |
    | Rail item on plum (`.navitem`)                            | `rgba(255,255,255,0.04)` (`.on` is 0.07)                 |

    A `prefers-reduced-motion` block at the end of globals.css collapses every
    transition to one frame; end states are unchanged, so nothing needs a
    reduced-motion variant of its own.

14. **`title` is the console's tooltip API.** `components/console/Tooltip.tsx`
    mounts once in the shell, lifts each `title` off its element on hover, and
    re-renders it on the tokens above after a 120ms dwell (the browser's own
    tooltip waits ~1s and ignores the theme). So keep writing plain
    `title="…"` — don't hand-roll a hover popover, and don't add a
    `duration-*`/delay of your own. A tooltip that needs rich content (not a
    string) is the exception: `OutputModeHelp.tsx` is the pattern to copy.

    The layer only restyles hints that were already doing tooltip work — it is
    not a reason to add `title` to something that had none. Where a `title`
    exists for another purpose and would only repeat text the user can already
    read, mark the subtree `data-no-tooltip`: the nav rail does this, since its
    `title`s are the collapsed rail's fallback labels, not hints.

15. **JSX whitespace after an inline element (SWC gotcha).** Turbopack/SWC
    drops the space in `</span> long text…` when that text run wraps to the
    next source line (Babel would keep it — and prettier assumes Babel
    semantics, so it happily collapses `{' '}` into exactly this broken
    shape). When prose follows an inline `<span>` and is long enough to wrap,
    write the space as the entity `&#32;` (`</span>&#32;will be removed …`) —
    prettier preserves it and SWC can't trim it. Short same-line text
    (`</span> to confirm`) and expression neighbours (`</span> {expr}`) are
    unaffected.

## Worked example

```tsx
// Before
<span style={{ width: 30, height: 30, borderRadius: 7, background: 'var(--surface-sunken)',
  border: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center',
  justifyContent: 'center', flex: 'none' }}>

// After
<span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
```

Reference migrations: `components/console/modals/AddDaemonModal.tsx`,
`components/console/views/CronsView.tsx`.

## Checks

Per file: `pnpm --filter @agentconnect.md/web exec tsc --noEmit -p tsconfig.json`
and `pnpm exec eslint <file>`. Visual verification (light/dark ×
desktop/mobile, mock + no-auth stack) is done centrally after each batch.
