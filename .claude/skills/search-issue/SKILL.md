---
name: search-issue
description: Find the next issue to tackle now on the project issue tracker, ranked by readiness, blockers, and progress markers. Use when the user wants to know what to work on next, find the next issue, pick up a ticket, asks "今片付けるべき issue は?", or invokes /search-issue.
---

# Search Issue

Find the single best issue to work on **now**, and optionally hand it off to
implementation.

The issue tracker (`docs/agents/issue-tracker.md`), triage roles
(`docs/agents/triage-labels.md`), and progress markers
(`docs/agents/status-markers.md`) should have been provided to you — run
`/setup-matt-pocock-skills` if the first two are missing.

## What "should be tackled now" means

A candidate is **actionable** when ALL hold:

1. **Open** (not closed).
2. **Triage-ready** — carries `ready-for-agent` (delegatable) or, if the user
   is working themselves, `help wanted`. Skip `needs-triage` / `question`.
3. **Unblocked** — every issue named in its **Blocked by** line is closed.
   This line is a blockquote at the top of the body. Parse the body for
   `Blocked by` references (e.g. `#211`, `KenichiroMatsubara/HayateProjects#211`)
   anywhere they appear and check each one's state — do not assume a fixed
   heading or position.
4. **Marker is `none`** — no `status:implementing` / `status:implemented` label
   (those are already in flight; see [status-markers.md](../../../docs/agents/status-markers.md)).

## Process

### 1. Gather

List open issues with their labels and bodies. Resolve the closed/open state of
every issue referenced in a `Blocked by` line (a blocker may itself be open).

### 2. Bucket

Sort all open issues into:

- **Actionable** — meets all four criteria above. This is the pick-from set.
- **Blocked** — triage-ready but waiting on an open blocker.
- **In progress** (`status:implementing`) — already being worked; surface so the
  user can resume or notice a stalled one.
- **Awaiting merge** (`status:implemented`) — done, needs a merge, not new work.
- **Not ready** — `needs-triage` / `question` / unlabeled. Mention the count only.

### 3. Rank the actionable bucket

Order by, in priority:

1. **Unblocks the most other issues** — a blocker that gates several others
   (read each issue's `Blocked by` to count dependents) clears the most work.
2. **Smallest / tracer-bullet** — fewer acceptance-criteria checkboxes first.
3. **Oldest** (`created_at`) as the tiebreaker.

### 4. Recommend

Present the buckets compactly (counts + one line per issue, actionable bucket
ranked). Then recommend **one** issue with a short reason: why it's next, what it
unblocks, and a one-line summary of what to build. Show the in-progress and
awaiting-merge buckets so nothing is silently dropped.

### 5. Hand off (on user confirmation)

If the user wants to start it:

1. Mark it `implementing` — add `status:implementing` (create the label if
   missing, see status-markers.md). An issue marked here is now `implementing`.
2. Invoke `/tdd` to implement it. `/tdd` advances the marker from there
   (`implemented` on push, then closed on merge).

Do not change any marker without the user's go-ahead — surfacing is read-only.
