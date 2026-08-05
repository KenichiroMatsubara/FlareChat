# Classify the Source Message kind inside its one extraction

The product-defined extraction schema gains a field stating what kind of message it just read, and a Source Message classified as an Event Response never creates a Scheduled Event. Its extracted event fields are used only to locate the Scheduled Event it answers.

An upsert cannot fix this on its own. Upsert is the operation "merge when a match is found, insert when none is", so a message that fails to correlate always inserts. A reply that quotes its invitation correlates cleanly and merges to no change, but an attendee-action notification whose extraction picked up the notification's own send date, or a registration deadline read as the event date, lands weeks away from the real meeting, falls outside the seven-day bound of ADR 0123, and becomes a new event with the whole Member roster invited. Widening the bound to catch it only widens the window in which a candidate merges into the wrong meeting. No setting of that one dial removes both failures, because they are failures of different things: one is a duplicate, the other is an event that was never proposed by anybody.

The classification is free. The extraction is already one call per Source Message under ADR 0058, already `strict: true` JSON Schema, and already produces the event fields; the kind is one `enum` on the response it was returning anyway. Prompting alone was not enough to reach for, either — the instructions opened by asserting that the message *is* an invitation, so the extraction had no way to say otherwise even when the answer was obvious from the text.

Because an Event Response never writes event fields, the accuracy comparison the merge performs is left with only the case where it has something to compare: two messages that each assert what the meeting is, an invitation and a genuine later update. Asking a model which of a quoted invitation and its own quotation is more accurate was never a question with an answer in the text, and it is no longer asked.

An Event Response locates its Scheduled Event within sixty days of that event's start rather than the seven days a merge is bound to. The seven-day bound exists because a `PATCH` carries an event's attendees onto whatever it lands on; an Event Response performs no such write, so the worst outcome of a wrong correlation is a Guest Registration on the wrong event. A registration returned weeks ahead of a meeting, or one stating its own deadline rather than the meeting's date, would be dropped without trace by the tighter bound.

## Consequences

An Event Response that locates nothing is discarded silently. It is a message that proposed no event, so there is nothing to withhold and no Automation Exception to raise, but it also means a genuine registration whose correlation fails leaves no record that it was seen.

Everything an Event Response carries other than events is processed as for any Source Message: its Message Summary is delivered on the schedule of ADR 0104, its Tasks are created, and its attachments are published.
