# Let Every Control Report the Work It Started

Every control in the administration GUI and the Member Portal now names the operation it starts, and only that control reports its progress. A screen keeps one set of in-flight operation keys rather than a handful of booleans, so a Task being written no longer disables the mailbox scan, and approving one Proposed Action no longer makes the rule-creation button say it is creating a rule.

The old shape was one boolean per area — `busy`, `ruleBusy`, `memberBusy`, `mailTestBusy` — shared by every operation in it. Sharing produced two failures at once: an unrelated control froze, and a control that was frozen displayed a label describing work it had not started. Both are worse than no indicator, because the screen states something untrue about what it is doing. Keys are per row where rows exist (`task:<id>`, `prompt:update:<id>`, `proposed-action:<id>:approve`), so two rows of the same kind never share one, and approve and reject are separate answers rather than one "deciding" state.

A control that has no label to change reports in place. A field saved on blur has no button to relabel and no moment the Admin can point at, so it states 保存中… while the write runs and 保存しました for two seconds after it lands; without that, a blur save is indistinguishable from a lost one. The same rule covers the assignee selector, the Agent Rule state selector, and every Member Portal answer.

A control reporting in place is not enough on its own. On a phone the control that started the work is often scrolled out of view — the button that says 検索中… sits above the fold while the Admin reads the results below it — so the running operations are also named once in the centre of the screen. That card floats without a scrim and without taking pointer events: every control is already disabled individually, so blocking the page would only stop the Admin from reading it while they wait.

Route data loading is progress too. The root layout's navigation bar of ADR 0126's follow-up already reports that a loader is running; the dashboard adds what a bar alone cannot say, dimming the stale page and marking it `aria-busy` so the content on screen is visibly not the content being loaded.

Success is reported where the outcome is otherwise invisible. Saving a connection changes only a small "接続設定済み" line that was already there before the save, so the card now says 保存しました. A reassignment that skips a Task names the Tasks it skipped, instead of leaving an Admin to compare the table against what they accepted.

## Consequences

Adding an operation means adding a key. A handler that calls the API without one reports nothing, which is the same defect this replaces; the operation-key module is the one place to look for whether a screen covers all of its work.

Progress is per screen, not per application. Two browser tabs, or a background Job the Worker runs on its own schedule, are still invisible to the GUI — an Admin sees only the operations their own screen started, and a long automation run reports that it is running rather than how far it has gone.
