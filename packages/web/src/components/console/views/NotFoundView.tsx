'use client'

import { useTranslations } from 'next-intl'
import { usePathname } from 'next/navigation'
import { useOrgs } from '@/lib/org-context'
import { NotFound } from '@/components/console/NotFound'

// Catch-all route 404 (design variant 1e): an unknown path under a known org.
// Renders inside the console shell so the rail/top-bar context is preserved, and
// shows the attempted path in the shared not-found anatomy.
export default function NotFoundView() {
  const t = useTranslations('Common.notFound')
  const pathname = usePathname()
  const { orgPath } = useOrgs()
  return (
    <div className="wrap">
      <NotFound
        icon="compass"
        kind={t('kind')}
        title={t('title')}
        chip={pathname}
        post={t('post')}
        actionLabel={t('goHome')}
        actionHref={orgPath('/home')}
        searchLabel={t('search')}
      />
    </div>
  )
}
