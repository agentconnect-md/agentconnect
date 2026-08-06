# Notification Center Consolidation Design

## Goal

Align the notification bell with the console rail chrome and move Session and Usage access-degradation notices into the notification center. Existing daemon lifecycle and session-retention notifications remain unchanged.

## Scope

This change covers:

- the desktop rail and mobile app-bar presentation of the notification trigger;
- Lark/Feishu quota, authorization, and unclassified access-check failures surfaced by the Sessions and Usage views;
- notification persistence, actions, deduplication, resolution, and recurrence for those access issues.

This change does not migrate GitHub callback notices, Schedule results, form validation, modal errors, destructive-operation warnings, daemon availability notices, or other contextual status messages.

## Notification Trigger

The desktop trigger uses the existing `railiconbtn` contract: a 22 × 22 transparent, borderless button with the same foreground, hover treatment, spacing, and center line as Collapse, Search, and Help. The unread badge remains visible without changing the button box.

The mobile trigger uses the mobile app-bar button contract. Both variants open the same notification panel and expose the same accessible label and unread count.

## Notification Model

Access notifications add the `session_access` category and require:

- a stable `sourceKey` built from the surface (`sessions` or `usage`), provider, region, and failure reason;
- a serializable link action with a label, URL, and external-navigation flag;
- `resolvedAt` when the condition is no longer active.

Serializable actions preserve local-storage compatibility. Quota notifications link to the relevant Lark or Feishu administration site. Classified authorization failures link to the organization Profile reauthorization target. Unclassified failures have no action.

Each normalized issue is one notification. Mixed reasons and regions do not inherit the old banner's quota-first aggregation:

| Reason          | Title                                                                    | Severity  | Message                                                                                    | Action                                              |
| --------------- | ------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `quota`         | `<Region> API quota exhausted`                                           | `warning` | Sessions are hidden, or Usage is under-counted, until allowance increases or quota resets. | `Open <Region> Admin` in a new tab                  |
| `authorization` | `Refresh your <Region> sign-in`                                          | `warning` | Refresh the identity in Profile to restore the affected Session or Usage access.           | `Refresh <Region>` to the organization Profile page |
| `unavailable`   | `Session access checks unavailable` or `Usage access checks unavailable` | `warning` | Access stays fail-closed for Sessions, or Usage stays under-counted, until checks recover. | None                                                |

`Region` is `Lark` or `Feishu` for classified Feishu-provider issues. Unsupported providers and missing regions use the surface-level `unavailable` notification and are collapsed into one generic source per surface.

## Synchronization and Deduplication

The shell observes two authoritative, unfiltered reads that already exist in `ConsoleDataProvider`: the unfiltered first Sessions page and the 24-hour Usage read. Filtered or paginated view-local requests never drive resolution, so changing filters, loading another page, or partially revalidating a page chain cannot resolve an organization-wide source.

The data layer exposes each read as either a trustworthy completed snapshot or unavailable-for-sync. Loading, validation, partial-page refresh, and request-error states are unavailable-for-sync and leave notification state untouched.

The provider accepts an atomic `syncSourceSnapshot(scope, items)` operation. `scope` is `sessions-access` or `usage-access`; every `session_access` item has a unique, required `sourceKey`. One call updates present items and resolves only previously active keys owned by that scope that are absent from the new snapshot.

- The first observation of an active source creates one unread history item and one toast.
- Repeated observations update the active item without creating another history item or toast, while preserving its read state and original timestamp.
- A successful observation that no longer contains the source sets `resolvedAt` and retains the history item.
- A later recurrence creates a new unread history item and toast.
- Session and Usage keys remain distinct because their user-visible impacts differ.

Active source keys are persisted separately from the visible 50-item history. `clearAll` clears visible history and toasts but deliberately preserves the active-source set. History eviction also leaves active-source state intact. Therefore an issue that remains active after explicit clearing or retention eviction does not reappear or emit another toast; it becomes eligible for a new item only after a trustworthy snapshot resolves it and a later snapshot reports a recurrence.

## Presentation and Interaction

The current `SessionAccessNotice` page banners are removed. Their existing copy rules are reused to build notification titles, messages, and actions.

Actions render in both panel rows and live toasts. They are keyboard-focusable anchors. Clicking an action stops the row click from firing, explicitly marks the history item read, dismisses the corresponding toast when present, then performs internal or external navigation. External actions open in a new tab with safe link attributes. Resolved items show a `Resolved` label and render no stale recovery action.

If local storage is unavailable, notifications continue in memory for the current page session.

## Testing

Implementation follows red-green-refactor and covers:

- repeat synchronization without duplicate history items or toasts;
- resolution followed by recurrence;
- distinct Session and Usage keys;
- Lark/Feishu quota, authorization, and unclassified copy/action mapping;
- mixed reasons and regions producing their defined normalized items;
- loading, errors, filtered queries, pagination, and partial revalidation never causing false resolution;
- snapshot updates preserving read state and original timestamps;
- persistence reloads and storage-failure fallback;
- clearing and retention eviction preserving active-source deduplication;
- resolved-action suppression and keyboard-accessible action navigation/read behavior;
- rail and mobile trigger variants;
- removal of the Session and Usage page banners;
- existing daemon lifecycle and session-retention behavior.

Fresh web tests, type checking, linting, and focused visual checks will run before completion is reported.
