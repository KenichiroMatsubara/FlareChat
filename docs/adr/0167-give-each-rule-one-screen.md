# Give each Rule one screen

The administration GUI is organized by the thing an operator configures, and a Rule is one thing. A Schema Rule is set up entirely on one screen, an Agent Rule is set up entirely on another, and no screen mixes the two. Everything a Rule owns — what it matches, how it runs, who it tells, what it produced, and whether it is working — is on that Rule's screen. Nothing a Rule owns lives anywhere else.

This reverses how the screens grew. Every decision from ADR 0134 onward named the place its own setting would be edited, and no decision ever named the whole. There is no ADR describing the GUI's structure, and the result is what a structure looks like when nobody owns it: a single Schema Rule is configured across six screens, while one screen carries four unrelated subjects.

## What the split costs today

A Schema Rule's name, sender, domain, keyword, label, and priority can be entered only on the creation form. The row that represents it afterwards cannot edit any of them, and `PATCH /rules/:ruleId` does not accept them, so changing what a Rule matches means creating a new Rule. Its state, execution mode, and readers are the opposite: reachable only after creation, and only inside a collapsed `<details>` whose summary says `Execution Mode・許可リストを編集`. The Contacts that selection draws from are maintained on the Contacts screen. The AI Connection without which the Rule cannot process a single message is on Connections, as are the attachment folder and the response-matching window. The reminder cadence for the Tasks the Rule raises is on Reminders. Its pending approvals are on Rule Runs, and the way to try it is Mailbox Test.

An operator cannot answer "is this Rule set up correctly" from any one screen, and this is not hypothetical. The production Account ran for three weeks with `rules.notice_contact_list_id` unset, which makes `deliverSourceMessageNotice` return before it sends anything. Mail was read, events were written, tasks were raised, and not one summary was ever delivered. No screen said so, because no screen is responsible for saying so.

Meanwhile the Rules screen stacks a Schema Rule creation form, the Schema Rule list, a Prompt creation form, the Prompt list, an Agent Rule creation form, the Agent Rule list, and the Agent Run transcripts. Two rule types that ADR 0137 keeps deliberately distinct are presented as one undifferentiated column.

The same absence of an owner left capabilities with no screen at all. Exceptions, automation warnings, Account suspension, Contact CSV import and export, and Typed List creation are all served by the Worker and reachable from nothing in the GUI — while the Rules screen offers checkboxes for Typed Lists that no screen can create. The delivery audit is fetched by the route loader on every visit and rendered by no component. Access Tokens and MCP Servers are configured inside the Chat screen because that is where they were first needed.

## The screens

Nine screens, each named for what it is responsible for.

`/rules` lists both rule types and creates either. It is an index and nothing else — no editing, no prompts, no transcripts.

`/rules/schema/:ruleId` is one Schema Rule, whole. Selection policy and priority, editable for the life of the Rule; state and execution mode; the Contacts it tells, stated in the open rather than behind a disclosure; the reminder cadence for the Tasks it raises; its recent Rule Runs and deliveries; and the way to try it against a real message. If a setting decides what this Rule does, it is here.

`/rules/agent/:ruleId` is one Agent Rule, whole: its Prompt, its selection policy, its execution mode, the destinations it is permitted to reach, and its run transcripts.

`/prompts` maintains Prompts as the shared asset they are, referenced by Agent Rules and Automations alike.

`/contacts` holds the roster, Channel handles, Contact Lists, Typed Lists, portal invitations, and CSV import and export — everything about who the product can reach. Sending a test message is here too, on the Contact it is sent to: the Channel Test picks a Contact and reaches it on the Channel that Contact holds, so the question it answers is whether this person is reachable, not whether a credential parses.

`/automations` keeps the scheduled Automations it already keeps, with Triggers and tool grants.

`/chat` is conversation only. Access Tokens and MCP Servers move to `/connections`, which they belong to.

`/connections` holds what the whole Account shares and no single Rule owns: the Google grant, the AI Connection, LINE and Discord, Access Tokens, MCP Servers, the attachment folder, and the response-matching window. Each credential is checked where it is entered, and calling a registered MCP Server's tool sits beside that server's registration.

