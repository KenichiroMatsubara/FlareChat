# Invite the Active Member Roster to Every Scheduled Event

A Scheduled Event created from a Source Message now carries the active Members as Google Calendar attendees, written into the same insert that creates the event and sent with `sendUpdates=all` so each Member's own Google account receives the invitation. Until now the automation created the event on the Automation Inbox's calendar and stopped there: nobody outside the Organization's shared account ever saw it, and the only way to invite anyone was an Admin calling the recipient-snapshot endpoint by hand.

The invitee set is the Members roster rather than a Calendar Recipient List, even though Routing Policy describes a rule choosing lists. An Eligible Recipient is a Member — Attendance Registrations, Portal access, Task assignment, and reminder eligibility are all keyed by Member, and a typed list holds loose addresses that resolve to nobody. A list-driven invitation would therefore produce attendees who can be invited but never register, which is the opposite of what the roster exists for. Selecting a subset of Members per rule remains a later refinement of the same seam; it changes which Members are resolved, not that Members are what gets resolved.

Attendees ride on the create call rather than a patch per recipient. One request means one outcome to interpret: an event either exists with its attendees or does not exist at all, and no partially invited event is left behind for a retry to reason about. Google rejects an entire insert over one malformed address, so a roster address that cannot be an attendee is dropped before the request instead of failing the event for everyone.

The invited Members are frozen into the event's Recipient Snapshot at creation. Google Calendar's own attendee list is not that record: an attendee who removes themselves, or an Admin who edits the event by hand, changes it, and the Delivery Record then describes an invitation whose evidence has disappeared. The snapshot also names *which* Member each address belonged to, which the calendar cannot, and that is what a later Attendance Registration needs.

An event held as an administrative draft because a Public Attachment failed to publish is created with no attendees at all, and its invitations are recorded as `pending`. Withholding them is already the rule for an unpublished attachment; recording them as pending rather than omitting them is what makes the intended effect visible to the Automation Exception's retry, which would otherwise have no record of whom the event was meant to reach.

## Consequences

Every active Member with an address is invited to every automated event, because no rule can yet say otherwise. An Organization that wants a narrower audience has to deactivate Members or clear their addresses until per-rule Member selection exists.

A Member added to the roster after an event was created is not invited to it. The snapshot is the record of one delivery, not a live view of the roster, so reaching a late Member is a new deliberate act rather than a silent consequence of editing the roster.
