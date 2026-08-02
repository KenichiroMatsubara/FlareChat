# Bind agent destinations to rule-permitted candidates

An Agent Rule's write tools accept a destination argument, but only from the candidate set its rule permits, so the model chooses whom to reach among destinations an Admin can read off the rule's own settings. Letting the model address any destination in the Organization would make a rule's blast radius invisible in its configuration, while removing the argument entirely would forbid the selective delivery that motivates Agent Rules at all.

## Consequences

An Automation Rule's single `recipient_list_id` and `line_list_id` references become sets of permitted lists.
