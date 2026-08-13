# Let the agent fetch its own work

A scheduled Automation starts with no payload and uses its bound tools to find whatever it needs. ADR 0106 deferred scheduled work on the grounds that it gives Selection Policy nothing to select; the resolution is that Selection Policy is not generalised at all. Building a Source abstraction that yields items would stand a second retrieval mechanism beside the `list` and `search` tools that MCP servers already expose, narrowing the platform rather than widening it.

A Trigger therefore either carries a payload or does not. An inbound channel message triggers a run with that message in hand, exactly as a Source Message does today; a schedule triggers a run with nothing. Both kinds reach the same Rule Execution planning and apply seam of ADR 0134, whose one remaining assumption — that live orchestration begins with one persisted Source Message — is what this decision removes.

## Consequences

Cost per run is bounded by ADR 0106's tool-call, token, and write ceilings but is no longer knowable before the run starts, so ADR 0053's budget can only stop a run rather than decline to schedule it.
