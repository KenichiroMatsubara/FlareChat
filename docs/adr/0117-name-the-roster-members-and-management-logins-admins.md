---
status: superseded by ADR-0138
---

# Name the roster Members and management logins Admins

The people an Organization schedules, notifies, and assigns work to are Members, stored in Organization D1; the accounts that sign into the management GUI are Admins, stored in Control D1. Previously the GUI called the roster "メンバー" while the schema reserved `members` for management logins, so the Task assignee list offered the Organization's shared Google account in the place where a person's name belonged, and no name in the product meant one thing.

Recipient survives as the role a Member plays for one Scheduled Event — Eligible Recipient, Recipient Snapshot, Calendar Recipient List — rather than as a kind of person. The term Recipient Profile is retired.

## Consequences

`recipient_profiles` becomes `members` and Control D1's `members` becomes `admins`. Because ADR 0100 gates releases on a verified migration of every recorded Organization D1, the rename ships as its own release before any behaviour depends on it.
