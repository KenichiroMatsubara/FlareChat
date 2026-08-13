# Sequence the rebuild rename first

The rebuild ships in four releases: the rename, then Operator Chat, then scheduled Triggers with Tool Grants and Suppression Windows, then Discord.

The rename ships alone and changes no behaviour, because ADR 0100 gates every release on a verified migration of every recorded database and a failed fleet migration cannot be told apart from a failed feature when both ship together. ADR 0117 already took this route through the previous rename.

Operator Chat comes second although it adds no visible capability, because it introduces no inbound endpoint and no new provider and can therefore be built before the Channel abstraction is real, because a human watching every exchange is the safest place to first exercise Tool Grants and an MCP client, and because it is the instrument used to debug the two releases after it. Building unattended scheduled runs or a new Channel first would mean diagnosing an agent with no interactive way to ask it anything.

Discord is last despite being the most visible, so that the Channel abstraction is settled after Triggers are generalised rather than shaped around one provider's convenience.

## Consequences

Two consecutive releases change nothing an Account can see.
