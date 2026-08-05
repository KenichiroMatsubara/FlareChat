# Invite the active Member roster through the Event Refresh exit

The Event Refresh exit now invites the active Member roster the same way ADR 0125 invites it on creation, both when the exit creates a Scheduled Event and when it updates one an Admin already confirmed. ADR 0121 excluded attendees from this exit because, at the time, an attendee came from a Calendar Recipient List or from attendance — neither of which the exit's Source Message re-extraction could speak to. ADR 0125 replaced that entirely: an attendee is now the active Member roster, resolved fresh at write time and independent of any message. That is exactly what the Event Refresh exit already resolves everything else from, so withholding attendees no longer protects anything; it just leaves a Member invited by the ordinary automation absent from a test-created duplicate, or never invited to an event an Admin corrected by hand before the roster path existed.

The write is additive, never a replacement. Immediately before the write, the exit reads the event's current Calendar attendees — not the plan-time snapshot, which may be stale by the time an Admin approves — and appends only the active Members missing from that list, exactly as Google returned them: `email` on. A Member already listed, invited by an earlier automated run or a previous Event Refresh, keeps whatever they answered; the request never sets `responseStatus` for an attendee Google already lists, and Google Calendar only changes what a request supplies. This is what ADR 0121's underlying concern — an Admin's rewrite must not cost anyone their attendance record — still requires, now applied to attendees instead of excluding them.

`sendUpdates` follows whether the merge actually added anyone: `all` when it did, so the newly invited Members receive the same Calendar invitation ADR 0125 sends on creation, and `none` when every active Member was already listed, so a pure field-formatting refresh stays exactly as quiet as ADR 0121 intended. Every other rule from ADR 0121 is unchanged: `PATCH` with an `If-Match` ETag rather than delete-and-recreate, every non-attendee field rewritten even over a Manual Override, and no Organization D1 `events` row for a Mailbox Test event, so these invitations carry no Recipient Snapshot and no Delivery Record — `events_owning_rule_check` still requires an owning Automation Rule a manual test does not have. A Member invited this way is visible only in Google Calendar's own attendee list, not in the frozen roster history ADR 0125 gives automated events.

This supersedes ADR 0121.

## Consequences

An Admin who repeatedly refreshes the same event does not re-notify Members who already answered; only a roster change since the last refresh produces a notification, and only to whoever is new.

A Member added to the roster after a Scheduled Event exists is not reached until an Admin runs a refresh over that event — the Event Refresh exit becomes, incidentally, the way to extend an older event's invitations to a since-added Member, alongside its original purpose of reformatting stale fields.

An event refreshed this way still has no Recipient Snapshot or Delivery Record for its invited Members, unlike one ADR 0125 created directly. An Admin auditing who was invited to such an event has to read Google Calendar's attendee list itself.
