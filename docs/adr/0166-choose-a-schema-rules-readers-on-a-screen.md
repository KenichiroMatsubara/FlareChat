# Choose a Schema Rule's readers on a screen

A Schema Rule has exactly one destination setting: the Contacts an operator ticks in the administration GUI. Delivery reaches each of them once — by email when the Contact holds an address, on its Channel handle when it does not. Nothing infers a recipient, and no model is asked who a summary is for. ADR 0162 chose Contacts over typed handles; this makes that choice the only one a Schema Rule has.

The alternative was to hand the Contact roster — each name and the description the Account wrote for it — to the extraction and let it decide who a summary reaches. It was rejected. Who reads a Rule's notices changes about as often as the roster does, which is to say rarely, and it is a decision an operator can make correctly in one pass on a screen. Asking a model to re-derive it from a name and a description on every Source Message spends tokens and latency to reproduce a fact already written down, and it makes the answer vary between two messages that should be addressed identically. A setting that an operator can read, predict, and change is worth more here than one that is inferred well most of the time.

Deriving the readers from what the message produced was rejected for the same reason and one more. It sounds principled — send a Task to its assignee, an event to its recipients — but it silently drops every message that raises neither, and it makes the destination a consequence of extraction quality rather than a configuration. An Account cannot look at that and say who will be told; it can only run it and find out.

Three destination settings became one. A Schema Rule previously fanned out to a Calendar Recipient List of raw addresses, a LINE Destination List of raw handles, and a Contact List, each configured separately and each able to reach the same person. Nothing was gained by the arithmetic and an operator could not tell from the GUI who would actually be written to. The Contact selection is now the whole answer, and the picker offers every active Contact the product can reach rather than only those holding a LINE handle.

Email is the default way to reach a chosen Contact because that is what an Account picking people expects. A Contact with no address is a group or a room (ADR 0139), which is reached on its Channel handle instead — that is where such a Contact lives, and it is the reader ADR 0159 composed the one notice for.

## Consequences

An Account whose Rule reached readers through a Calendar Recipient List or a LINE Destination List must tick those people as Contacts before the notice resumes. Nothing migrates the lists automatically: a raw address is not a Contact, and inventing one to match would put a name in the roster that the Account never wrote. The lists themselves are untouched — ADR 0147 is what deletes them.

The notice is unchanged in what it says. Every chosen reader gets the same text, composed as ADR 0159 composes it, including the Scheduled Events and Tasks the message produced. A reader who is not the subject of any of it still receives it, which is the cost of a destination an operator sets rather than one the product guesses.

An Agent Rule is unaffected and keeps choosing its own recipients from its permitted set (ADR 0165). The two rule types now differ on this deliberately: a Schema Rule is the predictable path, and predictable includes knowing who it writes to.
