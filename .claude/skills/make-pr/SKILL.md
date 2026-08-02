---
name: make-pr
description: Create a pull request that automatically links the issue worked on in this session so that merging closes it (GitHub closing keyword, Closes #123), and check/resolve merge conflicts against the base branch before merge. Use when the user wants to open a PR tied to an issue, auto-close an issue on merge, link a PR to a ticket, asks "Issue と紐付けてプルリクを作って", "マージしたら Issue を閉じたい", "コンフリ解消して", or invokes /make-pr.
---

# Make PR

Open a pull request that:

1. **Auto-links the issue handled in this session** so merging it closes the
   issue automatically (via a GitHub closing keyword in the PR body) — and when
   no issue is found, proceeds unlinked without asking, reporting `未紐付け`,
2. **Is verified mergeable** — check whether the branch will conflict with the
   base branch and resolve the conflicts before it can be merged cleanly, and
3. **Ends with a fixed report block** — a one-line heading plus a table of
   PR URL / Closes / Branch→base / Mergeable (step 5).

## How the issue linkage works

GitHub closes an issue when a PR **merged into the default branch** contains a
closing keyword followed by the issue reference in its **description or a commit
message**. Supported keywords (case-insensitive):

```
close   closes   closed
fix     fixes    fixed
resolve resolves resolved
```

References may be `#123` (same repo) or `owner/repo#123` (cross-repo).
List multiple issues separately — `Closes #1, closes #2` (one keyword each).

> Only a merge into the **default branch** closes the issue. A PR targeting a
> non-default base will link but not auto-close until that branch merges to default.

## Process

### 1. Identify the issue handled in this session

Determine which issue this work addresses **from the session itself** — the
issue the user picked up, referenced, or that drove the changes on this branch.
An explicit argument or URL the user passed counts as detection too.

When an issue is found, confirm it with `mcp__github__issue_read` to verify it
exists and read its title/scope so the PR actually addresses it. If multiple
issues were handled, link each one.

**If no issue can be detected, do NOT ask.** Proceed to create the PR with no
link and record it as `なし（未紐付け）` in the final table (step 5). Never block
or prompt the user just to find an issue.

### 2. Prepare the branch and changes

- Make sure the work is committed on the designated feature branch (never the
  default branch) and pushed to origin.
- If there are no changes yet, implement the issue first, then commit and push.

### 3. Check for merge conflicts against the base branch

Before (or right after) opening the PR, verify the branch merges cleanly into
the base (default) branch and resolve any conflicts:

1. Fetch the latest base branch: `git fetch origin <base>`.
2. Detect conflicts without committing a merge:
   ```bash
   git merge --no-commit --no-ff origin/<base>
   ```
   - **No conflict** → `git merge --abort` and continue; the branch is clean.
   - **Conflict** → the command reports conflicted paths (also `git diff
     --name-only --diff-filter=U`). Resolve them:
     1. Open each conflicted file and reconcile both sides, preserving the intent
        of this branch's changes **and** the base branch's changes. Remove all
        `<<<<<<<`, `=======`, `>>>>>>>` markers.
     2. `git add` the resolved files.
     3. Commit the merge (`git commit`) and `git push -u origin <branch>`.
3. After resolving, re-run the check to confirm the branch is now conflict-free.

> If a conflict resolution is ambiguous or risks dropping someone else's work
> (e.g. large or architecturally significant changes), surface it to the user
> with `AskUserQuestion` instead of guessing.

For an **already-open** PR, you can also confirm mergeability via
`mcp__github__pull_request_read` (`mergeable` / `mergeable_state`) and bring the
branch up to date with `mcp__github__update_pull_request_branch`.

### 4. Create the PR with a closing keyword

Open the PR with `mcp__github__create_pull_request`.

- **Issue found** → the body **must** contain a closing keyword line referencing
  the issue:

  ```md
  ## Summary
  <what this PR does>

  Closes #123
  ```

- **No issue** → omit the closing line entirely; the body is just `## Summary`.

Checklist:

- [ ] `head` = feature branch, `base` = repo default branch
- [ ] If an issue was found: PR body has `Closes #<n>` (or fixes/resolves) on its
      own line, one keyword per issue when closing several
- [ ] Issue number matches the issue handled in this session (step 1)
- [ ] Branch merges cleanly into base (step 3) — no conflicts

### 5. Verify, then emit the fixed final report

After creation, confirm via `mcp__github__pull_request_read` that:

- the linked issue shows under "Development" / the body keyword is present (skip
  when unlinked), and
- `mergeable_state` is clean (no conflicts).

Then end your reply with **exactly this fixed block** — a one-line heading
followed by the table, nothing else after it:

```md
## ✅ PR 作成完了

| 項目 | 内容 |
|---|---|
| PR | <pr url> |
| Closes | #<n>「<issue title>」  ←無いときは `なし（未紐付け）` |
| Branch | <head> → <base> |
| Mergeable | ✅ clean ／ ⚠️ <要対応の説明> |
```

Rules for the block:

- Always the same heading and the same four rows, in this order — this is the
  fixed deliverable. (Use `## ✅ PR 更新完了` instead when you edited an existing
  PR rather than creating one.)
- `Closes` row carries the no-issue report: when nothing was linked, write
  `なし（未紐付け）` — that single row IS the "未紐付け" notice, no extra prose.
- Close multiple issues by listing them comma-separated in the `Closes` cell.
- `Mergeable` shows `✅ clean` once conflict-free, or `⚠️ …` describing what
  remains if not.

## If the PR already exists

If an issue was found, edit the description with
`mcp__github__update_pull_request` to add the `Closes #<n>` line — GitHub
re-parses the body and links the issue. (No issue → leave the body unlinked.)
Then run the conflict check (step 3), update the branch if it has fallen behind
base, and emit the fixed report block from step 5 with the `## ✅ PR 更新完了`
heading.

## Notes

- Do NOT create a PR unless the user asked for one.
- Keyword in the **PR description** is preferred over commit messages (visible,
  editable, survives squash).
- Issue and PR must live in the same repository for `#123`; use
  `owner/repo#123` otherwise.
- Always resolve conflicts so the merge preserves **both** branches' intent;
  when in doubt, ask rather than overwrite.
