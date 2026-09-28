---
name: agentconnect-release
description: Summarize published AgentConnect releases, verify stable-release publication, and comment on and close fully resolved issues. Use for release summaries, recent-release backfills, and authorized release-watch follow-up. Does not publish releases.
---

# AgentConnect Release

Handle follow-up for published releases: verify publication, write a short English
`## Summary` above the existing notes, and close issues whose complete fixes shipped.
Default to `agentconnect-md/agentconnect`; respect an explicitly requested repository.

## Scope

- Requests for examples, drafts, or "write the latest N" produce drafts in chat.
- An explicit request to update releases, including an existing authorized watcher,
  permits writing the summaries for that scope without asking again.
- Authorized release watches for `agentconnect-md/agentconnect` include commenting
  on and closing verified fixes after stable publication succeeds. For other
  repositories, issue follow-up must be explicitly within scope. One-off summary
  requests do not change issues.
- Creating or invoking this skill does not create a watcher, publish a new release,
  change versions, update docs and blogs, or start a historical issue sweep.

## Establish the release scope

- Fetch current release records through authenticated GitHub tools or `gh`.
  For "latest N," exclude drafts and prereleases unless requested, order by
  `published_at`, and paginate until the requested stable releases are covered.
- Resolve each release tag and its preceding stable tag in the same release line.
  For a new major version, use the preceding major's last stable release.
  Use that release range, not current main or the immediately preceding RC.
- Read the existing notes and relevant merged PR descriptions; inspect the tagged
  diff when a title is ambiguous or a migration, removal, or security claim needs
  confirmation. Roadmap checkboxes and newer documentation do not prove a feature
  shipped in this release.
- Keep claims within the evidence. Distinguish newly introduced capabilities from
  later improvements. Link relevant docs or blogs only after checking the page
  and its applicability to the release.

## Summary writing rules

- Always use exactly `## Summary`. Do not alternate with Highlights, What's New,
  or Overview, or add a second Features/Fixes hierarchy inside the summary.
- Write in English. For several meaningful changes, use
  `- **Feature Name** — One or two short sentences about what users can do.`
  For a small release, one short paragraph or two is enough. Do not fill a quota.
- Consolidate related PRs into a capability, such as Gitea Support, Agent Setup in
  Webchat, or Centralized Memory Management. Explain outcomes, not module names,
  protocol fields, storage tables, or a list of commit titles.
- Keep small interaction tweaks within a broader capability or omit them from
  the summary. Mention important fixes briefly. Dependency bumps, CI changes,
  tests, and refactors stay in the technical notes unless users need to act.
- Select by user impact, not the generated changelog category: an Internal entry
  can contain a removal users need to know, while a feat entry may be too small
  for a headline.
- Include concrete removals, changed defaults, migrations, or required upgrade
  actions as a short paragraph starting **Behavior change:**, **Subscription
  change:**, or **Upgrade note:** within the Summary. Do not invent instructions
  or claim that an upgrade requires no action without evidence.
- Omit the generated version/date heading; GitHub already displays both. Remove
  only that redundant heading when editing existing notes.
- Keep the original detailed notes below the summary. GitHub Releases are the
  canonical version record; a docs Updates page can reuse it. Blogs cover major
  releases or worthwhile product stories and are not required for every version.

For tone and length, read [references/examples.md](references/examples.md).
Draft responses should identify and link each release outside its Markdown snippet.

## Update release summaries when authorized

1. Save the current release ID, tag, body, and update time. Build a candidate body
   that preserves all existing technical notes and unrelated manual prose.
2. Bound the generated section with these markers:

   ```markdown
   <!-- agentconnect-release-summary:start -->

   ## Summary

   Release summary goes here.
   <!-- agentconnect-release-summary:end -->
   ```

   On first insertion, prepend this block. On subsequent runs, replace only this
   block; identical content is a no-op. If an unmarked Summary already exists,
   establish its exact boundaries before adopting it and retain still-relevant
   manual notes. Ambiguous boundaries or malformed markers mean leave a draft,
   not replace the whole release body.

3. Save the complete candidate as a UTF-8 file and inspect it, including links.
   Apply the repository's publication checks when required. Never bypass a
   rejected check or copy runtime identities, credentials, or internal URLs into
   release prose.
4. Re-fetch the release immediately before writing. If the body changed, rebuild
   against the new body before continuing; never overwrite unseen edits. Update
   only the body with `gh release edit TAG --repo OWNER/REPO --notes-file FILE`
   or the equivalent GitHub tool. Do not change the title, tag, assets, or status.
5. Re-fetch and compare with the candidate. If an API call times out or returns an
   uncertain result, read the release before retrying. If the result still cannot
   be verified, stop with the saved draft and an accurate status instead of
   blindly repeating writes. Report the verified release links.

## When invoked by an authorized release watcher

- Handle stable `release:published` events; ignore summary-edit events. Identify
  work by repository and release ID. An existing complete summary skips only the
  summary write; continue any unfinished, authorized issue follow-up. Do not
  backfill older releases unless requested.
- Check the workflow for the release's exact commit/tag. A published Release can
  precede completion of image or artifact publication. Only write the summary
  after all required publication jobs succeed. While pending, recheck once a
  minute for up to 90 minutes. On failure, cancellation, or timeout, leave the
  body and issues unchanged and report that state to the caller.
- Release publication is not evidence of deployment. Do not claim that an
  environment was upgraded.

## Close released issues when authorized

Keep fix-related issues open through PR merge and RC/prerelease publication. Use
`Refs #123` or `Related to #123` in PR descriptions and commit messages; avoid
closing keywords and Development links that close issues when a PR merges.
For work split across PRs, each PR states which acceptance items it covers and
what remains. Keep the issue's acceptance checklist and required PR references
current; a partial PR must not claim the complete fix.

1. After the stable release passes the publication checks above, find candidate
   issues from PRs and commits in the verified release range, including `Refs`
   references and issue discussions. Do not rely only on GitHub's closing-issue
   links, and do not treat every referenced issue as fixed.
2. Read each candidate issue's acceptance checklist and all required PRs, including
   work from earlier releases. Verify that every required change is present in
   the exact release tag and all acceptance criteria are met, accounting for
   squash/rebase merges and reverts. All PRs being merged is insufficient, and
   checked boxes alone do not prove release inclusion. Leave partial fixes,
   outstanding dependencies, and unclear acceptance scope open. Do not infer
   inclusion from current main or a PR title.
3. Re-fetch issue state and comments before writing. Leave already-closed issues
   alone. If the same release comment already exists, reuse it; if the issue was
   reopened after that comment, leave it open and report the remaining concern.
4. Prepare an English comment: `Fixed and released in version vX.Y.Z.` followed
   by the verified release link and relevant PR links. Replace the version with
   the actual stable tag. Inspect the comment and run required publication checks
   before posting it from a saved UTF-8 body file or structured tool argument.
5. Confirm that the comment exists, re-check for intervening issue updates, then
   close the issue as completed and verify its final state. If a write times out,
   read the issue and comments before retrying. A failed comment must not be
   followed by closure; a failed closure may resume without another comment.
6. Report verified closures with the release version and any issues left open
   that need attention. Completion of the summary and issue follow-up are
   independent, so a duplicate release event can finish interrupted issue work.
