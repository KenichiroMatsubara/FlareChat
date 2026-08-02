# Do not retry agent rule runs

A failed Agent Rule run is not retried, automatically or per delivery, and becomes an Automation Exception awaiting an operator's explicit re-run. The independent delivery retries of ADR 0014 work for a Schema Rule because its intended destinations are known before it executes; an Agent Rule decides them as it goes, so a retry re-enters a non-deterministic run rather than resuming a known one.

## Consequences

This diverges deliberately from Schema Rule behaviour: a LINE push rejected by rate limiting is lost rather than re-sent, and recovering it is an operator action. The Run Transcript exists so that the operator can see what the run did before deciding.
