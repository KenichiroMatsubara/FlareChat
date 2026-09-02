# Remind through one Reminder Schedule

Task reminders and attendance reminders are one Reminder Schedule module with one interface — what is coming, what is due, and deliver this one — and the subject of a reminder, a Task or a Registration, is a distinction inside it. ADR 0163 and ADR 0164 gave the two subjects separate milestone settings, and they keep them; what they never asked for was two implementations.

The two modules were line-for-line twins that differed in a table name and a notice, and so were their two Job handlers. Each wrote its Job rows by hand instead of through the Job module of ADR 0073, because that module could not take a delivery time, and the third caller that did use it then updated the row it had just inserted to set one. Three callers had invented three idempotency-key formats for the same idea. The rule that a queued reminder is delivered only while its milestone is still today, which exists so that a backlog never arrives as one burst, was written twice and had to be kept right twice.

Reminder Schedule computes Reminder Milestones once, enqueues through the Job module — which gains the delivery time it was missing — under one Job kind and one key format naming the subject, the thing, the Contact, and the milestone, and delivers through the Channel seam of ADR 0158. A reminder an outside agent schedules under ADR 0156 is the third subject, carrying a stated time instead of a milestone. Reading the Reminder Schedule ahead of time, as CONTEXT.md promises, reads all subjects from the same place.

## Consequences

Pending reminder Jobs under the old kinds are rewritten to the new kind by a migration, so the release ships under the gate of ADR 0100 like any schema change. The Reminders screen shows one schedule with a subject column rather than two lists.
