'use client'

import { usePathname } from 'next/navigation'
import { useOrgs } from '@/lib/org-context'
import { NotFound } from '@/components/console/NotFound'

// Catch-all route 404 (design variant 1e): an unknown path under a known org.
// Renders inside the console shell so the rail/top-bar context is preserved, and
// shows the attempted path in the shared not-found anatomy.
export default function NotFoundView() {
  const pathname = usePathname()
  const { orgPath } = useOrgs()
  return (
    <div className="wrap">
      <NotFound
        icon="compass"
        kind="PAGE"
        title="Page not found"
        chip={pathname}
        post=" doesn’t exist. Check the address, or head back home."
        actionLabel="Go to home"
        actionHref={orgPath('/home')}
        searchLabel="Search"
      />
    </div>
  )
}
