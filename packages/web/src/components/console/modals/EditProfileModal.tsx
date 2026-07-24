// No 'use client' here: rendered only by ModalProvider (the client boundary).

// Edit-profile dialog (design: `isEditProfileModal`). The display name saves via
// PATCH /me. Email stays provider-owned, while profile photos use the CP's
// validated image upload and fall back to the sign-in-provider photo when removed.
// Without a CP /me record (mock mode / CP down) the dialog stays display-only.

import { useEffect, useRef, useState } from 'react'
import { Avatar, Button, Icon } from '@/components/ui'
import { deleteMyProfilePicture, updateMe, uploadMyProfilePicture } from '@/lib/api'
import { resizeImageToIconBlob } from '@/lib/icon-upload'
import { applyMe, useProfile } from '@/lib/profile'

export default function EditProfileModal({ onClose }: { onClose: () => void }) {
  const { user, me } = useProfile()
  const [name, setName] = useState(me?.name ?? user.name)
  // The identity resolves async (token claims + /me fetch) — keep the prefill
  // tracking it until the user actually types, so a fast open never pins the
  // "Local user" placeholder into the field (and then saves it).
  const [dirty, setDirty] = useState(false)
  const prefill = me?.name ?? user.name
  useEffect(() => {
    if (!dirty) setName(prefill)
  }, [dirty, prefill])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pictureFile, setPictureFile] = useState<File | null>(null)
  const [picturePreview, setPicturePreview] = useState<string | null>(null)
  const [removePicture, setRemovePicture] = useState(false)
  const pictureInput = useRef<HTMLInputElement>(null)
  const canEditPicture = !!me?.pictureUploadEnabled

  useEffect(() => {
    if (!pictureFile) {
      setPicturePreview(null)
      return
    }
    const preview = URL.createObjectURL(pictureFile)
    setPicturePreview(preview)
    return () => URL.revokeObjectURL(preview)
  }, [pictureFile])

  const selectPicture = (file: File | undefined) => {
    if (!file) return
    setPictureFile(file)
    setRemovePicture(false)
  }

  const submit = async () => {
    if (busy) return
    // No CP profile (mock mode / CP unreachable) — display-only, Save just closes.
    if (!me) return onClose()
    const nextName = name.trim()
    if (nextName === '') {
      setErr('Full name is required.')
      return
    }
    const changedName = nextName !== (me.name ?? user.name)
    if (!changedName && !pictureFile && !removePicture) return onClose()
    setBusy(true)
    setErr(null)
    try {
      if (changedName) applyMe(await updateMe({ name: nextName }))
      if (pictureFile) applyMe(await uploadMyProfilePicture(await resizeImageToIconBlob(pictureFile)))
      else if (removePicture) applyMe(await deleteMyProfilePicture())
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Edit profile</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <div className="mb-[18px] flex items-center gap-4">
          {canEditPicture ? (
            <button
              type="button"
              onClick={() => pictureInput.current?.click()}
              title="Change profile photo"
              className="group relative flex-none rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-(--brand)"
            >
              <Avatar
                src={picturePreview ?? (removePicture ? null : user.picture)}
                initials={user.initials}
                size={56}
                fontSize={20}
              />
              <span className="absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-(--border-default) bg-(--surface-card) shadow-(--shadow-xs)">
                <Icon name="pencil" size={10} color="var(--text-secondary)" />
              </span>
            </button>
          ) : (
            <Avatar src={user.picture} initials={user.initials} size={56} fontSize={20} />
          )}
          <div className="min-w-0 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
            <div className="text-(--text-secondary)">Profile photo</div>
            {canEditPicture ? (
              removePicture ? (
                <div>
                  Your sign-in photo will be restored when you save.{' '}
                  <button type="button" onClick={() => setRemovePicture(false)} className="text-(--brand)">
                    Undo
                  </button>
                </div>
              ) : (
                <div>
                  Click the photo to upload a PNG, JPEG, or WebP image.
                  {me?.pictureCustom && !pictureFile && (
                    <button type="button" onClick={() => setRemovePicture(true)} className="ml-2 text-(--brand)">
                      Use sign-in photo
                    </button>
                  )}
                </div>
              )
            ) : (
              <div>Photo uploads are not enabled in this deployment.</div>
            )}
          </div>
          {canEditPicture && (
            <input
              ref={pictureInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => {
                selectPicture(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          )}
        </div>
        <div className="grid grid-cols-1 gap-[14px] min-[440px]:grid-cols-2">
          <div className="fld">
            <span className="fldlbl">Full name</span>
            <div className="inp">
              <input
                value={name}
                onChange={(e) => {
                  setDirty(true)
                  setName(e.target.value)
                }}
                className="min-w-0 flex-1 border-0 bg-transparent outline-0 [font:inherit]"
              />
            </div>
          </div>
          <div className="fld">
            <span className="fldlbl">Email</span>
            {/* Read-only by design — the sign-in provider owns it (CP rejects edits too). */}
            <div className="inp cursor-default bg-(--surface-sunken) text-(--text-tertiary)">
              <span className="mono min-w-0 flex-1 overflow-hidden text-ellipsis text-[12.5px]">
                {user.email ?? '—'}
              </span>
              <Icon name="lock" size={13} color="var(--text-disabled)" className="flex-none" />
            </div>
          </div>
        </div>
        <div className="mt-[14px] flex items-center gap-2 rounded-md bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          <Icon name="info" size={14} />
          Your email comes from your sign-in provider and can’t be changed. Role and daemon access are managed by a
          workspace admin.
        </div>
        {err && (
          <div className="mt-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void submit()}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </>
  )
}
