# Ship the MCP server third, with repeat suppression

The MCP server of ADR 0152 ships third, revising ADR 0148's order to rename, Operator Chat, MCP server, scheduled Triggers, Discord. It depends only on the Tool Grant that Operator Chat introduces; the sending and roster capabilities behind its two tools already exist, and the Contact List it is bounded by arrives with the rename. It is also the first release an Account can see, which ADR 0148 recorded as the cost of putting two invisible releases first.

Repeat suppression moves out of the scheduled-Trigger release and ships with it. ADR 0141 placed the Suppression Window where scheduled runs first needed it, but ADR 0152 makes it the main protection against a caller whose reasoning happens somewhere else, and it has no dependency on Triggers — it derives a key, consults ADR 0010's Delivery Record, and honours a declared window. Shipping an externally reachable write path before it would open the surface without the thing that guards it.

Claude's custom connectors accept a static bearer token in a request header, so ADR 0151's static-token-first stance covers this side too and no OAuth authorization server is needed to be reachable from outside.
