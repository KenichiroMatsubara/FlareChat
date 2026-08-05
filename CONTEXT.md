# Mail Automation

Mail Automation turns selected Gmail messages into shared calendar events and LINE notifications without a human approval step.

Mail Automation is general. It knows Organizations, roles, rules, and destinations, but never the vocabulary of any particular organization; every domain-specific name lives in a Preset that an Organization copies and edits. A Schema Rule extracts Event Details, Tasks, and a Message Summary against one product-defined schema, so the external effects it can cause are known before it runs. An Agent Rule runs an Organization-authored Prompt with a bounded tool set and decides for itself whether and how to act, within the destinations its rule permits and under its Execution Mode. Dangerous freedom is confined to the second path; the first stays predictable and cheap.

The deployment uses the Workers Paid plan and is designed to remain near its $5 monthly minimum under the intended small-organization workload. Cloudflare usage above included allowances may incur additional charges, so this is a cost target rather than a hard spending guarantee. Google, LINE, and AI provider quotas, plans, and charges remain separate Organization-managed constraints.

The deployment uses one Control D1 database plus one Organization D1 database per Organization. Control D1 contains only identities, Organization routing, memberships, and deployment capacity state; each Organization D1 contains that Organization's rules, events, Members, Jobs, credentials, and history. Application-owned Durable Objects are not used.

Organization registration derives a human-readable D1 name from the confirmed Automation Inbox address using `flarechat-organization-{normalized-address}-{address-hash}`. Provisioning resolves that exact Cloudflare database before creating one, applies only unapplied schema migrations, attaches the deterministic binding, verifies access, and only then activates the Organization. A stored Cloudflare database UUID is a routing cache rather than the sole means of rediscovering the database; provisioning never selects an arbitrary available production database.

Production Worker releases are gated on Control D1 migration and a verified migration of every recorded Organization D1, including suspended Organizations and databases allocated by in-progress provisioning. A release barrier pauses only new Organization provisioning while the fleet is prepared and verified. All runtime Organization D1 access also passes through a schema-ready seam that repairs safe missing migrations before returning the database, so login, scheduled work, webhooks, and background automation share the same guarantee.

Application entry has two explicit Google intents. Existing Admins and Members use identity-only login with `openid`, `email`, and `profile`; it resolves the Identity by Google `sub`, creates only an application session, and never creates or resumes Organization setup. Organization creation uses one separate complete authorization. The authorized account becomes both the Automation Inbox and the initial Admin identity, and its display name is the editable Organization-name default. D1 provisioning starts only after Google returns the complete required grant: identity, `gmail.readonly`, `gmail.send`, `calendar.events.owned`, and `drive.file`. Partial consent creates no Organization or D1 database; no separate application login allowlist is required for the private pilot.

If Organization creation identifies an Identity that already has an active Organization Membership, Mail Automation discards the broader Google credential and completes ordinary application login instead. It creates no Organization setup, Organization, or D1 database.

The browser carries only the application session cookie. A bootstrap interface derives one discriminated application state from durable Control D1 records: signed out, unassigned, confirming Organization, provisioning, provisioning failed, or ready. Short-lived OAuth attempts, name-confirmation setup, and retryable provisioning are separate records. Automation Inbox ownership is claimed by the stable Google `sub`, with the email address retained as current display and delivery data rather than as identity.

The Automation Inbox remains an Organization-owned Google Connection rather than a human membership record, even when its Google identity also identifies the initial Admin. Setup requires neither Admin email re-entry nor passkey registration.

An Organization has one authorization role. An Admin signs into the management GUI and may perform every administrative operation; a Member holds no administrative authorization at all. Because the initial Admin is the Organization's own shared account rather than a person, no second Admin is provided; if one is ever wanted it is promoted from a Member, whose Google account is already bound.

A Member signs into a single Member Portal to register attendance, write comments, and complete the Tasks assigned to them. A Member may read every Task in the Organization but may complete only their own. A Member reaches the Portal for the first time through a Portal Invitation delivered to their linked LINE Destination; a Member with no linked LINE Destination has no Portal access and is administered entirely by an Admin.

