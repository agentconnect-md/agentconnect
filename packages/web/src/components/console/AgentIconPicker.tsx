// The "Agent Avatar" picker (Console design): a square avatar button that opens a
// popover to choose the icon — a Lucide glyph + color plate, or an UPLOADED image.
// (The old runtime-mark and paste-a-URL options were dropped, docs/designs/icon-uploads.md.)
// Used in the Add-agent modal header (glyph only — the agent doesn't exist yet, so no
// upload target; parent persists on Create via `onChange`), the agent detail/config
// header, and the org settings header (both persist via `onCommit` for glyph picks and
// via `onUploadImage` for uploads). While open it previews an internal draft.
// No 'use client' here: rendered only by client views (same convention as
// McpServersField / VisibilityField), so the parent owns the boundary.

import { useRef, useState } from 'react'
import { Icon } from '@/components/ui'
import { AgentIconView, Spinner } from '@/components/marks'
import { AGENT_ICON_GLYPHS, AGENT_ICON_COLORS, type AgentIcon } from '@/lib/agent-icon'
import { resizeImageToIconBlob } from '@/lib/icon-upload'

export function AgentIconPicker({
  value,
  runtime,
  onChange,
  onCommit,
  onUploadImage,
  size = 30,
  pencilCorner = 'br',
  radiusClass = 'rounded-[7px]'
}: {
  value: AgentIcon | null
  runtime: string
  /** Live update on each glyph/color pick — for a controlled parent (the Add modal persists on Create). */
  onChange?: (icon: AgentIcon) => void
  /** Fired once when the popover closes IF the glyph/color changed while open — the header's
   *  persistence hook (the Add modal uses onChange + Create instead). */
  onCommit?: (icon: AgentIcon) => void
  /** Present ⇒ the object store is configured AND the entity exists, so show the Upload
   *  button. The parent uploads the resized blob and updates `value` to the new image
   *  icon. Absent (Add modal, or no store) ⇒ upload is hidden (glyph only). */
  onUploadImage?: (blob: Blob) => Promise<void>
  size?: number
  /** Which corner the pencil badge sits in; the detail header uses 'tr' so a status
   *  dot can occupy 'br'. */
  pencilCorner?: 'tr' | 'br'
  radiusClass?: string
}) {
  const [open, setOpen] = useState(false)
  // In-progress preview while open, seeded from `value` on open; `value` itself is the
  // committed icon. Displayed only while open, so a header preview needs no parent state.
  const [draft, setDraft] = useState<AgentIcon | null>(value)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const shown = open ? draft : value
  // The working glyph/color, so picking one axis preserves the other.
  const curGlyph = shown?.kind === 'glyph' ? shown.glyph : AGENT_ICON_GLYPHS[0]
  const curColor = shown?.kind === 'glyph' ? shown.color : AGENT_ICON_COLORS[0]

  const openPopover = () => {
    setDraft(value)
    setError(null)
    setOpen(true)
  }
  const closePopover = () => {
    setOpen(false)
    if (onCommit && draft && JSON.stringify(draft) !== JSON.stringify(value)) onCommit(draft)
  }
  const pick = (icon: AgentIcon) => {
    setDraft(icon)
    onChange?.(icon)
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file || !onUploadImage) return
    setError(null)
    setUploading(true)
    try {
      const blob = await resizeImageToIconBlob(file)
      await onUploadImage(blob)
      // The parent persisted + updated `value` to the new image icon; close WITHOUT the
      // onCommit path (that would re-persist the stale glyph draft).
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload failed')
    } finally {
      setUploading(false)
    }
  }

  const pencilPos = pencilCorner === 'tr' ? '-top-1 -right-1' : '-bottom-1 -right-1'

  return (
    <div className="relative flex-none">
      <button
        type="button"
        title="Choose icon"
        onClick={() => (open ? closePopover() : openPopover())}
        // No overflow-hidden here: the pencil badge overflows the corner and must not be
        // clipped. The glyph plate / <img> self-round via rounded-[inherit], and the
        // button's own background is clipped by its border-radius regardless.
        className={`relative flex items-center justify-center border-0 p-0 ${shown?.kind === 'image' ? 'bg-white' : shown?.kind === 'glyph' ? '' : 'bg-(--surface-inverse)'} ${radiusClass}`}
        style={{ width: size, height: size, background: shown?.kind === 'glyph' ? shown.color : undefined }}
      >
        <AgentIconView icon={shown} runtime={runtime} size={size} />
        <span
          className={`absolute ${pencilPos} flex h-[15px] w-[15px] items-center justify-center rounded-full border border-(--border-default) bg-(--surface-card)`}
        >
          <Icon name="pencil" size={8} color="var(--text-secondary)" />
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={closePopover} />
          <div
            className="absolute left-0 top-[calc(100%+8px)] z-50 w-[288px] rounded-[12px] border border-(--border-default) bg-(--surface-card) p-[14px] shadow-(--shadow-lg)"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-[9px] font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-(--text-tertiary)">
              Icon
            </div>
            <div className="mb-[15px] grid grid-cols-8 gap-[5px]">
              {AGENT_ICON_GLYPHS.map((g) => {
                const sel = shown?.kind === 'glyph' && shown.glyph === g
                return (
                  <button
                    key={g}
                    type="button"
                    onClick={() => pick({ kind: 'glyph', glyph: g, color: curColor })}
                    className="flex aspect-square items-center justify-center rounded-[7px] border p-0"
                    style={{
                      borderColor: sel ? 'var(--brand)' : 'var(--border-subtle)',
                      background: sel ? 'var(--brand-soft)' : 'var(--surface-card)'
                    }}
                  >
                    <Icon name={g} size={15} color={sel ? 'var(--brand)' : 'var(--text-secondary)'} />
                  </button>
                )
              })}
            </div>
            <div className="mb-[9px] font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-(--text-tertiary)">
              Color
            </div>
            <div className="mb-[14px] flex gap-[8px]">
              {AGENT_ICON_COLORS.map((c) => {
                const sel = shown?.kind === 'glyph' && curColor === c
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => pick({ kind: 'glyph', glyph: curGlyph, color: c })}
                    className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[8px] border-2 p-0"
                    style={{ background: c, borderColor: sel ? 'var(--text-primary)' : c }}
                  >
                    {sel && <Icon name="check" size={15} color="#fff" />}
                  </button>
                )
              })}
            </div>
            {onUploadImage && (
              <>
                <div className="-mx-[14px] mb-[12px] h-px bg-(--border-subtle)" />
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onFile} />
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                  className="flex h-[32px] w-full items-center justify-center gap-[6px] rounded-[8px] border border-(--border-default) font-sans text-[11.5px] font-semibold text-(--text-secondary) disabled:opacity-60"
                >
                  {uploading ? (
                    <Spinner size={13} />
                  ) : (
                    <>
                      <Icon name="upload" size={13} color="var(--text-secondary)" />
                      {shown?.kind === 'image' ? 'Replace image' : 'Upload image'}
                    </>
                  )}
                </button>
                {error && <div className="mt-[8px] font-sans text-[11px] text-(--red-600)">{error}</div>}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
