# Let an Account choose when a Task reminds

An Account chooses the milestones its Tasks remind on, as whole days until the deadline, held on `settings.task_reminder_days` and edited on the Tasks page beside the Tasks themselves. The product default becomes seven, three, and one day before the deadline, the deadline day itself, and the day the work falls overdue. ADR 0030's fixed set survives as that default rather than as the rule.

The old shape could not be reached from the GUI at all, and could not express what an operator actually asks for. `TASK_REMINDER_DAYS` was a literal in `packages/domain`, so changing when a Task reminds meant editing TypeScript and shipping a release. Worse, the set was matched with `includes` against a count of whole days, so `[7, 3, 1]` could never match 0 or a negative number: the two moments people ask for by name — the deadline day, and the day the thing went overdue — were not merely unconfigured, they were unreachable. A product whose headline behaviour is reminding somebody shipped with no way to say when, and no way to say it at the moment it matters most.

A milestone counts days until the deadline, so 0 is the deadline day and -1 the day after it. Carrying overdue reminders as negative milestones rather than as a separate overdue flag keeps one number to configure, one comparison to make, and one idempotency key per milestone, which is what already stops a Task reminding twice for the same day. A separate flag would have needed its own suppression rule and its own answer to "how many times does overdue remind".

The range is thirty days past the deadline to a year before it, and at most twelve milestones. Reminding somebody about work that is a month late has stopped being a reminder and become a second inbox, and nothing needs more than a year of warning. An empty list is accepted and means this Account reminds about Tasks never. That is a deliberate difference from the Event Response window, where 0 was refused for being ambiguous: a window of no days silently drops every response, while an empty list of milestones says exactly one thing.

Both reminder kinds are off until an Account turns them on, and the switch is separate from the milestones. Messaging a roster is the one thing this product does that cannot be taken back, so it is not something an Account may discover it had been doing; a release that begins sending on everybody's behalf is not an upgrade, it is an incident. Keeping the switch separate from the cadence means turning reminders off does not have to destroy the milestones and turning them back on does not have to reinvent them. An empty list and a switch that is off both send nothing, but they answer different questions: one says "not on these days", the other says "not yet".

Attendance reminders get the same switch, and it is the only thing about them an Account may change. ADR 0030 fixed their milestones and this does not reopen that, because a Registration Deadline that has passed can no longer be answered.

A stored value that no longer reads as a milestone list falls back to the default rather than to silence. Silence is the one outcome an operator cannot tell apart from the feature working correctly on a week with nothing due, so a corrupted setting must not be able to produce it.

For the same reason a Reminders page shows what the chosen milestones will send, addressed and worded exactly as it will arrive, and not merely the numbers that were chosen. A cadence expressed as a list of integers is not something anybody can check: whether `-1` reaches the right Contact with the right sentence on the right day is the actual question, and it is answered by composing the preview through the same rule and the same notice the delivery uses. The preview cannot promise text the delivery would not send, because there is only one composition.

The preview is readable while the switch is off, and says that it is off rather than hiding. Deciding whether to turn reminders on is exactly the moment somebody needs to see what turning them on would send, and a screen that shows nothing until the feature is live can only be evaluated by going live. Both schedules therefore ignore the switch and answer only what the milestones and the current Tasks and Registrations imply.

The Job kind is delivered as well, which it never was: the rows were claimed and released on every pass, so every Account carries reminders queued on milestones that have long since passed. Delivering that backlog on the first run would arrive as one burst of messages about work whose deadlines are old news, so a reminder is sent only while the milestone it names is still the milestone today, and the Task is read again at delivery rather than trusted from the payload. A Task completed or handed to somebody else since it was queued says nothing, which is what ADR 0030 already required and what a queue written days earlier cannot know on its own.

Attendance reminders keep the fixed set ADR 0030 gave them. A Registration Deadline that has passed can no longer be answered, so an overdue attendance reminder would ask somebody for something the product will not accept; the Task case is the opposite, because late work is still work.

## Consequences

No Contact receives anything on the release that carries this, because both switches default to off and no Account has saved one. Attendance reminders, which ADR 0030 described as default behaviour, therefore stop being default behaviour; they had never in fact been delivered, so nothing an Account observes changes when they become opt-in.

The milestones an Account chooses while reminders are off are kept, so the cadence can be prepared and checked against the preview before anybody is messaged.

The setting is a row in the existing `settings` key-value table, so no migration is added and no Account D1 changes shape. The milestones are read once per Account per enqueue pass, beside the query that finds the Tasks.

Reminders can reach Contacts for the first time on this release, but only after an Account turns them on. The `task_reminder` and `attendance_reminder` Job kinds are both delivered now, where before they were claimed and released on every pass and reached nobody.

The staleness guard means a reminder missed because the Worker was down is not delivered late; it is dropped. That is the intended trade. A queue that catches up would tell somebody on Thursday that something was due on Monday, in the present tense, which is worse than saying nothing.

The preview reads the Tasks and the milestones on every request rather than caching. It is bounded by the unfinished, assigned, Channel-reachable Tasks an Account holds, which is the same set the queue already walks twice an hour.
