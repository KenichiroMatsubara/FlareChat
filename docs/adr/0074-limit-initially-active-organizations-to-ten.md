---
status: superseded by ADR-0099
---

# Limit initially active Organizations to ten

One deployment initially permits at most ten Organizations to have automation active concurrently. An additional Organization may be created and configured, but activation is rejected with an explicit capacity status until another Organization suspends automation or the deployment limit is raised.

This provisional policy was never enforced by the activation path and is superseded by ADR-0099. Organization registration provisions its own D1 database without a fixed deployment-wide Organization-count limit.
