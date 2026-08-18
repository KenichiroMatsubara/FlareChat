# Call external MCP tools for real

An external MCP tool is called during the model's turn and returns its actual result, including its failures. ADR 0134's planning seam cannot cover it: the platform does not know the shape of a third-party tool's return value, so it cannot hand the model a planned result without inventing a success it did not observe. A model that cannot distinguish success from failure is not safer than one that acts — it is the same model reasoning from a fiction.

Safety for external tools therefore rests on the granted tool set rather than on planning. An Account names the servers and the individual tools each Automation may use, default deny, and the server's own `readOnlyHint` and `destructiveHint` are displayed but never relied upon, because the server declares them about itself.

The Execution Mode decides which tools are bound at all. Read-only binds no external tool whatsoever, so a preview cannot post to Discord through one and nothing has to judge which third-party tools write. Approval and unattended both bind them and both execute them during the run.

## Consequences

An unattended Automation holding an external write tool has no human gate before its external effects. It is bounded only by the granted tool set, ADR 0106's run ceilings, and ADR 0141's suppression window. ADR 0134's approval batch covers internal Rule Effects only, and this asymmetry is deliberate rather than an omission to repair.
