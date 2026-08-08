# Keep Mailbox Test separate from Draft Rule Preview

Mailbox Test remains a permanent operational check of the configured Automation Inbox. An Admin selects a real Gmail message and previews it through the same Active Primary Schema Rule selection, permitted Operational Task Roles, attachment conversion, and OpenAI-compatible provider path used by live Automation. The shared preparation module returns the selected Rule Revision and validated extraction; live processing decides how to record and execute the resulting plan, while Mailbox Test stops before those effects.

Search, request review, and extraction preview do not persist or change a Source Message, advance Gmail history, create a Rule Run, or write to Calendar or Drive. This matters operationally: a preview record using the real Gmail message id would make the live inbox regard that message as already known and silently skip it.

After preview, a short-lived encrypted confirmation token is bound to the Mailbox Test purpose, Gmail message id, selected Active Rule Revision, and exact extraction. An explicit confirmation may create only the reviewed Calendar events and publish their accepted attachments to the configured Drive folder. It creates no Organization `events` or `tasks` projection, no recipient delivery, no Rule Run, and no other live Rule Effect. The token cannot be reused as a Draft Rule Preview token.

Draft Rule Preview remains on Rule Runs and continues to name one Draft Schema Rule Revision, evaluate its Selection Policy, and persist a side-effect-free read-only Rule Run. Its required Source Message foreign key uses a namespaced preview identity rather than the real Gmail message id, so previewing a Draft Rule cannot consume mail that live Automation has not processed.

The administration GUI therefore exposes Mailbox Test and Rule Runs as separate routes. Event Refresh consumes only a Mailbox Test extraction, because it is another deliberate manual exit rather than a Draft Rule Run effect.

This supersedes only ADR 0134's removal of rule-free Calendar confirmation and its definition of Mailbox Test as a Draft Rule Run. ADR 0134's common Rule Execution planning, immutable effects, approval, retry, and execution-mode decisions remain unchanged.
