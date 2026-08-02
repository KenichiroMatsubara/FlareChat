# Deliver message summaries independently of events

A Message Summary is delivered per Source Message, including messages that yield no Event Candidate, because circulating what arrived is useful even when nothing becomes a Scheduled Event and because the summary is already produced by the extraction that looks for events, making its delivery free of additional AI cost. A Source Message that becomes an Automation Exception before any summary exists delivers an Intake Notice carrying only its sender and subject.

## Consequences

Summary delivery must run before the early return that marks an event-less Source Message as skipped. Delivery Records gain a Source Message reference and a nullable Scheduled Event reference. The Intake Notice is a deliberate exception to ADR 0032, which otherwise confines failure signals to the Operations Destination List.