An Attendance Registration belongs to a Member rather than to an unguessable URL, so a leaked link grants nothing. An unfinished Task notifies its assignee alone at the same seven, three, and one day milestones the attendance reminders use.

Adding, renaming, redescribing, or removing an Operational Task Role opens a Task Reassignment Review, because Tasks already extracted were routed by a role set that no longer exists. The review offers one AI proposal per incomplete Task, naming a role and the evidence that chose it; completed Tasks are history and are never revisited. Nothing moves until an Admin accepts a proposal, and accepting one takes the assignee from the role's current holder. Accepting none still closes the review, so a deliberate decision to leave the Tasks alone is not asked for again.

An Organization setup session expires fifteen minutes after the Automation Inbox grant while the installer confirms the editable Organization name. If confirmation is not completed in time, Mail Automation revokes and deletes the Google credential and creates no Organization D1 database.

After Google authorization and name confirmation succeed, a failed D1 provisioning operation may retain the encrypted Google credential and initial Admin record for at most twenty-four hours while explicit and automatic idempotent retries remain available. The failed phase and concrete error remain visible. Expiry revokes the grant, deletes the pending credential, and requires a new setup.

When an estimated included Cloudflare allowance or configured cost threshold approaches exhaustion, interactive attendance, administration, and authentication traffic takes precedence. New inbox processing, AI extraction, and ordinary LINE delivery are retained as pending work and resume oldest-first after capacity recovers.

Background capacity is fairly apportioned among active Organizations. An Organization may borrow unused capacity, but exhausting its own current allocation pauses only its background work and must not consume another Organization's protected share.

R2 usage warnings are emailed to the deployment operator at `kenmatsu331@gmail.com` when estimated monthly storage reaches 80% and 95% of the free allowance. R2 ingestion is not automatically stopped and Source Snapshots are not automatically deleted, so ignored warnings may result in billable overage.

Deployment-level capacity warnings use a Cloudflare Email Service binding restricted to the verified destination `kenmatsu331@gmail.com`; they never use an Organization's Automation Inbox.

Estimated Workers, D1, Queues, R2, and other Cloudflare usage produces deployment warnings at 80% and 95% of each included monthly allowance. Cloudflare overage remains possible; failed or rate-limited work stays pending and never counts as successful delivery.

Estimated aggregate Cloudflare charges produce an additional deployment email warning at projected monthly totals of USD 6 and USD 10. Each threshold fires once per billing period, does not automatically stop processing, and resets for the next period.

A durable Job row in the owning Organization D1 database is the source of truth for every asynchronous unit of work. A Queue message is only a replaceable wake-up hint containing an Organization and Job identifier; scheduled recovery scans rediscover due Jobs if a hint expires or is lost.

The initial private deployment uses one Google OAuth application configured as `External / In production` without completed verification. It accepts Google's unverified-app warning and lifetime user cap to avoid Testing-mode refresh-token expiry. Organization creation requires the complete Automation Inbox grant before provisioning; broader public onboarding requires verification and any applicable security assessment.

Automation runs unattended for as long as its grant holds, without anyone signing into the administration GUI. Only `invalid_grant` from Google suspends an Automation Inbox for reauthentication; every other failed run is recorded and retried on the next schedule. A rejected grant is mailed to every active Admin through the Automation Inbox immediately, and any other continuing failure is mailed after a full day of failed retries and repeated at most weekly until it clears.

Organization connection credentials are encrypted with an Organization-specific data-encryption key. That key is wrapped by a versioned deployment master key held as a Worker Secret, allowing stored credentials to be rewrapped during key rotation without exposing plaintext in D1.

Every Scheduled Event insertion is an upsert. An Event Candidate is correlated against the Automation Inbox's calendar as it currently stands rather than against what Mail Automation last recorded, and a correlated candidate merges into that event field by field instead of creating a second one. A field whose current Calendar value differs from the value Mail Automation last wrote is a Manual Override and is left out of the merge while the remaining fields still update. A correspondence whose two start times stand more than seven days apart is never merged, so a distant match becomes a new Scheduled Event rather than moving an existing invitation list onto a different meeting. No Admin approval stands between a merge and the calendar.

