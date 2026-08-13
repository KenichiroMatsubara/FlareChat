# Extend the contact roster but never merge it

An agent may create a Contact and fill a field that is empty or that it wrote itself; a field a human has touched is immutable to it. This extends to Contacts the principle ADR 0034 and ADR 0056 already apply to Calendar and Drive, that automation does not overwrite a person's edit.

Merging two Contacts is withheld entirely. Deciding that a LINE handle and a Discord handle are the same person is an inference whose failure is not a data defect but a disclosure — one Contact's content delivered to another — and it defeats ADR 0046 from inside the roster. ADR 0025 already refuses this inference for LINE, linking a handle to a person by one-time code rather than by resemblance, and that stance is kept. An agent may surface merge candidates for a human to decide, because the danger is in performing the merge, not in noticing it.

Creation stays unattended rather than proposed, because a Contact must appear the moment an unknown handle sends its first message, as ADR 0009 already does for LINE, and holding that behind approval would stall inbound processing.

## Consequences

Duplicates accumulate and only humans remove them. One person reachable on two channels remains two Contacts until someone says otherwise, and may be notified twice in the meantime.
