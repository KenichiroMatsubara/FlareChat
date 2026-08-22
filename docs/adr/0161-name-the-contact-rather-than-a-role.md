# Name the Contact rather than a role

A Task is given to a Contact. The extraction is shown the Account's active Contacts — each one's identifier, name, and the description the Account wrote for it — and names one of them, or says that none fits. Operational Task Role, Task Assignment as a role holder, and the Task Reassignment Review are deleted.

The role existed to route work without naming a person, and it bought that at the price of an indirection nobody outside the product wanted. An Account had to invent 会計担当, describe it well enough for a model to match against, appoint a Contact to hold it, and then keep the two in step; every rename or removal of a role opened a review of every incomplete Task, with an AI proposal per Task and an accept-or-reject decision per proposal. That is a large amount of machinery, and a large amount of an Account's attention, for a mapping that was one-to-one in practice.

A Contact carries the description now, and the description is what the extraction reads. 「会計を見ている人」 written on 山田花子 does the work 会計担当 did, in the place a person naturally looks for it, and it stops the product asserting that a Contact has a position. That matters beyond tidiness: a Contact may be a group or a room (ADR 0139), and a room does not hold an office. What it can have is a description of what it is.

Deleting the role set deletes the review with it. There is no role set to change, so there is nothing to re-derive: a Contact renamed is still the same Contact, a Contact removed leaves its Tasks holding the name they were created with, and an Account that disagrees with the model's pick changes the assignee on the Task itself. A Rule no longer selects a subset of roles it may assign either — it was a permission over a vocabulary that no longer exists — so `rules.task_role_ids` goes too.

The name is copied onto the Task at creation and the Contact is referenced beside it. The copy is what a Task says a year later; the reference is what a reminder uses. This is the same split the Recipient Snapshot already makes for a Scheduled Event, and for the same reason: history has to keep saying what was true when it happened.

## Consequences

The migration moves each role's display name into its holder's description before dropping the tables, so 会計担当 survives as text on the Contact who held it rather than being lost. Tasks keep their assignee Contact and name; the role columns go. Any Task whose assignee cannot be resolved reads as 未割り当て, which is what an unassigned Task already read as.

An extraction now sees the Contact roster. It is a larger list than a role set and it changes more often, and the enum it produces grows with the Account. A roster in the hundreds would make this prompt worth reconsidering; for the intended Account size it is a handful of lines.

The GUI loses the Operational Task Role screen and the reassignment review. The Tasks table gains an assignee picker over Contacts, which is the only reassignment that remains, and needs no review because it changes exactly one Task.