One extraction states the kind of the Source Message it read. An Event Response's extracted event fields locate the Scheduled Event it answers, within an Organization-configured number of days either side of that event's start, and are never written to it; an Event Response that locates nothing creates nothing. Its Message Summary, Tasks, and attachments are handled as they are for any other Source Message.

An Event Response may return a completed registration naming people from outside the Organization. Each becomes one Guest Registration on the Scheduled Event that response answers, keyed by the Event Response that declared it so that reprocessing and correction replace those rows rather than accumulate beside them. Guest Registrations are retained with the delivery history and archived with it after twelve months.

A merge notifies Members only when it changes a Scheduled Event's date, time, location, or Registration Deadline. Any other merge, including one that only rewrites the Event Summary and one that adds Guest Registrations, updates the Calendar silently. The Google Calendar update and the Member-facing LINE message are gated by the same judgement, so a Member never receives one without the other.

A Scheduled Event's Calendar description states its Event Summary first, then the Guest Registration counts by Affiliation and never the guests' names, then each Public Attachment as a link labelled with its filename, then the sentence naming the Source Message it came from. Google Calendar renders a small HTML subset, so untrusted extracted text, Affiliations, and filenames are escaped and only absolute http(s) links are written.

A Scheduled Event created from a Source Message invites every active Member that carries an address as a Google Calendar attendee of the Automation Inbox's event, so the invitation reaches that Member's own Google account and calendar. The invited Members are frozen as the event's Recipient Snapshot when it is created, and one Delivery Record per Member records the invitation, so a later roster change never rewrites who an already delivered event reached.

If Google Drive policy prevents an attachment from becoming a Public Attachment, the event is retained only on the Automation Inbox's Calendar as an administrative draft. Recipient invitations and Member notifications are withheld until publication succeeds, and an Automation Exception supports retry after policy correction.

Completed Delivery Records and audit history older than twelve months are moved from Organization D1 into encrypted, compressed monthly R2 archives. Organization D1 retains archive indexes for GUI retrieval; active rules, recipients, credentials, pending Jobs, attendance for active events, and future events are never archived by this process.

The initial deployment creates no separate daily D1 backup. It relies on Workers Paid D1 Time Travel for thirty-day database recovery and on encrypted R2 archives for cold Delivery Record and audit history.

Every successful external effect also creates an encrypted immutable Recovery Receipt in private R2 for thirty-five days. After an Organization D1 Time Travel restore, automation remains suspended until receipts newer than the restore point have rebuilt the missing idempotency and Delivery Records.

An Organization Admin may request a Time Travel restore, but only the deployment operator may execute it. The deployment operator runs the service itself and is not an Organization role. Restore suspends the Organization, exports its current D1 state, performs recovery, and reconciles Recovery Receipts before resumption. A dedicated restore-request GUI is deferred beyond the initial delivery; the same policy may initially be followed through an operator runbook.

Attachment intake initially permits at most 20 MiB per attachment and 40 MiB across one Source Message. An Organization may configure smaller limits. Exceeding either limit withholds the message from automatic event delivery and creates an Automation Exception.

## Language

**Organization**:
A security and ownership scope whose Admins manage Google Connections, typed lists, Automation Rules, Scheduled Events, and audit history for its Members.
_Avoid_: tenant, team, workspace

**Admin**:
The Organization's only authorization role, held by an account that signs into the management GUI and may perform every administrative and automation operation.
_Avoid_: owner, operator, viewer, administrator, super admin

**Source Message**:
A Gmail message selected for automation, including its body and attachments.
_Avoid_: email, mail

**Source Snapshot**:
An encrypted, time-limited copy of a Source Message's raw content and original attachments retained for investigation and extraction reproducibility.
_Avoid_: email archive, backup

