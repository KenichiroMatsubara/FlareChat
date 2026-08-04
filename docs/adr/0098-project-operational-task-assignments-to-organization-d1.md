---
status: superseded by ADR-0116
---

# Project operational Task Assignments to Organization D1

Operational Task Roles remain distinct from Owner, Admin, Operator, and Viewer authorization roles. Each Organization D1 stores the current Task Assignment as a projection of an active Control-D1 member keyed by stable identity ID, while a newly created Task snapshots that identity and display name. This avoids an unenforceable cross-database foreign key, keeps retry-safe Source Message processing local to the Organization database, and leaves historical Tasks intelligible after a role is reassigned.
