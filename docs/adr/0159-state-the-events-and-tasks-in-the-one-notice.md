# State the events and Tasks in the one notice

A Source Message produces one message to its readers. The Message Summary, the Scheduled Events that message created, and the Tasks it raised are composed into one text and delivered once, to the Channel Handle List and the Calendar Recipient List the Rule already permits.

Delivering the summary alone was the smaller half of the news. A Contact reading LINE learned what the mail said and nothing about what FlareChat did with it: the events appeared on a Google Calendar the reader has to open, written with `sendUpdates=none` so Google mails nobody, and the Tasks reached only their own assignee at the seven, three, and one day milestones. The one reader who most needed the whole picture — the group room the Account watches — saw the least of it.

Two or three notices would have been worse than one. They arrive in whatever order the provider delivers them, they cost a request each against the same LINE quota, and they leave the reader to work out that the summary, the meeting, and the deadline all came from the same mail. `notice.ts` composes them instead: the summary, then the events under 【予定】, then the Tasks under 【タスク】, with an empty section left out entirely, so a message that produced neither reads exactly as its summary did before.

The notice therefore has to be planned last. `deliver-summary` now depends on `apply-events` and, when the extraction stated any, on `create-tasks`, so the message is written after the work it describes actually happened. This is what makes the text honest rather than optimistic — a notice sent first would announce a meeting that the Calendar write then failed to create. The Tasks are read back from the database rather than restated from the extraction, because the assignee is resolved from the Operational Task Roles when the Task is created and 山田 is more use to a reader than a role identifier.

An Event Response contributes no events to its notice. Its extracted event fields locate the Scheduled Event it answers and create nothing (ADR 0131), so listing them under 【予定】 would announce a meeting that already existed as though this message had made it.

## Consequences

A Rule Run whose events permanently fail to apply now delivers no notice at all, where it previously delivered the summary. That is the cost of the dependency, and it is the right side to fail on: the alternative is a message describing events that do not exist. The Source Message still becomes an Automation Exception, and the run's effects remain visible and retryable in the GUI.

Times are stated in `Asia/Tokyo`, the zone every Calendar write already uses. An instant the extraction wrote that cannot be read as one is repeated verbatim rather than replaced by a date this could not derive.

The notice is longer than the summary was, and LINE charges by message rather than by character, so the wider text costs no more than the summary alone did.