**Quarantined Attachment**:
A Source Message attachment withheld from AI, Drive, Calendar, and recipients until encryption, type, and size checks establish that it is acceptable to process. Mail Automation relies on Gmail's inbound malware scanning rather than running an independent scanner.
_Avoid_: temporary file, blocked file

**Public Attachment**:
A safe attachment stored once in Drive and readable without Google login by anyone who possesses its unindexed link.
_Avoid_: shared file, public document

**Attachment Folder Path**:
The Drive location an Organization writes for itself, beneath which Mail Automation creates one folder per Source Message and stores that message's Public Attachments.
_Avoid_: save location, drive path, output folder

**Attachment Association**:
A relevance link between one safe source attachment and one Event Candidate; either side may participate in multiple associations.
_Avoid_: attachment assignment, event file

**Google Connection**:
An authorized Google account owned by one Organization with an explicit set of Gmail, Calendar, or Drive capabilities.
_Avoid_: Google user, member account

**Automation Inbox**:
A single Google Connection authorized by an Organization to read Source Messages, send operational and recipient email, own Scheduled Events, and store their attachments. It never grants mailbox access to a Member.
_Avoid_: shared Gmail, monitored account

**Member Address**:
A Member's email address used only as a Calendar invitation destination, without OAuth or mailbox access.
_Avoid_: member Gmail connection, monitored user

**Member**:
A person belonging to an Organization, identified by a name, Member Addresses, LINE Destinations, membership status, and Organization-defined tags. A Member holds Operational Task Roles, receives deliveries, and signs into the Member Portal, but holds no administrative authorization.
_Avoid_: recipient profile, user, contact, account

**Member Link**:
A short-lived, single-use association that proves a LINE Destination belongs to one Member.
_Avoid_: recipient link, invite, account link

**Member Portal**:
The signed-in page where a Member registers attendance, writes comments, and completes their own Tasks. First entry binds that Member to a Google account by its stable `sub`; afterwards that account alone identifies them.
_Avoid_: registration link, login link, public form

**Portal Invitation**:
The short-lived, single-use link that first brings one Member into the Member Portal, delivered to their linked LINE Destination. It is distinct from a Member Link, which proves a LINE Destination belongs to a Member rather than binding a Google account.
_Avoid_: registration link, invite link, signup link

**LINE Connection**:
An authorized LINE Messaging API channel owned by one Organization and used as the sender for notifications.
_Avoid_: LINE account, bot

**AI Connection**:
An Organization-owned model provider authorization used to derive Event Details, with one Organization default and optional Automation Rule overrides.
_Avoid_: endpoint, model account

**LINE Destination**:
A LINE user, group, or room discovered through a verified webhook, or entered manually by an Admin, on one LINE Connection and named by an Admin. Its source, webhook or manual, remains recorded and visible.
_Avoid_: LINE contact, webhook source

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
The Primary Rule retained by a Scheduled Event for interpreting its later Event Changes unless an Admin explicitly reassigns it.
_Avoid_: event rule, pinned rule

**Schema Rule**:
An Automation Rule that derives Event Details, Tasks, and a Message Summary from a Source Message through one product-defined extraction schema, so that every external effect it can cause is known before it runs.
_Avoid_: standard rule, default rule

**Agent Rule**:
An Automation Rule that runs an Organization-authored Prompt against a Source Message with a bounded tool set, deciding for itself whether and how often to act within the destinations its rule permits.
_Avoid_: AI rule, custom rule, MCP rule

**Prompt**:
An Organization-owned, separately identified set of instructions referenced by Agent Rules, retained so that any produced Scheduled Event, Task, or delivery names the exact instructions that caused it.
_Avoid_: system message, template

**Preset**:
A self-contained sample configuration—rules, Prompts, Operational Task Roles, and empty typed lists—copied once into an Organization and thereafter unlinked from the product release that supplied it.
_Avoid_: template, default configuration

**Rule Revision**:
An immutable version of an Automation Rule's selection, extraction, routing, scheduling, and delivery configuration.
_Avoid_: rule history, configuration version

