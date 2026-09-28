# Take mail in once a morning and send one Morning Notice

Each Automation Inbox is now read once a day, at 05:00 Asia/Tokyo, rather than every three hours, and nothing a Source Message causes is sent to a reader when it happens. Its Source Message Notice, an Intake Notice, and a LINE message an Agent Rule writes are each kept as a Morning Entry for the address they would have gone to. Once that morning's intake has finished, every address receives one Morning Notice that carries all of its Morning Entries, together with the Task and attendance reminders due that day. Each address receives one message a day, not one per mail.

Under ADR 0160, a mail that arrived at 10:00, one at 11:00 and one at 14:00 reached the same group room as three separate LINE pushes at three different times. A Task reminder then arrived at whatever time of day its deadline carried. LINE counts one push to one address as one message, however many message objects it holds. So the room's monthly quota paid for every mail, and readers were interrupted throughout the day by news that none of them needed before the next morning. Taking the mail in once and speaking once serves both the quota and the reader. Packing a room's whole morning into as few text objects as possible, and those into Delivery Batches of five, keeps the day's messages to that address at one in all but an extreme morning.

## How the morning is kept

**One cron.** Only one cron remains, `*/30 * * * *`, and the morning is a boundary it crosses rather than a cron of its own.
- An Automation Inbox owes an intake when its last completed read is older than the latest 05:00. The first tick at or after 05:00 starts that read.
- A single cron means two invocations can never read the same Inbox at the same moment. The two crons of ADR 0160 would both have fired at 20:00 UTC.

**A cap on each invocation.** One invocation reads at most a fixed number of Gmail messages, shared across every Account.
- A read that hits the cap saves the Gmail history cursor at the last history record it finished. The next tick continues from there.
- A day of mail is therefore never one invocation's worth of D1 queries and subrequests, which three hours of mail could still be.
- A read that fails is retried on the next tick rather than the next morning.

**When the Morning Notice is sent.** An Account's Morning Notice is sent on the first tick after its intake for that morning has completed. It is also sent at 07:00 regardless, so an Inbox whose grant was revoked does not also withhold the day's reminders.
- A settings row records the morning that was last sent, so each morning is sent once.
- A Morning Entry whose send fails is attempted again on each tick, up to three attempts. After the third it is marked failed.
- Every attempt leaves one Delivery Record per Morning Entry, naming the Source Message it came from, so the audit still reads per Source Message.

**Where a Morning Entry goes.** The address is resolved when the entry is kept.
- A Source Message's reader is reached by email when the Contact holds an address, and otherwise on the first Channel they are reachable on (ADR 0166).
- A reminder is reached on LINE, as before.
- An address that holds entries from several Source Messages receives them in one Morning Notice: one email, or as few LINE or Discord messages as the text limits allow.

**Reminders.** A Task or attendance reminder is counted in days of the Asia/Tokyo calendar and kept at the morning it falls on.
- Its key is the one ADR 0171 gave the Job that used to carry it. A reminder already sent by the Job path before this release is therefore not sent a second time.
- Reminders an outside agent scheduled for a stated time (ADR 0156) stay Jobs and still arrive at that time.

**What is still sent immediately.** A Channel Test, an Automation's `channel.send`, and the MCP Server's `channel.send` are each an explicit request to speak now. An Automation's own Schedule states when it speaks, so none of them waits for the morning.

**Running intake by hand.** The GUI's run button reads the Inbox immediately and applies what it finds. The Morning Entries it produces wait for the next morning, as do those produced when a pending Rule Run is approved. A reader still receives one message a day. The operator checks the result on the screen, and checks a Channel on its own with the Channel Test.

## Consequences

**Latency.** A Source Message is now seen up to twenty-four hours after it arrives.
- A mail that arrives at 06:00 about something that evening reaches its readers the following morning, after the event.
- That is the price of one message a day, and it is paid knowingly. An Account that needs a mail acted on sooner runs the intake by hand, and its Calendar writes happen at once.

**Superseded decisions.**
- This supersedes ADR 0160's two crons.
- It supersedes the part of ADR 0159 that delivers the notice once per Source Message. The notice is still composed per Source Message, but it is carried in the Morning Notice.
- It supersedes the time of day of ADR 0163 and ADR 0164's reminders. The milestones themselves are unchanged.
- ADR 0019's 60-second window becomes one morning.

**Storage and failures.**
- Morning Entries live in each Account D1, in `morning_entries`, added by migration 0032.
- Entries that were sent or failed are deleted thirty days later, and their Delivery Records remain.
- An Agent Rule's `send_line_message` now succeeds when its entry is kept. A refusal from LINE appears as a failed Delivery Record the next morning, not as the effect's result.
