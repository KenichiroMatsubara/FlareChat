# Keep Scheduled Event as a platform concept

Scheduled Event, with the lifecycle, correlation, merging, refresh, attendance, snapshot, and manual-override semantics that roughly forty existing ADRs describe, stays in the platform rather than dissolving into a Calendar tool or into an Account-defined record type. The platform is therefore not domain-neutral: it knows two domain nouns, Contact and Scheduled Event, and CONTEXT.md's claim that it never knows the vocabulary of any particular organization no longer holds.

An Account-defined record type was rejected because ADR 0100 gates every release on a verified migration of every recorded database, which a per-Account dynamic schema makes unverifiable, and because an agent's tool arguments could then no longer be typed. Demoting the concept to a Calendar tool was rejected because this behaviour is code, and ADR 0137 promises that a configuration reproduces today's product — a configuration cannot restore deleted code. These are also the operations an agent performs worst and where a mistake deletes a real event or overwrites a person's correction.

Generality is delivered by MCP tools, Channels, and the conversational surface. The Calendar is the deliberate exception that is not generalised.
