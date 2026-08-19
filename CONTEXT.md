# FlareChat

FlareChat is an automation platform for schedules and contacts. An Automation runs on a Trigger, thinks with a Prompt, acts through the tools its Account granted it, and reaches people on the Channels they already use. The Gmail-to-Calendar-and-LINE behaviour FlareChat began as is now one configuration of that platform rather than the platform itself.

FlareChat is not domain-neutral. It knows two domain nouns, Contact and Scheduled Event, and generalises everything else. Anything it does not know is reached through an MCP Server the Account connects, so posting to Notion, calling an internal API, or reading a third-party system needs no release; adding a Channel does, because only the product can mount an inbound endpoint and own a handle namespace.

An Account is a login and an ownership scope at once. It owns one database holding its connections, Automations, Contacts, Jobs, and history, and there is no role inside it: whoever signs in owns everything. Two Accounts share nothing, and one person known to two Accounts is two unrelated Contacts.

A Contact is an addressable entity and nothing more — a name, tags, and one or more Channel Handles. It may be a person, a group, a room, or a channel, and it never signs in. The pages a Contact reaches are entered through a revocable, single-use, time-limited link.

One engine serves three entrances. Operator Chat runs it interactively with the Account's whole tool set, one exchange to one Rule Run; a Trigger runs it unattended with only the tools that Automation was granted; and an outside agent reaches it over MCP with an Access Token, holding one Tool Grant and bounded to one Contact List. A conversation that works becomes an Automation by naming its Prompt and tool set and attaching a Trigger, so nothing is designed twice.

Two rule types coexist during a migration that ends by deleting one. A Schema Rule extracts Event Details, Tasks, and a Message Summary against one product-defined schema, so the external effects it can cause are known before it runs. An Agent Rule runs an Account-authored Prompt with a granted tool set and decides for itself whether and how to act. Agent Rules are strengthened until Schema Rules are redundant rather than rewritten into their equivalents, so both types are correct until the day the first is removed.

Safety comes from the granted tool set, not from predicting what a model will do. An external tool is called for real and returns its actual result, including its failures, because a model reasoning from a synthesised success is not a safer model. The Execution Mode decides which tools are bound at all: read-only binds no external tool whatsoever, while approval and unattended both bind and run them. An unattended Automation holding an external write tool therefore has no human gate before its external effects, bounded only by its tool set, its run ceilings, and its Suppression Window.

A run that observes an unchanged world would otherwise reach the same conclusion every morning and notify the same people again. FlareChat derives a repeat-suppression key itself, from the Automation, the tool, the normalised arguments, and a window declared per Automation, and suppresses the repeat. The model is neither asked for the key nor trusted to check its own history.

An agent may create a Contact and fill a field that is empty or that it wrote itself; a field a human touched is immutable to it, and merging two Contacts is withheld entirely. It may name merge candidates for a human to settle. Duplicates therefore accumulate and only humans remove them.

The deployment uses the Workers Paid plan and is designed to remain near its $5 monthly minimum under the intended small-Account workload. Cloudflare usage above included allowances may incur additional charges, so this is a cost target rather than a hard spending guarantee. Google, LINE, Discord, and AI provider quotas, plans, and charges remain separate Account-managed constraints.

The deployment uses one Control D1 database plus one Account D1 database per Account. Control D1 contains only identities, Account routing, and deployment capacity state; each Account D1 contains that Account's rules, events, Contacts, Jobs, credentials, and history. Application-owned Durable Objects are not used.

Account registration derives a human-readable D1 name from the confirmed Automation Inbox address using `flarechat-organization-{normalized-address}-{address-hash}`. Provisioning resolves that exact Cloudflare database before creating one, applies only unapplied schema migrations, attaches the deterministic binding, verifies access, and only then activates the Account. A stored Cloudflare database UUID is a routing cache rather than the sole means of rediscovering the database; provisioning never selects an arbitrary available production database.

Production Worker releases are gated on Control D1 migration and a verified migration of every recorded Account D1, including suspended Accounts and databases allocated by in-progress provisioning. A release barrier pauses only new Account provisioning while the fleet is prepared and verified. All runtime Account D1 access also passes through a schema-ready seam that repairs safe missing migrations before returning the database, so login, scheduled work, webhooks, and background automation share the same guarantee.

