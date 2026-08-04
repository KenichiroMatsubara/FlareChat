# Tolerate incidental differences in a Mailbox Test subject

The Mailbox Test's subject search now compares an Admin's typed subject against a candidate Gmail message after folding both through Unicode `NFKC` normalization, trimming, and collapsing any run of whitespace to one space, instead of comparing the raw strings. An Admin finds the subject by reading or copying it from Gmail, a phone notification, or a forwarded message, and those sources routinely differ from the header's exact bytes in ways nobody would call a different subject: a full-width digit where the header has a half-width one, a doubled space, a trailing space a mail client trimmed on display but Gmail's copy did not. Under the previous byte-exact comparison, every one of these silently produced zero matches with no way for the Admin to tell an incidental difference from a genuine mismatch — the search simply came back empty.

The comparison still rejects a subject that only shares words or a common prefix with the one typed, because that distinction is the reason a local exact check exists on top of Gmail's own tokenized `subject:` search: Gmail's query is intentionally loose enough to surface near matches for the results list, and the local check is what stops the Mailbox Test from running against the wrong message on that looseness alone. Normalizing width and whitespace narrows what counts as an incidental difference; it does not widen the search to fuzzy or partial matches.

## Consequences

An Admin who pastes a subject with different-width characters or extra whitespace than the actual header now finds the message; before this change, the search told them nothing beyond an empty result.

A subject that differs only in letter casing still counts as a genuine mismatch, because `NFKC` folds Unicode-compatibility variants such as full-width digits and letters but not case, and this decision does not add a separate case-insensitive step.
