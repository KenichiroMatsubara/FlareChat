---
status: superseded by ADR-0128
---

# Refresh Scheduled Events only through a confirmed manual exit

A Scheduled Event created before a product improvement keeps whatever its Calendar description said at the time: a raw Drive URL instead of a labelled link (ADR 0114), no Event Summary (ADR 0115). The Event Refresh is the one path that rewrites such an event. It runs from the Mailbox Test screen, one Source Message at a time, and writes only after an Admin has seen the current and the replacing value of each field. Unattended automation still never updates an existing Scheduled Event, because correlating every later message with an existing event is a larger decision than reformatting one that is already identified.

The refresh rewrites every Calendar field it can produce — title, description, location, start, end, and attachments — and deliberately overwrites Manual Overrides while doing so. ADR 0034 forbids that for automated Event Changes, where the writer is a stale message and the reader is nobody; here an Admin is looking at the diff and pressing the button for that single event. Attendees are the one field never written, because they come from Calendar Recipient Lists and attendance, not from the message.

Updates are applied with `PATCH` and an `If-Match` ETag precondition, and never as a delete followed by a create. A rewrite must not cost the event its identity: recreating it resets every attendee's response to needs-action, orphans the Attendance Registration links of ADR 0038, and shows participants a cancellation followed by an invitation. When the precondition fails, the event is re-read and offered again with its newest values, so the Admin can still force the write after seeing what changed underneath the plan — the exit is never closed, only made deliberate. Notifications are suppressed on every write, because reformatting a description is not news to a participant.

Each applied refresh updates the Scheduled Event's Organization D1 projection, writes a Delivery Record, and writes a Recovery Receipt (ADR 0093). The projection matters as much as the Calendar: attendance reminders read `events.starts_at`, so a Calendar-only rewrite of the time would send reminders for a time no longer scheduled. A Mailbox Test event still gets no `events` row, because `events_owning_rule_check` requires an owning Automation Rule and a manual test has none.

## Considered options

Deleting the existing events and recreating them from the extraction was rejected for the identity reasons above; it makes N-to-M correspondence trivial by discarding exactly the state worth keeping.

Refreshing during scheduled automation was rejected. The value of this feature is bounded — reformatting events that already exist — while unattended rewriting needs the full Event Change correlation of ADR 0012 and a defensible answer for every message that mentions an existing meeting.
