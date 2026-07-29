CLAUDE.md

## Agent skills

### Issue tracker

Issues and PRDs are always tracked in this repository's GitHub Issues. Do not ask which tracker to use. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the repository's canonical AFK/manual triage label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with `CONTEXT.md` and system-wide ADRs under `docs/adr/`. See `docs/agents/domain.md`.

## Screenshot and URL evidence

Mobile browser address bars may truncate or elide the beginning, middle, or end of a URL. In particular, a visible
`chat.pinara.workers.dev` may be the truncated tail of `flarechat.pinara.workers.dev`; screenshot text alone is not
evidence that a separate host or service exists.

- The canonical production origin for this repository is `https://flarechat.pinara.workers.dev/`.
- When the user provides an exact URL, treat it as authoritative over a cropped or elided screenshot.
- Never create, modify, diagnose, or delete a domain, redirect, compatibility service, or Worker based only on a URL
  fragment visible in a screenshot.
- If no exact URL is provided, verify the complete URL from browser state, deployment configuration, or another
  non-truncated source before acting.
