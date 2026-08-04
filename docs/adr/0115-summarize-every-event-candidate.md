# Summarize every Event Candidate

The product-defined extraction schema requires an Event Summary on every item of `events`, alongside the existing Message Summary for the whole Source Message. One Source Message often carries several independently scheduled programs — a ceremony and its reception, a district meeting and its registration session — and a single message-level summary cannot say what each of them is once they are separate entries in a calendar.

The Event Summary is the text a member reads when they open the calendar entry, so it is written as a short plain-text account of that one event: what it is, who it is for, and the venue, fee, or preparation the invitation states for it. It never repeats the start and end times, which the event already carries as structured fields, and it never summarizes the other events.

An extraction that omits the field is still accepted, and the Event Summary falls back to the event description and then to the title. A missing summary is a weaker calendar entry, not an unsafe one, and rejecting the whole extraction would withhold correctly extracted times over prose.

## Considered options

Reusing the Message Summary in every event's description was rejected: it repeats the deadlines and the other programs in each entry, which is what makes a multi-event invitation unreadable in a calendar.

Reusing the existing per-event `description` instead of adding a field was rejected. It is the short factual line that the review GUI shows next to the extracted times, and widening it into prose would degrade the screen where an Admin checks an extraction before creating real events.