Application entry has two explicit Google intents. An existing Account signs in with identity-only login using `openid`, `email`, and `profile`; it resolves the Identity by Google `sub`, creates only an application session, and never creates or resumes Account setup. Account creation uses one separate complete authorization. The authorized account becomes both the Automation Inbox and the Account's own identity, and its display name is the editable Account-name default. D1 provisioning starts only after Google returns the complete required grant: identity, `gmail.readonly`, `gmail.send`, `calendar.events.owned`, and `drive.file`. Partial consent creates no Account or D1 database; no separate application login allowlist is required for the private pilot.

If Account creation identifies an Identity that already owns an active Account, FlareChat discards the broader Google credential and completes ordinary application login instead. It creates no Account setup, Account, or D1 database.

The browser carries only the application session cookie. A bootstrap interface derives one discriminated application state from durable Control D1 records: signed out, unassigned, confirming Account, provisioning, provisioning failed, or ready. Short-lived OAuth attempts, name-confirmation setup, and retryable provisioning are separate records. Automation Inbox ownership is claimed by the stable Google `sub`, with the email address retained as current display and delivery data rather than as identity.

The Automation Inbox remains an Account-owned Google Connection rather than a person, even when its Google identity is also the identity the Account signs in with. Setup requires neither a second email address nor passkey registration.

A Contact registers attendance, writes comments, and completes the Tasks assigned to it through a Contact Page, which it enters by a short-lived single-use link exchanged for a time-bounded session, delivered only to a Channel Handle that addresses that Contact alone. A Contact may read every Task in the Account but may complete only its own. It holds no credential of any kind, so anyone holding an unexpired link acts as that Contact, and revocation, single use, and expiry are the whole mitigation. A Contact reachable only through a shared group or room has no page and is administered entirely by the Account, because a link sent into a group lets every member of it act as that Contact.

An unfinished Task notifies its assignee alone at the same seven, three, and one day milestones the attendance reminders use.

Adding, renaming, redescribing, or removing an Operational Task Role opens a Task Reassignment Review, because Tasks already extracted were routed by a role set that no longer exists. The review offers one AI proposal per incomplete Task, naming a role and the evidence that chose it; completed Tasks are history and are never revisited. Nothing moves until the Account accepts a proposal, and accepting one takes the assignee from the role's current holder. Accepting none still closes the review, so a deliberate decision to leave the Tasks alone is not asked for again.

An Account setup session expires fifteen minutes after the Automation Inbox grant while the installer confirms the editable Account name. If confirmation is not completed in time, FlareChat revokes and deletes the Google credential and creates no Account D1 database.

After Google authorization and name confirmation succeed, a failed D1 provisioning operation may retain the encrypted Google credential and initial Account record for at most twenty-four hours while explicit and automatic idempotent retries remain available. The failed phase and concrete error remain visible. Expiry revokes the grant, deletes the pending credential, and requires a new setup.

When an estimated included Cloudflare allowance or configured cost threshold approaches exhaustion, interactive attendance, administration, and authentication traffic takes precedence. New inbox processing, AI extraction, and ordinary LINE delivery are retained as pending work and resume oldest-first after capacity recovers.

Background capacity is fairly apportioned among active Accounts. An Account may borrow unused capacity, but exhausting its own current allocation pauses only its background work and must not consume another Account's protected share.

R2 usage warnings are emailed to the deployment operator at `kenmatsu331@gmail.com` when estimated monthly storage reaches 80% and 95% of the free allowance. R2 ingestion is not automatically stopped and Source Snapshots are not automatically deleted, so ignored warnings may result in billable overage.

Deployment-level capacity warnings use a Cloudflare Email Service binding restricted to the verified destination `kenmatsu331@gmail.com`; they never use an Account's Automation Inbox.

Estimated Workers, D1, Queues, R2, and other Cloudflare usage produces deployment warnings at 80% and 95% of each included monthly allowance. Cloudflare overage remains possible; failed or rate-limited work stays pending and never counts as successful delivery.

Estimated aggregate Cloudflare charges produce an additional deployment email warning at projected monthly totals of USD 6 and USD 10. Each threshold fires once per billing period, does not automatically stop processing, and resets for the next period.

