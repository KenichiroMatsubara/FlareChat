# Assign Operational Task Roles to Members

A Task Assignment names a Member through a real foreign key within one Organization D1, replacing the Control D1 identity projection of ADR 0098, which this supersedes. That projection existed to avoid an unenforceable cross-database foreign key, but the people who hold roles such as 幹事 and 会計 never sign into the management GUI: they are roster entries with LINE Destinations and addresses, living in the same database as the assignment, so the constraint the projection worked around does not apply to them. Assigning from Control D1 instead offered only the Organization's shared account, which is not a person and can never be the holder of a role.

## Consequences

Extraction is unaffected, because ADR 0102 already has the model choose an Operational Task Role rather than a person. Existing assignments name the shared Organization account and are reset to unassigned during the ADR 0115 rename migration, which ADR 0103 already treats as a normal state rather than an error.
