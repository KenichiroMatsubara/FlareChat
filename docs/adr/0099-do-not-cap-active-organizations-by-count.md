# Do not cap active Organizations by count

A deployment does not impose a fixed limit on the number of active Organizations. Organization count is not a reliable proxy for Workers, D1, R2, or external-provider consumption, so resource-specific capacity and cost policies handle pressure instead. Organization provisioning and activation therefore do not depend on an Organization-count setting. This supersedes ADR 0074.
