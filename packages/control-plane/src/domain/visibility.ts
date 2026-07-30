/** Transport- and persistence-independent resource visibility policy. */
export interface ViewCtx {
  userId: string
  role: 'owner' | 'collaborator' | 'viewer'
}

export interface Shareable {
  createdByUserId: string | null
  visibility: 'org' | 'restricted'
  sharedWith: string[]
}

/** Can this caller see the resource? Any one arm suffices. */
export function canView(resource: Shareable, viewer: ViewCtx): boolean {
  return (
    viewer.role === 'owner' ||
    resource.createdByUserId === viewer.userId ||
    resource.visibility === 'org' ||
    resource.sharedWith.includes(viewer.userId)
  )
}
