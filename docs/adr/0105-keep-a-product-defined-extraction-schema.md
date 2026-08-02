# Keep a product-defined extraction schema

Schema Rules extract against a schema the product defines, and Organizations gain flexibility through Agent Rules instead of through schemas of their own. An Organization-authored JSON Schema would have to be bound to external effects by name convention or explicit mapping, and both bindings fail expensively: a mistaken start-time mapping produces real Calendar events and real invitations to members, authored with the help of an AI chat and reviewed by an Admin who cannot easily see the difference.

## Considered options

Reserved top-level names with free extra fields, and fully renameable fields carrying `x-role` annotations, were both explored. Both were rejected for the same reason: the fields that reach Google Calendar and LINE are exactly the fields where an authoring mistake is unrecoverable, so their names stay fixed and the freedom moves to the Agent Rule path, where a bad Prompt costs one wrong message rather than a wrong invitation.

Exposing an MCP server so that an Organization's own AI client could work over its mail was also rejected. Mail is already reachable through existing Gmail MCP servers and Workspace connectors, so mediating it adds nothing, and the product already runs a BYOK model in-process, which makes the product the client rather than the server. What remains unique — the Organization's own Scheduled Events, Tasks, attendance, and delivery history — is worth exposing only once that history exists.
