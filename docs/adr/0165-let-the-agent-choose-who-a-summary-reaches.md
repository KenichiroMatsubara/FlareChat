# Let the Agent choose who a summary reaches

An Agent Rule can email one summary per recipient through a `send_email_summary` tool, addressed to a single destination it names, drawn from the same permitted recipient set `create_scheduled_event` already draws from. It chooses which of those recipients the summary is for. It can choose none of them.

Until now only a Schema Rule could send a summary, and it sent one to every enabled item of its recipient Lists. Broadcast is the wrong default for a summary. Most Source Messages concern a few people on a roster, and a rule that mails all of them makes the notice worth less each time it arrives: the recipient who is never the subject learns to skip it, and is skipping it on the day they were. Volume is not the cost. Attention is.

The set of possible recipients stays the operator's. The Agent is handed the resolved destinations and the tool seam refuses any address outside them, so the model selects from a roster rather than composing one from Source Message text it was told to distrust. That containment is what makes delegating the choice safe: the worst case is a summary reaching a permitted recipient who did not need it, which is exactly the current behaviour for everyone.

Sending is one call per recipient, not one call carrying a list. Each recipient is then a separate planned action, a separate Rule Effect, a separate approval decision, and a separate Delivery Record — so an operator in approval mode can reject one recipient without rejecting the summary, and a single failed address does not mark the rest undelivered. It also makes the per-run cap count recipients, which is the quantity worth bounding.

This is ADR 0137's strengthening step, not a Schema Rule change. Schema Rules keep broadcasting to their Lists until they are deleted.

## Consequences

An Agent Rule can now decide a Source Message is worth nobody's summary and write nothing. A run that sends no email is a successful run, and the Run Transcript is where the reasoning for that is read. Anyone measuring the platform by messages sent will read this as a regression.

The choice is only as good as the Prompt and the roster it is given. A permitted List of one undifferentiated group address gives the Agent no choice to make, and the behaviour collapses back to broadcast.

`proposed_actions.tool` accepts a third value, so the table is rebuilt by migration `0029`. Rows written before it keep their tool names.
