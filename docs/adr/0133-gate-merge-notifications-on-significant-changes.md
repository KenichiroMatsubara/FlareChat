# Gate merge notifications on Significant Changes

ADR 0036 decided which changes reach Members four years before anything could act on it, and no code ever mentioned it: the automation path only ever created events, and creation always notified. The merge of ADR 0130 is the product's first unattended repeated writer, so Significant Change is implemented here, where it first has something to gate.

A merge notifies Members when it changes a Scheduled Event's date, time, location, or Registration Deadline, and updates the Calendar silently otherwise. The field a merge rewrites most often is the description: a second message about the same meeting produces a fresh Event Summary while the date and venue stand unchanged, and notifying on that would mail every Member several times about a meeting that never moved. ADR 0036 named exactly this exclusion.

Silence for everything was rejected in the other direction. A genuine venue change would update the calendar correctly and reach nobody, and with no Admin approving the write there is no human anywhere in the path who learns it happened. An automation that changes a meeting without telling its Members is worse than one that does not run.

The judgement gates both channels. `sendUpdates=all` makes Google mail the invited Members, and the Member-facing LINE message is separate, so a Significant Change decided for one and not the other would leave a Member receiving the mail with no LINE message or the reverse, each contradicting what the product told them to expect. Guest Registrations move neither the meeting nor its deadline, so a registration arriving from another organization writes with `sendUpdates=none` however many people it names.
