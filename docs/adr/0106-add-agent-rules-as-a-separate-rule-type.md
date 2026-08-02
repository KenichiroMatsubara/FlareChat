# Add agent rules as a separate rule type

An Agent Rule runs an Organization-authored Prompt against a matched Source Message with a bounded tool set, and lives in its own table rather than as a mode column on Schema Rules, so that neither type carries the other's configuration. It is triggered only by a matching Source Message; scheduled work with no message in hand needs different tools and gives Selection Policy nothing to select, and is therefore a separate future feature rather than a variant of this one.

A Scheduled Event gains a nullable Agent Rule reference beside its existing Automation Rule reference, with a constraint that exactly one is present, which keeps the Owning Rule of ADR 0059 and the immutable Rule Revisions of ADR 0060 enforceable by real foreign keys instead of an unenforced polymorphic column.

Each run is bounded by a maximum tool-call count, a token ceiling, and a separate per-tool cap on writes, because a token ceiling measures how much the model thought rather than how many notifications members received. Exceeding any bound aborts the run into an Automation Exception.

## Consequences

ADR 0058 is narrowed: fetching, storing, and converting a Source Message still happens once, but AI extraction now runs once for the Primary Schema Rule plus once for each matched Agent Rule.