A durable Job row in the owning Account D1 database is the source of truth for every asynchronous unit of work. A Queue message is only a replaceable wake-up hint containing an Account and Job identifier; scheduled recovery scans rediscover due Jobs if a hint expires or is lost.

The initial private deployment uses one Google OAuth application configured as `External / In production` without completed verification. It accepts Google's unverified-app warning and lifetime user cap to avoid Testing-mode refresh-token expiry. Account creation requires the complete Automation Inbox grant before provisioning; broader public onboarding requires verification and any applicable security assessment.

Automation runs unattended for as long as its grant holds, without anyone signing into the administration GUI. Only `invalid_grant` from Google suspends an Automation Inbox for reauthentication; every other failed run is recorded and retried on the next schedule. A rejected grant is mailed to the Account through the Automation Inbox immediately, and any other continuing failure is mailed after a full day of failed retries and repeated at most weekly until it clears.

Account connection credentials are encrypted with an Account-specific data-encryption key. That key is wrapped by a versioned deployment master key held as a Worker Secret, allowing stored credentials to be rewrapped during key rotation without exposing plaintext in D1.

Every Scheduled Event insertion is an upsert. An Event Candidate is correlated against the Automation Inbox's calendar as it currently stands rather than against what FlareChat last recorded, and a correlated candidate merges into that event field by field instead of creating a second one. A field whose current Calendar value differs from the value FlareChat last wrote is a Manual Override and is left out of the merge while the remaining fields still update. A correspondence whose two start times stand more than seven days apart is never merged, so a distant match becomes a new Scheduled Event rather than moving an existing invitation list onto a different meeting. No Account approval stands between a merge and the calendar.

One extraction states the kind of the Source Message it read. An Event Response's extracted event fields locate the Scheduled Event it answers, within an Account-configured number of days either side of that event's start, and are never written to it; an Event Response that locates nothing creates nothing. Its Message Summary, Tasks, and attachments are handled as they are for any other Source Message.

An Event Response may return a completed registration naming people from outside the Account. Each becomes one Guest Registration on the Scheduled Event that response answers, keyed by the Event Response that declared it so that reprocessing and correction replace those rows rather than accumulate beside them. Guest Registrations are retained with the delivery history and archived with it after twelve months.

Every Calendar write FlareChat makes, including a merge that moves a Scheduled Event's date, time, or location, is sent with `sendUpdates=none`: Google never mails an invited Contact on the automation's behalf. A Contact finds a new or moved meeting by opening Google Calendar, where the write already appears, or through a separate LINE message an Automation Rule sends explicitly.

A Scheduled Event's Calendar description states its Event Summary first, then the Guest Registration counts by Affiliation and never the guests' names, then each Public Attachment as a link labelled with its filename, then the sentence naming the Source Message it came from. Google Calendar renders a small HTML subset, so untrusted extracted text, Affiliations, and filenames are escaped and only absolute http(s) links are written.

A Scheduled Event created from a Source Message adds every active Contact that carries an address as a Google Calendar attendee of the Automation Inbox's event without asking Google to send an invitation notification. The invited Contacts are frozen as the event's Recipient Snapshot when it is created, and one Delivery Record per Contact records the invitation, so a later roster change never rewrites who an already delivered event reached.

If Google Drive policy prevents an attachment from becoming a Public Attachment, the event is retained only on the Automation Inbox's Calendar as an administrative draft. Recipient invitations are withheld until publication succeeds, and an Automation Exception supports retry after policy correction.

Completed Delivery Records and audit history older than twelve months are moved from Account D1 into encrypted, compressed monthly R2 archives. Account D1 retains archive indexes for GUI retrieval; active rules, recipients, credentials, pending Jobs, attendance for active events, and future events are never archived by this process.

The initial deployment creates no separate daily D1 backup. It relies on Workers Paid D1 Time Travel for thirty-day database recovery and on encrypted R2 archives for cold Delivery Record and audit history.

Every successful external effect also creates an encrypted immutable Recovery Receipt in private R2 for thirty-five days. After an Account D1 Time Travel restore, automation remains suspended until receipts newer than the restore point have rebuilt the missing idempotency and Delivery Records.

