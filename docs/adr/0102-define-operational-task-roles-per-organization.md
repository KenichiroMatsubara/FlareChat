# Define operational task roles per organization

Operational Task Roles are rows owned by each Organization rather than a fixed `organizer` and `treasurer` enum in the schema, the AI response format, and the GUI. An Automation Rule selects the subset of roles it may assign, while the holder of each role is named once per Organization, because a role is the Organization's own division of labour and not a property of the rule that happened to produce a Task. The extraction request builds its role enum from that set at request time and shows the Organization's display name and description so the model retains a semantic signal, while a Task stores the stable role identifier alongside the display name captured when it was created.

## Consequences

`task_role_assignments.role` and `tasks.assignee_role` lose their CHECK constraints, and `organizer` and `treasurer` survive only as sample values inside a Preset.