`/operations` is the one place to find what went wrong: exceptions, automation warnings, the delivery audit, stuck Jobs, Account suspension, and the Event Refresh.

The Event Refresh stays apart from the Rule screens deliberately. It overwrites Scheduled Events an operator may have edited by hand in Calendar, which is why it was separated from the ordinary Rule Run in the first place, and putting it at the end of a Rule's test flow would make a destructive manual override read as the next step of trying something out. It keeps its own heading and its own screen. What it does not keep is its dependence on another screen: today it can only work on an extraction the Mailbox Test screen left in memory, and an operator who opens it directly is told to go and do something elsewhere first. On `/operations` it finds its own message by subject and runs its own extraction, so it is openable on its own terms like everything else there.

Mailbox Test, Channel Test, and Rule Runs stop being destinations, because each of them is a question about something that now has an owner. Trying a Rule against real mail belongs on that Rule's screen. Approving a planned run belongs on the Rule that planned it. The Channel Test splits in two along the two questions it currently answers at once: whether a Contact is reachable, which is a Contact's screen, and whether a credential works, which is the credential's card.

Consolidating the mail test removes a duplicate rather than moving one. The same flow — find a message by subject, build the request, send it to the AI, read back the summary, events, and tasks — is implemented twice: once on Mailbox Test against the active Primary Rule, and again on Rule Runs against a Draft Rule chosen from a dropdown. ADR 0136 keeps the mailbox test and the draft rule preview as separate operations, and they stay separate operations; what disappears is the second copy of the screen around them, because on a Rule's own screen the Rule under test is the Rule the screen is about, and whether it is Draft or Active is already stated there.

## Every screen states what it is missing

A Rule with no readers says so on its own screen, in the place the readers are chosen, and says what the consequence is: no summary will be delivered. So does an Account with no AI Connection, a Rule whose Contacts hold neither an address nor a handle, and a Channel whose credential was refused. A setting that can be left empty and silently do nothing is a defect wherever it appears, and the screen that owns the setting is the screen that reports it.

## Order

The screens are cut over one at a time, each landing on its own. The Schema Rule screen comes first, because that is where the failure that prompted this was invisible, and its first release carries the missing-readers warning. `/operations` comes second, since exceptions, warnings, and the delivery audit already exist behind routes and only need somewhere to appear; the Event Refresh moves in the same step and gains the mail search that frees it from the Mailbox Test screen's state. The Agent Rule screen and `/prompts` follow together, because splitting them apart is what makes the current Rules screen unreadable. `/contacts` gains Typed Lists and CSV next, closing the gap where the GUI offers a choice it cannot create the options for. `/connections` absorbs Access Tokens and MCP Servers last, as it is the only step that takes something away from a screen an operator already uses.

## Consequences

Every URL under `/organizations/:accountId` except `/rules`, `/connections`, `/chat`, `/automations`, and `/tasks` changes or disappears. Bookmarks break. This is accepted: the GUI has one Account in production and its operator is the person this decision is for.

The navigation drops from twelve destinations to nine and loses the 運用 / 設定 / 検証 grouping, which sorted screens by how often they were used rather than by what they were about, and which put a Schema Rule's execution mode, its reminder cadence, and its run history in three different groups.

Reminder cadence stays an Account-wide setting stored on `settings` and is shown on each Schema Rule screen as the Account-wide setting it is. ADR 0163 and ADR 0164 disagree with each other about where it is edited — one says the Tasks page, the other says the Reminders page — and both are superseded on that point alone. Making the cadence per-Rule is a domain change and is deliberately not decided here.

Editing a Rule for its whole life means the update endpoint accepts its name, Selection Policy, and priority, which it did not. A Revision is minted when the Execution Mode or a policy actually changes, and not otherwise: a screen that posts its whole form would otherwise mint one per save and leave the Rule Runs of ADR 0134 pointing at Revisions nothing distinguishes. A rename mints none, and neither does a change of priority — a Revision records what a Rule does to a message it is given, while priority arbitrates between Rules and cannot be reconstructed from any one of them.

The retired paths — `members`, `mailbox-test`, `channel-test`, `rule-runs`, `event-refresh`, `reminders` — redirect rather than 404, so a link somebody already has still lands on the screen that took the work over.

Nothing about how a Rule runs changes. This decision moves screens.
