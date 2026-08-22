# Let an Account choose when attendance reminds

An Account chooses the milestones its attendance reminders are sent on, as whole days until the Response Deadline, held on `settings.attendance_reminder_days` and edited on the Reminders page beside the Task cadence. The product default stays seven, three, and one day before the deadline, so nothing an Account already relies on changes. ADR 0163 gave attendance only a switch and left ADR 0030's fixed set as the rule; this reopens exactly that, and nothing else.

The reason for leaving it fixed does not survive contact with the deadlines Accounts actually set. ADR 0163 argued that a Response Deadline which has passed can no longer be answered, and that is still true — but it is an argument about the far side of the deadline, not about how far ahead an Account may ask. An Event announced four days out never reminded at all under a fixed `[7, 3, 1]`, because its only reachable milestones were already behind it; an Event three months out asked nobody until the last week. The one screen in this product whose whole job is chasing an answer had no way to say when to chase, while the Task cadence beside it did. That difference read as an oversight rather than a decision, which is how the request arrived.

So the two cadences become one mechanism. `readReminderDays` already validated a list of whole days, folded duplicates, and ordered them furthest-from-deadline first; it is now named for reminders rather than for Tasks and is given the nearest milestone its caller will accept. `accountReminderDays` and `saveAccountReminderDays` read and write either setting by key. Both kinds keep their own switch, their own setting row, and their own default, and share every rule between those.

Attendance stops at the deadline day. `MIN_ATTENDANCE_REMINDER_DAY` is 0, where a Task may remind up to thirty days after its deadline, and the API refuses a negative attendance milestone rather than storing one that could never be honoured. This is ADR 0163's argument kept in the one place it holds: late work is still work, but a Registration answered after the Response Deadline is one FlareChat will not accept, so a reminder asking for it would be asking for something that cannot be given.

The Reminders page edits both cadences through the same control, because two lists of days that behave identically should not be two different screens. The attendance preview already existed and answers the new cadence for free: it reads the milestones and the unanswered Registrations on every request and composes each reminder through the same notice the delivery uses, so a milestone an Account adds is visible as an addressed, worded message before the switch is ever turned on.

An empty attendance list is accepted and means this Account never asks for an answer. It is the same sentence the empty Task list says, and it remains distinct from a switch that is off: one says "not on these days", the other says "not yet".

## Consequences

No Account's behaviour changes on this release. The stored default is absent for every Account, and an absent setting reads as seven, three, and one day before the deadline — the set ADR 0030 fixed and ADR 0163 kept. Both switches remain off until an Account turns them on.

The setting is another row in the existing `settings` key-value table, so no migration is added and no Account D1 changes shape. The milestones are read once per Account per enqueue pass, beside the query that finds the Registrations.

A corrupted `attendance_reminder_days` falls back to the default rather than to silence, for the reason ADR 0163 gave: silence is the one outcome an operator cannot tell apart from the feature working correctly on a week with nothing due.

`readTaskReminderDays`, `writeTaskReminderDays`, `MIN_TASK_REMINDER_DAY`, `MAX_TASK_REMINDER_DAY`, and `MAX_TASK_REMINDER_DAYS` are renamed to their reminder-wide forms. They are internal to this repository and have no external callers, so the rename is a rename and not a deprecation.
