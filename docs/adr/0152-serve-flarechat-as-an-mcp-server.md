# Serve FlareChat as an MCP server

FlareChat exposes its own capabilities over MCP so that an outside agent — Claude Cowork, a GPT, or anything else speaking the protocol — can reach an Account's Contacts and Channels. This adds a third entrance to the engine ADR 0146 describes, beside Operator Chat and the Trigger, and the smallest useful one is two tools: resolving a Contact and sending on a Channel. The address book and the sending are one feature rather than two, because a caller cannot address anyone without the first and cannot do anything with the second alone.

An external caller is admitted through an Access Token carrying one Tool Grant, so no authorization concept is invented for it; it is simply a consumer of the boundary ADR 0142 already defines. The Token additionally names a Contact List that bounds who it may reach. Tool Grants are tool-scoped rather than row-scoped, so `channel.send` alone would reach every Contact the Account has, and an outside agent acts on documents, mail, and pages its operator never wrote — an instruction planted in one of them would otherwise become a broadcast from the Account's own LINE channel. Tags were rejected as the bound because ADR 0144 lets an agent write into empty fields, which would let it widen its own reach; a Contact List is edited by people only.

## Consequences

ADR 0106's tool-call, token, and write ceilings bound this session's own agent loop and cannot bound someone else's, so an Access Token needs its own rate and write limits, and ADR 0141's Suppression Window becomes the main protection against a caller whose reasoning is not observable here.

Replies do not return to the caller. An answer on LINE or Discord arrives as a Trigger, so a sending Token is write-only in practice until a separate decision exposes conversation history to outside agents.
