# Manage Tasks through Agent Rule tools

Schema Rules no longer apply Task creation effects. They continue to extract Event Details and a Message Summary, while an Agent Rule receives the complete Source Message and decides whether explicit actionable work exists.

The Agent Rule tool set includes `query_tasks`, `create_task`, and `update_task`. An Agent Rule must query existing Tasks before creating work and updates the matching Task when a later message concerns the same work. Task writes retain the triggering Source Message as provenance, validate Contact and Scheduled Event identifiers within the Account, and are idempotent for the same Source Message, deadline, and title.

An Event Response never creates a Task merely because it contains a returned form, an acknowledgement, an attendance answer, or a deadline. Promotional and informational messages are likewise not Tasks unless the Account-authored Agent Rule finds explicit actionable work. A Task may reference a Scheduled Event, with the event title snapshotted for stable display; a Source Message subject remains provenance only and is never used as an event name.

This release does not add an external MCP Server. The internal Agent Rule Tool seam is implemented first so the same bounded Task operations can later be exposed through an explicitly granted Tool Grant.

## Consequences

Legacy `schema.create_tasks` effects remain readable and applicable for already persisted runs, but new Schema Rule plans do not produce them. Existing Task, Contact Page, reminder, and Account API behavior remains available. The task table gains nullable Scheduled Event fields through migration 0031.
