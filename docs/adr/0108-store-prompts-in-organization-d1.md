# Store prompts in organization D1

Prompts live in the Organization D1 database rather than in Workers KV, despite being read far more often than written. KV is eventually consistent, so the most common operation — editing a Prompt and immediately testing it — could read the previous text and present itself as unstable model output. A Prompt in KV also cannot participate in the atomic immutable Rule Revisions of ADR 0060, which matters more for a non-deterministic Agent Rule than for a Schema Rule, and it would not move with a D1 Time Travel restore under ADR 0092, leaving rules in the past and Prompts in the present.

The performance argument does not apply: a Prompt is read once immediately before a multi-second call to a model provider. If it ever does, a cache in front of D1 can be added without making KV the source of truth.
