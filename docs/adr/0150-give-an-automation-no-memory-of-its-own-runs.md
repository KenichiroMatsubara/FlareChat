# Give an Automation no memory of its own runs

An Automation starts each run knowing nothing of its previous ones. It is given no scratchpad to write into and no prior Run Transcript to read, and whatever it needs to know it reads back out of the systems that actually hold it — the Calendar, the Contacts, the Attendance Registrations, the Delivery Records.

A scratchpad would become a store of the agent's own claims that nobody checks, drifting from the world while the agent keeps trusting it, and ADR 0144's rule that a human's edit is immutable to the agent has no meaning in a place no human reads. Feeding back Run Transcripts is worse, because a transcript records reasoning rather than fact, per ADR 0111, so last week's guess would arrive as this week's premise and the cost would grow with every run.

ADR 0140 already accepted the price of re-reading the world on every run; adding memory would quietly refund that decision. What looks like a need for memory is usually a domain table: whether someone has answered lives in their Attendance Registration, not in a recollection of the reminder that was sent. A read-only view of an Automation's own past Rule Runs and Delivery Records is available for the narrower question of whether a send succeeded.