An Account may request a Time Travel restore, but only the deployment operator may execute it. The deployment operator runs the service itself and is not an Account role. Restore suspends the Account, exports its current D1 state, performs recovery, and reconciles Recovery Receipts before resumption. A dedicated restore-request GUI is deferred beyond the initial delivery; the same policy may initially be followed through an operator runbook.

Attachment intake initially permits at most 20 MiB per attachment and 40 MiB across one Source Message. An Account may configure smaller limits. Exceeding either limit withholds the message from automatic event delivery and creates an Automation Exception.

## Language

**Account**:
A login and an ownership scope at once, owning its Connections, Contacts, Automations, Scheduled Events, Jobs, and audit history. It has no roles inside it and shares nothing with another Account.
_Avoid_: tenant, team, workspace, organization, admin, owner, user

**Source Message**:
A Gmail message selected for automation, including its body and attachments.
_Avoid_: email, mail

**Calendar Transport Message**:
A Gmail message identified from iCalendar MIME metadata or Google Calendar transport identity as carrying Calendar invitation or response transport rather than new Account content. It is not a Source Message or Event Response; FlareChat does not send it to BYOK AI and leaves its Gmail labels, inbox state, and read state unchanged.
_Avoid_: Event Response, calendar reply, reaction mail

**Source Snapshot**:
An encrypted, time-limited copy of a Source Message's raw content and original attachments retained for investigation and extraction reproducibility.
_Avoid_: email archive, backup

**Quarantined Attachment**:
A Source Message attachment withheld from AI, Drive, Calendar, and recipients until encryption, type, and size checks establish that it is acceptable to process. FlareChat relies on Gmail's inbound malware scanning rather than running an independent scanner.
_Avoid_: temporary file, blocked file

**Public Attachment**:
A safe attachment stored once in Drive and readable without Google login by anyone who possesses its unindexed link.
_Avoid_: shared file, public document

**Attachment Folder Path**:
The Drive location an Account writes for itself, beneath which FlareChat creates one folder per Source Message and stores that message's Public Attachments.
_Avoid_: save location, drive path, output folder

**Attachment Association**:
A relevance link between one safe source attachment and one Event Candidate; either side may participate in multiple associations.
_Avoid_: attachment assignment, event file

**Google Connection**:
An authorized Google account owned by one Account with an explicit set of Gmail, Calendar, or Drive capabilities.
_Avoid_: Google user, member account

**Automation Inbox**:
A single Google Connection authorized by an Account to read Source Messages, send operational and recipient email, own Scheduled Events, and store their attachments. It never grants mailbox access to a Contact.
_Avoid_: shared Gmail, monitored account

**Channel Handle**:
One address at which a Contact is reachable on one Channel through one Connection — an email address, or a LINE or Discord user, group, room, or channel — discovered from a verified inbound message or entered by the Account, with its origin recorded. It records whether it addresses its Contact alone or a shared group or room, as the Channel states rather than as anyone infers. A Contact reachable on several Channels holds several.
_Avoid_: member address, LINE destination, recipient, webhook source

**Contact**:
An addressable entity owned by an Account, identified by a name, its Channel Handles, its status, and Account-defined tags. It may be a person, a group, a room, or a channel; it receives deliveries, may hold Operational Task Roles, and never signs in.
_Avoid_: member, recipient profile, user, account, person

**Handle Link**:
A short-lived, single-use association that proves a Channel Handle belongs to one Contact.
_Avoid_: recipient link, invite, account link

**Contact Page**:
The page where a Contact registers attendance, writes comments, and completes its own Tasks, opened by a short-lived single-use link that is exchanged for a time-bounded session. It carries no sign-in, so the link is the whole of its authority, and single use is what survives the link being forwarded.
_Avoid_: member portal, registration link, login page, public form

**LINE Connection**:
An authorized LINE Messaging API channel owned by one Account and used as the sender for notifications.
_Avoid_: LINE account, bot

**AI Connection**:
An Account-owned model provider authorization used to derive Event Details, with one Account default and optional Automation Rule overrides.
_Avoid_: endpoint, model account

