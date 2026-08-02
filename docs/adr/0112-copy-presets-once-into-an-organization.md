# Copy presets once into an organization

A Preset is a self-contained JSON document in this repository — rules, Prompts, Operational Task Roles, and empty typed lists — copied wholesale into an Organization when applied and unlinked from the product thereafter. A living template that propagated improvements would let a release silently change a customer's automation, which contradicts ADR 0060's pinning of events to immutable Rule Revisions; documentation alone would lose the working starting point that makes the configuration imitable.

Being a plain document, a Preset is also the artifact an Organization hands to an AI chat to adapt for itself. One Preset ships initially, for a membership organization with schedule and treasury roles and a summary destination, because further Presets would multiply unverified configurations.

## Consequences

This is what keeps the product general: the vocabulary of any particular organization exists only as sample strings inside a Preset, never in the schema, the extraction request, or the GUI.
