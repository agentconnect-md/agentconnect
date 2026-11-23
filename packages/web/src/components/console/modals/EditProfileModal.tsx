// No 'use client' here: rendered only by ModalProvider (the client boundary).

// Edit-profile dialog (design: `isEditProfileModal`). The display name saves via
// PATCH /me. Email stays provider-owned, while profile photos use the CP's
// validated image upload and fall back to the sign-in-provider photo when removed.
// Without a CP /me record (mock mode / CP down) the dialog stays display-only.
// With sign-in configured it also hosts the delete-account danger zone.

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Avatar, Button, Icon } from '@/components/ui'
import {
  ACCOUNT_OWNS_ORGANIZATIONS,
  ApiError,
  deleteMyAccount,
  deleteMyProfilePicture,
  updateMe,
  uploadMyProfilePicture,
  type SoleOwnedOrgDto
} from '@/lib/api'
import { isAuthConfigured, signOutDeletedAccount } from '@/lib/auth'
import { resizeImageToIconBlob } from '@/lib/icon-upload'
import { applyMe, useProfile } from '@/lib/profile'

export default function EditProfileModal({ onClose }: { onClose: () => void }) {
  const t = useTranslations('Profile')
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
  const [deleteArmed, setDeleteArmed] = useState(false)
  // No-auth installs have one fixed account; deleting it would lock the console out.
  const canDeleteAccount = !!me && isAuthConfigured()

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
      setErr(t('editProfileForm.fullNameRequired'))
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

  const removeAccount = async () => {
    if (busy) return
    if (!deleteArmed) return setDeleteArmed(true) // first click arms
    setBusy(true)
    setErr(null)
    try {
      await deleteMyAccount()
      await signOutDeletedAccount()
    } catch (e) {
      if (e instanceof ApiError && e.code === ACCOUNT_OWNS_ORGANIZATIONS) {
        const orgs = ((e.details?.details as { organizations?: SoleOwnedOrgDto[] } | undefined)?.organizations ?? [])
          .map((o) => o.name ?? o.slug)
          .join(', ')
        setErr(t('editProfileForm.ownsOrganizations', { orgs }))
      } else setErr(e instanceof Error ? e.message : String(e))
      setDeleteArmed(false)
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{t('editProfile')}</span>
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
              title={t('editProfileForm.changePhoto')}
              className="group relative flex-none rounded-full focus-visible:outline-none focus-visible:shadow-(--focus-ring)"
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
            <div className="text-(--text-secondary)">{t('editProfileForm.profilePhoto')}</div>
            {canEditPicture ? (
              removePicture ? (
                <div>
                  {t('editProfileForm.restoreOnSave')}{' '}
                  <button type="button" onClick={() => setRemovePicture(false)} className="text-(--brand)">
                    {t('editProfileForm.undo')}
                  </button>
                </div>
              ) : (
                <div>
                  {t('editProfileForm.uploadHint')}
                  {me?.pictureCustom && !pictureFile && (
                    <button type="button" onClick={() => setRemovePicture(true)} className="ml-2 text-(--brand)">
                      {t('editProfileForm.useSignInPhoto')}
                    </button>
                  )}
                </div>
              )
            ) : (
              <div>{t('editProfileForm.uploadsDisabled')}</div>
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
            <span className="fldlbl">{t('fullName')}</span>
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
            <span className="fldlbl">{t('email')}</span>
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
          {t('editProfileForm.emailProvider')}
        </div>
        {canDeleteAccount && (
          <div className="mt-[18px] flex items-center gap-[11px] rounded-[9px] border border-[rgba(220,75,75,.28)] bg-(--status-error-soft) px-[13px] py-3">
            <Icon name="trash" size={16} color="var(--status-error)" className="flex-none" />
            <div className="flex-1">
              <div className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
                {t('editProfileForm.deleteAccount')}
              </div>
              <div className="font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
                {t('editProfileForm.deleteAccountHint')}
              </div>
            </div>
            <button
              onClick={() => void removeAccount()}
              className={`flex-none cursor-pointer rounded-[7px] border border-[rgba(220,75,75,.4)] px-[11px] py-[6px] font-sans text-[12px] font-semibold leading-normal ${
                deleteArmed ? 'bg-(--status-error) text-white' : 'bg-(--surface-card) text-(--status-error)'
              }`}
            >
              {deleteArmed ? t('editProfileForm.confirmDelete') : t('editProfileForm.delete')}
            </button>
          </div>
        )}
        {err && (
          <div className="mt-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          {t('editProfileForm.cancel')}
        </Button>
        <Button onClick={() => void submit()}>{busy ? t('editProfileForm.saving') : t('editProfileForm.save')}</Button>
      </div>
    </>
  )
}