**Channel**:
A product-implemented medium on which Contacts are reachable and answer. LINE and Discord are served; Email delivers but is not yet reached from the newer surfaces. A Channel supplies a signature-verified inbound endpoint, a handle namespace, a recordable delivery receipt, and structured reply controls, so only a release adds one. Discord arrives through its Interactions endpoint rather than its Gateway, because a Worker cannot hold a persistent connection, so it hears commands and control presses rather than every message.
_Avoid_: provider, integration, transport, connector

**MCP Server**:
A remote HTTP or SSE server an Account connects to lend its tools to Automations and Operator Chat. Cloudflare Workers have no child processes, so stdio servers cannot be used. A server's own read-only and destructive hints are shown but never relied upon, because it declares them about itself.
_Avoid_: plugin, extension, integration, tool provider

**Tool Grant**:
The explicit set of tools one Automation or Access Token may call, default deny, naming each tool rather than a whole MCP Server. It is the boundary that makes an unattended run safe, in place of predicting what the model will do, and it is the only authorization concept in the product.
_Avoid_: permission, scope, capability, allowlist, role

**Access Token**:
The credential an outside agent presents to reach an Account over MCP, carrying one Tool Grant and one Contact List that bounds who it may reach. It needs rate and write limits of its own, because the run ceilings that bound an Automation bound this engine's loop rather than the caller's.
_Avoid_: API key, secret, integration, session

**Automation**:
A named Trigger, Prompt, and Tool Grant that runs unattended. It begins each run knowing nothing of its previous ones and finds its work through its tools, and it names the Contact List it may reach whenever it is granted a way to send.
_Avoid_: rule, job, workflow, task

**Schedule**:
When a Trigger with no payload is next due, stated as a daily, weekly, or hourly time in the Account's own offset. A schedule this product cannot read is refused rather than interpreted, because one read as something else fires at the wrong hour.
_Avoid_: cron, timer, interval, recurrence

**Trigger**:
What starts one run of an Automation. It either carries a payload, as an inbound Channel message or a Source Message does, or carries none, as a schedule does; a run with no payload finds its own work through its Tool Grant.
_Avoid_: cron, event, hook, schedule

**Contact List**:
A named set of Contacts that an Automation delivers to or an Access Token is bounded by. Delivery resolves each Contact's handle from the Channel being sent on, so a Contact who gains a Channel is reachable on it everywhere the list is used. People edit it; an agent never does.
_Avoid_: recipient list, distribution list, group, segment

**Operator Chat**:
The Account's interactive entrance to the same engine an Automation runs on, holding the Account's whole tool set and recording one exchange as one Rule Run. Naming a conversation's Prompt and tool set and attaching a Trigger turns it into an Automation.
_Avoid_: assistant, console, playground, conversation

**Suppression Window**:
How long a repeat of the same tool call with the same normalised arguments from the same Automation is withheld rather than performed. It is declared per Automation and may be overridden per tool, and it exists because a run that observes an unchanged world otherwise reaches the same conclusion every time it wakes.
_Avoid_: deduplication, rate limit, cooldown, throttle

**Automation Rule**:
A named configuration that selects Google and LINE Connections and combines typed lists to decide whether a Source Message creates or updates a Scheduled Event and which destinations receive it.
_Avoid_: filter, condition

**Run Schedule**:
The user-configurable cadence and active time window at which an Automation Rule becomes eligible to process new Source Messages.
_Avoid_: cron, timer

**Rule Match Set**:
All Automation Rules that select the same Source Message; the highest-priority match supplies extraction while all matches contribute routing and scheduled deliveries without duplication.
_Avoid_: matched filters, rule results

**Primary Rule**:
The highest-priority Automation Rule in a Rule Match Set whose AI Connection and Extraction Policy exclusively derive Event Candidates from the Source Message.
_Avoid_: winning rule, extraction rule

**Owning Rule**:
The Primary Rule retained by a Scheduled Event for interpreting its later Event Changes unless the Account explicitly reassigns it.
_Avoid_: event rule, pinned rule

**Schema Rule**:
An Automation Rule that derives Event Details, Tasks, and a Message Summary from a Source Message through one product-defined extraction schema, so that every external effect it can cause is known before it runs.
_Avoid_: standard rule, default rule

