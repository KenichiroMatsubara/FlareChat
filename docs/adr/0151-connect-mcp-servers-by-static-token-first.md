# Connect MCP servers by static token first

An Account connects an MCP Server with a static bearer token or API key, stored under ADR 0078's envelope encryption exactly as any other credential. OAuth for MCP — dynamic client registration, an authorization callback, and per-Account token refresh — is deferred to the release that adds scheduled Triggers.

Many hosted servers, including Cloudflare's own, are OAuth-only, so this genuinely narrows what can be connected to self-hosted servers and to services that still issue keys. It is accepted because ADR 0148 gives the Operator Chat release the job of proving the Tool Grant and MCP client wiring under human observation, and one connectable server proves it. Carrying an OAuth implementation into that release would cost it the speed that justifies shipping it before anything visible.
