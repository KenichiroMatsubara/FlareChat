# Rebuild as a general automation platform

The product becomes a general automation platform with a conversational surface, scheduled execution, MCP tool binding, and multiple contact channels, and the Gmail-to-Calendar-and-LINE behaviour that ADR 0001 describes becomes one configuration of that platform rather than the product itself. ADR 0063 rejected chat, Agents, and MCP as out of scope and ADR 0064 omitted a general chat surface; both are now superseded, because the platform can only reach the intended generality if those three are first-class.

Nothing is migrated by rewriting a Schema Rule into its general equivalent. Agent Rules are strengthened until they cover what Schema Rules do, at which point Schema Rules are deleted. Until that point both rule types exist side by side, so ADR 0106's separation of the two remains correct rather than becoming debt, and the retreat path stays open if the general engine never matches a Schema Rule's predictability or cost.

## Consequences

The two rule types converge on one entity only at the end of the migration, not at its start, so no release in between should be judged against the unified model.
