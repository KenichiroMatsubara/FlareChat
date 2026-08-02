# Approve agent writes as a batch after the run

An Agent Rule has three execution modes — read-only, writes with human approval, and writes without approval — and new rules default to approval, which is the only mode that shows what a rule will do before it does it. Under approval, write tools record a proposal and return immediately, the run continues to completion, and the resulting batch is approved or rejected as recorded arguments; approval then executes those arguments without invoking the model again, so what was approved is what is sent. Unapproved proposals expire after seven days and are recorded as expired.

Suspending the run at the first write and resuming it after approval was rejected: it costs one AI call and one human round trip per write, buying only the model's ability to see its own delivery results, which no intended use of this feature needs.

## Consequences

Agent Rules have no Draft state, since approval mode supersedes it; ADR 0061's Draft, Active, Suspended, and Archived therefore apply in full only to Schema Rules, and Agent Rules use Active, Suspended, and Archived. A model told that its message was recorded as a proposal may still report having sent it in its final text, which is a statement in the Run Transcript rather than an external effect.