**Rule State**:
The Draft, Active, Suspended, or Archived lifecycle status that determines whether an Automation Rule may preview, execute, resume, or remain historical. An Agent Rule has no Draft state, because its Execution Mode already governs whether a run may act.
_Avoid_: enabled flag, rule status

**Execution Mode**:
Whether an Agent Rule may only read, may write once an Admin approves each proposal, or may write unattended.
_Avoid_: permission level, safety setting

**Proposed Action**:
One external effect an Agent Rule's run recorded instead of performing, held with its exact arguments until an Admin approves it, rejects it, or it expires.
_Avoid_: pending delivery, draft action

**Run Transcript**:
The complete encrypted record of one Agent Rule run—its Prompt revision, model, every tool call with arguments and results, and final output—retained to explain a run that will never be retried.
_Avoid_: log, agent history

**Verified Delivery Facts**:
The facts about a Source Message that Mail Automation observed rather than read from it—presently only when it arrived—stated to an extraction separately from the message so that a sender cannot author them. They authorize completing a date that omits its year and nothing else.
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
A nullable Organization-defined classification selected for an Event Candidate that may supply default recipients, LINE destinations, registration settings, and notification templates.
_Avoid_: tag, event type

**Extraction Policy**:
Trusted Organization-authored instructions and defaults that constrain how a Schema Rule derives Event Details from untrusted Source Message content, within the product-defined extraction schema.
_Avoid_: prompt, system message

**Selection Policy**:
A boolean expression over sender, domain, Gmail label, recipient headers, content keywords, attachment properties, and received time that selects Source Messages for an Automation Rule.
_Avoid_: email filter, Gmail query

**Routing Policy**:
A boolean expression over one Event Candidate's extracted attributes that selects its Calendar Recipient Lists and LINE Destination Lists after message selection.
_Avoid_: recipient rule, distribution filter

**Event Change**:
An AI-classified creation, modification, or cancellation derived from a Source Message and correlated with one Scheduled Event.
_Avoid_: email action, event update

**Event Response**:
A Source Message correlated with an existing Scheduled Event that proposes no new event of its own, such as an acceptance, an acknowledgement, or a registration returned against it. Its extracted event fields locate the Scheduled Event it answers and never create one.
_Avoid_: reply, response mail, follow-up

**Event Response Window**:
How many days either side of a Scheduled Event's start an Event Response may still be recognised as answering it. An Organization sets it for itself, because how far ahead a registration is returned is a fact about that Organization's correspondence rather than about Mail Automation.
_Avoid_: correlation window, tolerance, matching range

**Manual Override**:
A field value changed by an Admin in the GUI or directly on the organizer's Google Calendar that automated Event Changes may not overwrite. An Event Refresh is the one exception, because an Admin approves that single rewrite after seeing what it replaces.
_Avoid_: edit, correction

**Source Attribution**:
The sentence in a Scheduled Event's Calendar description naming the Source Message it came from, and the correlation between the two.
_Avoid_: footer, provenance note

**Event Refresh**:
An Admin-approved rewrite of an existing Scheduled Event's Calendar fields from a fresh extraction of its Source Message, together with an additive invitation of the active Member roster: a Member the Calendar already lists keeps whatever they answered, and only a Member missing from that list is added.
_Avoid_: resync, regenerate, backfill

**Significant Change**:
A change to a Scheduled Event's date, time, location, or Registration Deadline that warrants a Member-facing LINE notification.
_Avoid_: important update, event edit

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
A deliberate stop that prevents new actions and pending retries at Organization or Automation Rule scope while preserving completed external actions and their Delivery Records.
_Avoid_: disable, shutdown

**Source List**:
A named set of Gmail sender addresses or domains whose messages may be selected by an Automation Rule.
_Avoid_: whitelist, sender filter

**Label List**:
A named set of Gmail labels whose messages may be selected by an Automation Rule.
_Avoid_: folder list

