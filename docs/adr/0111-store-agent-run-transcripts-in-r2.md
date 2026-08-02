# Store agent run transcripts in R2

Every Agent Rule run writes an index row to Organization D1 — run identifier, Prompt and its revision, model, timing, outcome, tool-call count, tokens — while the transcript itself, holding the message body, converted attachments, and every tool call with its arguments and results, is encrypted into R2. A transcript can reach hundreds of kilobytes, and keeping it in D1 would inflate the per-Organization database that ADR 0084's cost model depends on. Delivery Records show what was sent but not what the model read or why it decided, which is the information needed to improve a Prompt and, because runs are never retried, to decide whether to re-run one.

Transcripts follow the Source Snapshot retention of ADR 0011: ninety days by default, configurable per Organization.
