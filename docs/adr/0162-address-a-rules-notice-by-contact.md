# Address a Rule's notice by Contact

A Schema Rule names the Contacts its Source Message Notice reaches, as a Contact List it holds on `rules.notice_contact_list_id`. Delivery resolves each Contact's handle on the Channel that Contact is reachable on. The LINE Destination List stays wired for the Accounts already using it, and is the path ADR 0147 deletes.

The old path could not be walked from the GUI at all. A notice went to `list_items` rows holding raw LINE destination IDs, and nothing in the administration GUI creates a Typed List or adds an item to one; worse, every API that returns a destination masks it after five characters (ADR 0088), so an operator could not even read the ID they were being asked to type. Configuring the product's headline behaviour therefore meant a SQL console for the ID and a `fetch` in the browser devtools for the list. That is not a configuration surface, it is a workaround.

Addressing by Contact removes the ID from the question entirely. The operator picks 要約送信グループ from the same roster they registered it on, and the handle — the one they could not read — is resolved server-side at delivery. It also makes the roster the single place a destination is maintained: a Contact that gains a Channel is reachable on it everywhere, which is exactly what ADR 0147 decided and what naming handles could never give.

A Contact is reached once, on the first Channel it holds a handle for in the order the product carries them. A notice is one piece of news, so sending it to somebody twice because they hold both a LINE and a Discord handle would be a defect rather than thoroughness. A Contact with no handle at all is skipped: there is nowhere to deliver, and writing a Delivery Record against an invented destination would record a failure that never left the Worker.

The set is stored as an ordinary Contact List rather than a join table on the Rule, so the product keeps one named-set-of-Contacts concept across Automations, Access Tokens, and now Rules. The GUI creates and updates that list on the Rule's behalf and names it after the Rule, so an operator who later opens it from another screen can tell what it is for.

## Consequences

Both paths deliver while the migration runs. A Rule holding a LINE Destination List and a Contact List sends to both, which is the behaviour an Account gets while it moves across, and the duplicate stops the moment the old list is unchecked. Nothing removes the old lists automatically.

A refusal from one Contact does not stop the rest: the send is per Contact, each failure is already recorded as a failed Delivery Record, and the remaining roster still hears about the Source Message. That matches how the destination-list broadcast already behaved.

The picker offers only Contacts a message can actually reach, taken from the same query the Channel Test uses. A roster with no Channel-linked Contact therefore shows an empty picker rather than a list of names that would silently deliver nothing.
