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

Access notifications add the `session_access` category and may carry:

- a stable `sourceKey` built from the surface (`sessions` or `usage`), provider region, and failure reason;
- a serializable link action with a label, URL, and external-navigation flag;
- `resolvedAt` when the condition is no longer active.

Serializable actions preserve local-storage compatibility. Quota notifications link to the relevant Lark or Feishu administration site. Classified authorization failures link to the organization Profile reauthorization target. Unclassified failures have no action.

## Synchronization and Deduplication

Sessions and Usage normalize their current access issues and synchronize them through the notification provider.

- The first observation of an active source creates one unread history item and one toast.
- Repeated observations update the active item without creating another history item or toast.
- A successful observation that no longer contains the source sets `resolvedAt` and retains the history item.
- A later recurrence creates a new unread history item and toast.
- Session and Usage keys remain distinct because their user-visible impacts differ.

Synchronization only runs after the relevant request has produced a trustworthy success result. Loading and request-error states do not resolve an existing issue.

## Presentation and Interaction

The current `SessionAccessNotice` page banners are removed. Their existing copy rules are reused to build notification titles, messages, and actions.

Clicking a notification row marks it read. Clicking its action also marks it read, then performs internal or external navigation. External actions open in a new tab with safe link attributes. Resolved items show a `Resolved` label and do not show a stale recovery action.

If local storage is unavailable, notifications continue in memory for the current page session.

## Testing

Implementation follows red-green-refactor and covers:

- repeat synchronization without duplicate history items or toasts;
- resolution followed by recurrence;
- distinct Session and Usage keys;
- Lark/Feishu quota, authorization, and unclassified copy/action mapping;
- rail and mobile trigger variants;
- removal of the Session and Usage page banners;
- existing daemon lifecycle and session-retention behavior.

Fresh web tests, type checking, linting, and focused visual checks will run before completion is reported.
