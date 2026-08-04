# Correlate Scheduled Events by their Source Attribution

The Event Refresh finds the Scheduled Events a Source Message already produced by searching the Automation Inbox calendar for the Gmail message ID and reading the Source Attribution — the sentence at the end of the description naming that message. Every generation of the product has written this sentence since attachments were first published, so it is the only correlation key that exists on the events this decision needs to reach.

Google Calendar's `extendedProperties` would be the natural place for a private identifier, and it is not used here. The events worth refreshing are precisely the ones created before the improvement, and no earlier version wrote such a property; adding it now would identify only events that no longer need identifying. Parsing the description is the price of reaching the existing calendar.

The sentence is therefore a contract, and the wording is unified to `Mail Automation が Gmail メッセージ {id} から作成しました。` for every writer. The Mailbox Test previously wrote a variant naming itself, which was both a second pattern to parse and, after a refresh rewrote a scheduled event's description, a false statement about which path had created it. Which screen an Admin used is a fact about the run, not about the meeting, and it is recorded in the Delivery Record and Recovery Receipt instead. The reader still accepts the older wording, because past events keep whatever they were written with until someone refreshes them.

## Consequences

A description an Admin rewrites by hand, deleting the sentence, drops out of correlation and can no longer be refreshed from its Source Message. That is acceptable: the alternative is an identifier the Organization cannot see and cannot remove from its own calendar.