**Calendar Recipient List**:
A named set of Member Addresses invited to a Scheduled Event.
_Avoid_: share list, attendee list

**LINE Destination List**:
A named set of LINE Destinations reachable through one LINE Connection that may receive a notification about a Scheduled Event.
_Avoid_: LINE recipient list

**Operations Destination List**:
The Organization's dedicated LINE Destination List for Automation Warnings, Automation Exceptions, and connection health alerts rather than Member-facing event notifications.
_Avoid_: admin group, error channel

**Delivery Record**:
An immutable account of an external action linking its Organization, Automation Rule, Source Message, Google or LINE Connection, destination, Scheduled Event, outcome, and timestamps.
_Avoid_: log, send history

**Recovery Receipt**:
A small encrypted R2 record of one successful external effect, retained independently of Organization D1 long enough to reconstruct idempotency after Time Travel recovery.
_Avoid_: backup, duplicate log

**Delivery Attempt**:
A single Calendar, Drive-publication, or LINE operation for one destination or resource, whose success or failure is tracked independently within a Delivery Record.
_Avoid_: retry, request log

**Delivery Batch**:
Up to five ordered LINE message objects for one LINE Connection and one LINE Destination sent in a single Messaging API request while retaining separate Delivery Records.
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
A Member's authoritative attending, not-attending, or unanswered decision for a Scheduled Event, changeable until that event's registration deadline.
_Avoid_: Calendar RSVP, attendance response

**Guest Registration**:
One declared attendance at a Scheduled Event by a person who is not a Member, carrying that person's name, their Affiliation, their attending or not-attending state, and the Event Response that declared it. A Guest Registration is written on someone else's behalf by whoever returned the Event Response, so it grants no Member Portal access, receives no invitation or reminder, and never becomes an Attendance Registration.
_Avoid_: guest attendance, external attendee, participant

**Affiliation**:
The name a Guest Registration gives for the outside body its people came from. It is text that Mail Automation groups and counts by, never an Organization.
_Avoid_: organization, club, group

**Eligible Recipient**:
A Member invited to a Scheduled Event and allowed to submit an Attendance Registration, without being presumed to attend.
_Avoid_: participant, confirmed attendee

**Recipient Snapshot**:
A versioned set of Eligible Recipients resolved from executed Routing Policies, changed by a newly due matched rule or an explicit previewed synchronization from current typed lists.
_Avoid_: recipient cache, resolved list

**Registration Deadline**:
The instant after which Attendance Registrations are locked unless reopened by an Admin, extracted from the source or supplied by an Automation Rule default.
_Avoid_: RSVP deadline, cutoff

**Reminder Eligibility**:
The state of an Eligible Recipient whose Attendance Registration is unanswered before the Registration Deadline; attending and not-attending registrations are never eligible.
_Avoid_: reminder target, pending member

**Participant Comment**:
A note attached to an Attendance Registration and visible to all Eligible Recipients through the event's companion page.
_Avoid_: Calendar comment, public note

**Organizer Note**:
A note attached to an Attendance Registration and visible only to Admins.
_Avoid_: private comment, admin memo

**Recipient**:
A Member selected by an Automation Rule to receive a Scheduled Event invitation or LINE notification.
_Avoid_: user, attendee

**Task**:
An Organization-owned, deadline-bearing work item extracted once from a Source Message and tracked until completed.
_Avoid_: reminder, to-do

**Operational Task Role**:
An Organization-defined responsibility used to route a Task, distinct from Admin authorization. Every Organization defines its own set; an Automation Rule selects the subset it may assign, and a Task Assignment names the holder once per Organization rather than once per rule.
_Avoid_: member role, permission

**Task Assignment**:
The current Member who holds an Operational Task Role; each Task retains the assignee identity and name captured when it was created.
_Avoid_: recipient assignment, authorization

**Task Reassignment Review**:
The open question of whether the incomplete Tasks still match the Operational Task Roles, raised by any change to the role set and settled only by an Admin accepting or rejecting the AI's proposal for each Task.
_Avoid_: rebalancing, bulk reassignment
