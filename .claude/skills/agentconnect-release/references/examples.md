# Historical writing examples

These are summary drafts grounded in the linked releases. They demonstrate
grouping and length; verify the target release instead of copying their facts
into another version.

## Several product changes

Source: [v1.57.0](https://github.com/agentconnect-md/agentconnect/releases/tag/v1.57.0)

```markdown
## Summary

- **Gitea Support** — Bring agents into Gitea issues and pull requests, with automated reviews and commit status updates.
- **Improved Webchat** — Use interactive MCP Apps directly in your conversations.
- **Broader Sandbox Protection** — Extend API key protection to more runtimes running in MicroVM sandboxes, including Claude, Codex, and OpenCode.

**Behavior change:** The Console's rerun action for code-host events has been removed.
```

## Related PRs consolidated into one capability

Source: [v1.59.0](https://github.com/agentconnect-md/agentconnect/releases/tag/v1.59.0)

```markdown
## Summary

- **Agent Setup in Webchat** — Configure agents, manage skills and MCP servers, and connect code hosts directly from chat. Configuration cards remain available after refreshing the page.

This release also improves MCP OAuth compatibility and prevents a failed skill-source installation from blocking session startup.
```

## A smaller release

Source: [v1.60.0](https://github.com/agentconnect-md/agentconnect/releases/tag/v1.60.0)

```markdown
## Summary

Repository maintainers can now allow specific trusted contributors to trigger agents without granting them broader repository permissions.

This release also fixes Gitea access checks for users with team-granted write permissions and credential handling for Claude custom providers.
```
