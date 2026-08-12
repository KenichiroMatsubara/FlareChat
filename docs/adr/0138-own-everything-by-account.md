# Own everything by Account

An Account is a login and an ownership scope at once, and owns one database holding its connections, rules, contacts, jobs, and history. The Organization and the Admin role are both retired: Organization implied a company with staff where the real unit is one person's own workspace, and Admin was a role in a set of one, so neither term earned the indirection it cost. Control D1 keeps only Accounts, their database routing, and deployment capacity.

Two Accounts never share a scope, and the same real person known to two Accounts is two Contacts with no link between them. This duplication is the separation working rather than a defect to repair later: ADR 0046 withholds recipient identifiers precisely so that one scope cannot learn who another scope addresses, and a cross-scope identity would defeat it.

## Consequences

ADR 0116's single authorization role and ADR 0117's Admin naming are both dissolved rather than revised, and Control D1's memberships disappear. Because ADR 0100 gates releases on a verified migration of every recorded database, this reshaping ships as its own release before any behaviour depends on it.