**Agent Rule**:
An Automation Rule that runs an Account-authored Prompt against a Source Message with a bounded tool set, deciding for itself whether and how often to act within the destinations its rule permits.
_Avoid_: AI rule, custom rule, MCP rule

**Prompt**:
An Account-owned, separately identified set of instructions referenced by Agent Rules, retained so that any produced Scheduled Event, Task, or delivery names the exact instructions that caused it.
_Avoid_: system message, template

**Preset**:
A self-contained sample configuration—rules, Prompts, Operational Task Roles, and empty typed lists—copied once into an Account and thereafter unlinked from the product release that supplied it.
_Avoid_: template, default configuration

**Rule Revision**:
An immutable version of an Automation Rule's selection, extraction, routing, scheduling, and delivery configuration.
_Avoid_: rule history, configuration version

**Rule State**:
The Draft, Active, Suspended, or Archived lifecycle status that determines whether an Automation Rule may preview, execute, resume, or remain historical. Every rule type uses all four states independently of the Execution Mode that governs Rule Effects.
_Avoid_: enabled flag, rule status

**Execution Mode**:
Whether an Automation Rule processes matched Source Messages read-only through planning without applying Rule Effects, records them for Account approval, or applies them unattended. Every rule type supports all three; unattended execution is a first-class operating mode rather than an exception built on human confirmation.
_Avoid_: permission level, safety setting

**Rule Run**:
The record of one Automation Rule Revision processing one Source Message in one Execution Mode, whose complete set of Rule Effects becomes immutable when planning succeeds. Read-only retains the plan without applying it, approval holds it for one batch decision, and unattended applies it immediately; planning retries may precede the freeze, but afterward applying modes only resume incomplete effects under stable idempotency keys and changed external preconditions require a new run.
_Avoid_: job, attempt, Agent Run

**Rule Effect**:
One planned business-state mutation produced by a Rule Run, whether inside FlareChat or in an external provider. Source Message intake and Rule Run audit records are not Rule Effects.
_Avoid_: external effect, side effect

**Proposed Action**:
One frozen Rule Effect held without applying it until the Rule Run is approved, rejected, or expires. Every Proposed Action from the same run is approved or rejected as one batch; the Account cannot reshape the run by selecting individual effects.
_Avoid_: pending delivery, draft action

**Mailbox Test**:
An Account-started check of one selected Automation Inbox message through the same Active Primary Rule selection, task-role boundary, attachment conversion, and AI provider path as live Automation. Preview does not persist or consume the Source Message and has no business effect; a separate short-lived confirmation may create only the reviewed Calendar events and their Public Attachments. Draft Rule Preview remains a distinct Rule Runs operation.
_Avoid_: Draft Rule Run, production replay

**Channel Test**:
An Account-started send of up to five arbitrary messages to one Contact through the same Channel seam an Automation and the MCP Server send through, or one call of a registered MCP Server's tool with arguments the operator wrote. It consults no Suppression Window, because a test whose repeat silently sends nothing reports a Channel as working when it never spoke, and it leaves an ordinary Delivery Record per message, because a real message really left. Its result names how many messages were sent and how many provider requests carried them, so the Channel's own batching is visible rather than assumed.
_Avoid_: ping, dry run, smoke test

**Run Transcript**:
The complete encrypted Agent Rule reasoning record attached to a Rule Run—its Prompt revision, model, every tool call with arguments and results, and final output—retained to explain a run that will never be retried.
_Avoid_: log, agent history

**Verified Delivery Facts**:
The facts about a Source Message that FlareChat observed rather than read from it—presently only when it arrived—stated to an extraction separately from the message so that a sender cannot author them. They authorize completing a date that omits its year and nothing else.
_Avoid_: context, metadata, current date

**Event Details**:
The structured title, start and end time, time zone, location, description, and Event Summary extracted from a Source Message through an AI Connection and completed with an Automation Rule's defaults.
_Avoid_: parsed fields, event data

**Event Summary**:
The plain-text account of one Event Candidate alone, produced by the same extraction as the Message Summary and written into that event's Google Calendar description. It falls back to the event description when an extraction omits it.
_Avoid_: event notes, per-event digest

