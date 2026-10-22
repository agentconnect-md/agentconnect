// Infra's card grid, shared by its daemon, group and Computer sections so the page reads as one stack.

// Two columns as designed, as a 470px floor — what the row needs — so a narrow window drops to one, not to a crushed card.
export const FLEET_GRID =
  'grid grid-cols-1 gap-3 desktop:grid-cols-[repeat(auto-fill,minmax(min(470px,100%),1fr))] desktop:gap-[14px]'

// One height for every card here, floored at the tallest of them (the pool entry's capacity strip).
export const FLEET_ROW = 'desktop:min-h-[77px]'
