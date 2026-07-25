---
status: superseded by ADR-0041
---

# Merge matching automation rules

When several Automation Rules select the same Source Message, Mail Automation would create or update one Scheduled Event. This was superseded when one Source Message was allowed to contain several distinct Event Candidates, while retaining merged and deduplicated rule destinations.