**Message Summary**:
The single plain-text account of one Source Message and its accepted attachments produced by that message's one extraction, delivered on its own schedule whether or not the message yielded any Event Candidate.
_Avoid_: description, digest, snippet

**Intake Notice**:
The sender-and-subject-only notification substituted for a Message Summary when a Source Message becomes an Automation Exception before a summary exists.
_Avoid_: error notice, fallback summary

**Event Candidate**:
One distinct proposed event or recurring series extracted from a Source Message before it becomes a Scheduled Event or Automation Exception.
_Avoid_: detected event, draft

**Event Category**:
A nullable Account-defined classification selected for an Event Candidate that may supply default recipients, LINE destinations, registration settings, and notification templates.
_Avoid_: tag, event type

**Extraction Policy**:
Trusted Account-authored instructions and defaults that constrain how a Schema Rule derives Event Details from untrusted Source Message content, within the product-defined extraction schema.
_Avoid_: prompt, system message

**Selection Policy**:
A boolean expression over sender, domain, Gmail label, recipient headers, content keywords, attachment properties, and received time that selects Source Messages for an Automation Rule.
_Avoid_: email filter, Gmail query

**Routing Policy**:
A boolean expression over one Event Candidate's extracted attributes that selects its Calendar Recipient Lists and Channel Handle Lists after message selection.
_Avoid_: recipient rule, distribution filter

**Event Change**:
An AI-classified creation, modification, or cancellation derived from a Source Message and correlated with one Scheduled Event.
_Avoid_: email action, event update

**Event Response**:
A Source Message correlated with an existing Scheduled Event that proposes no new event of its own, such as an acceptance, an acknowledgement, or a registration returned against it. Its extracted event fields locate the Scheduled Event it answers and never create one.
_Avoid_: reply, response mail, follow-up

**Event Response Window**:
How many days either side of a Scheduled Event's start an Event Response may still be recognised as answering it. An Account sets it for itself, because how far ahead a registration is returned is a fact about that Account's correspondence rather than about FlareChat.
_Avoid_: correlation window, tolerance, matching range

**Manual Override**:
A field value changed by the Account in the GUI or directly on the organizer's Google Calendar that automated Event Changes may not overwrite. An Event Refresh is the one exception, because the Account approves that single rewrite after seeing what it replaces.
_Avoid_: edit, correction

**Source Attribution**:
The sentence in a Scheduled Event's Calendar description naming the Source Message it came from, and the correlation between the two.
_Avoid_: footer, provenance note

**Event Refresh**:
An Account-initiated repair that rewrites an existing Scheduled Event's Calendar fields from a fresh extraction of its Source Message, together with an additive invitation of the active Contact roster: a Contact the Calendar already lists keeps whatever they answered, and only a Contact missing from that list is added. It is separate from Mailbox Test and approval-mode execution because it deliberately overwrites Manual Overrides.
_Avoid_: resync, regenerate, backfill

**Calendar Revision**:
The last observed Google Calendar representation and ETag used to reconcile external edits without overwriting a newer version.
_Avoid_: event cache, Calendar snapshot

**Automation Exception**:
A Source Message whose Event Details cannot be determined safely and is therefore withheld from all calendar and LINE actions pending review.
_Avoid_: failed email, error

**Automation Warning**:
A non-blocking condition where automation continues with an explicit default while informing operators of the assumption.
_Avoid_: exception, alert

**Automation Suspension**:
A deliberate stop that prevents new actions and pending retries at Account or Automation Rule scope while preserving completed external actions and their Delivery Records.
_Avoid_: disable, shutdown

**Source List**:
A named set of Gmail sender addresses or domains whose messages may be selected by an Automation Rule.
_Avoid_: whitelist, sender filter

**Label List**:
A named set of Gmail labels whose messages may be selected by an Automation Rule.
_Avoid_: folder list

**Calendar Recipient List**:
A named set of Channel Handles invited to a Scheduled Event.
_Avoid_: share list, attendee list

**Channel Handle List**:
A named set of Channel Handles reachable through one LINE Connection that may receive a notification about a Scheduled Event.
_Avoid_: LINE recipient list

**Operations Destination List**:
The Account's dedicated Channel Handle List for Automation Warnings, Automation Exceptions, and connection health alerts rather than Contact-facing event notifications.
_Avoid_: admin group, error channel

**Delivery Record**:
An immutable account of an external action linking its Account, Automation Rule, Source Message, Google or LINE Connection, destination, Scheduled Event, outcome, and timestamps.
_Avoid_: log, send history

**Recovery Receipt**:
A small encrypted R2 record of one successful external effect, retained independently of Account D1 long enough to reconstruct idempotency after Time Travel recovery.
_Avoid_: backup, duplicate log

**Delivery Attempt**:
A single Calendar, Drive-publication, or LINE operation for one destination or resource, whose success or failure is tracked independently within a Delivery Record.
_Avoid_: retry, request log

**Delivery Batch**:
Up to five ordered LINE message objects for one LINE Connection and one Channel Handle sent in a single Messaging API request while retaining separate Delivery Records.
_Avoid_: bulk send, multicast

**Scheduled Event**:
A Google Calendar event maintained across related Source Messages and Calendar Revisions through Event Changes and Manual Overrides.
_Avoid_: appointment, calendar entry

**Event Series**:
A recurring Google Calendar series that groups related Event Occurrences under one recurrence definition.
_Avoid_: recurring event, schedule

**Event Occurrence**:
One dated occurrence within an Event Series with its own Recipient Snapshot, Registration Deadline, Attendance Registrations, comments, and Delivery Records.
_Avoid_: instance, session

**Attendance Registration**:
A Contact's authoritative attending, not-attending, or unanswered decision for a Scheduled Event, changeable until that event's registration deadline.
_Avoid_: Calendar RSVP, attendance response

**Guest Registration**:
One declared attendance at a Scheduled Event by a person who is not a Contact, carrying that person's name, their Affiliation, their attending or not-attending state, and the Event Response that declared it. A Guest Registration is written on someone else's behalf by whoever returned the Event Response, so it grants no Contact Page access, receives no invitation or reminder, and never becomes an Attendance Registration.
_Avoid_: guest attendance, external attendee, participant

**Affiliation**:
The name a Guest Registration gives for the outside body its people came from. It is text that FlareChat groups and counts by, never an Account.
_Avoid_: organization, club, group

**Eligible Recipient**:
A Contact invited to a Scheduled Event and allowed to submit an Attendance Registration, without being presumed to attend.
_Avoid_: participant, confirmed attendee

**Recipient Snapshot**:
A versioned set of Eligible Recipients resolved from executed Routing Policies, changed by a newly due matched rule or an explicit previewed synchronization from current typed lists.
_Avoid_: recipient cache, resolved list

**Registration Deadline**:
The instant after which Attendance Registrations are locked unless reopened by the Account, extracted from the source or supplied by an Automation Rule default.
_Avoid_: RSVP deadline, cutoff

**Reminder Eligibility**:
The state of an Eligible Recipient whose Attendance Registration is unanswered before the Registration Deadline; attending and not-attending registrations are never eligible.
_Avoid_: reminder target, pending member

**Participant Comment**:
A note attached to an Attendance Registration and visible to all Eligible Recipients through the event's companion page.
_Avoid_: Calendar comment, public note

**Organizer Note**:
A note attached to an Attendance Registration and visible only to the Account.
_Avoid_: private comment, admin memo

**Recipient**:
A Contact selected by an Automation Rule to receive a Scheduled Event invitation or LINE notification.
_Avoid_: user, attendee

**Task**:
An Account-owned, deadline-bearing work item extracted once from a Source Message and tracked until completed.
_Avoid_: reminder, to-do

**Operational Task Role**:
An Account-defined responsibility used to route a Task, distinct from Account ownership. Every Account defines its own set; an Automation Rule selects the subset it may assign, and a Task Assignment names the holder once per Account rather than once per rule.
_Avoid_: member role, permission

**Task Assignment**:
The current Contact who holds an Operational Task Role; each Task retains the assignee identity and name captured when it was created.
_Avoid_: recipient assignment, authorization

**Task Reassignment Review**:
The open question of whether the incomplete Tasks still match the Operational Task Roles, raised by any change to the role set and settled only by the Account accepting or rejecting the AI's proposal for each Task.
_Avoid_: rebalancing, bulk reassignment
