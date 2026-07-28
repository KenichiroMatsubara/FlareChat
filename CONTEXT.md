# Mail Automation

Mail Automation turns selected Gmail messages into shared calendar events and LINE notifications without a human approval step.

The deployment uses the Workers Paid plan and is designed to remain near its $5 monthly minimum under the intended small-organization workload. Cloudflare usage above included allowances may incur additional charges, so this is a cost target rather than a hard spending guarantee. Google, LINE, and AI provider quotas, plans, and charges remain separate Organization-managed constraints.

The deployment uses one Control D1 database plus one Organization D1 database per Organization. Control D1 contains only identities, Organization routing, memberships, and deployment capacity state; each Organization D1 contains that Organization's rules, events, recipients, Jobs, credentials, and history. Application-owned Durable Objects are not used.

Organization registration automatically provisions a new D1 database, applies the current schema, adds a uniquely named D1 binding to the Worker through the Cloudflare API, verifies access, and only then activates the Organization.

Application entry has two explicit Google intents. Existing members use identity-only login with `openid`, `email`, and `profile`; it resolves the Identity by Google `sub`, creates only an application session, and never creates or resumes Organization setup. Organization creation uses one separate complete authorization. The authorized account becomes both the Automation Inbox and the initial Owner identity, and its display name is the editable Organization-name default. D1 provisioning starts only after Google returns the complete required grant: identity, `gmail.readonly`, `gmail.send`, `calendar.events.owned`, and `drive.file`. Partial consent creates no Organization or D1 database; no separate application login allowlist is required for the private pilot.

If Organization creation identifies an Identity that already has an active Organization Membership, Mail Automation discards the broader Google credential and completes ordinary application login instead. It creates no Organization setup, Organization, or D1 database.

The browser carries only the application session cookie. A bootstrap interface derives one discriminated application state from durable Control D1 records: signed out, unassigned, confirming Organization, provisioning, provisioning failed, or ready. Short-lived OAuth attempts, name-confirmation setup, and retryable provisioning are separate records. Automation Inbox ownership is claimed by the stable Google `sub`, with the email address retained as current display and delivery data rather than as identity.

The Automation Inbox remains an Organization-owned Google Connection rather than a human membership record, even when its Google identity also identifies the initial Owner. Setup requires neither Owner email re-entry nor passkey registration.

An Organization setup session expires fifteen minutes after the Automation Inbox grant while the installer confirms the editable Organization name. If confirmation is not completed in time, Mail Automation revokes and deletes the Google credential and creates no Organization D1 database.

After Google authorization and name confirmation succeed, a failed D1 provisioning operation may retain the encrypted Google credential and initial Owner record for at most twenty-four hours while explicit and automatic idempotent retries remain available. The failed phase and concrete error remain visible. Expiry revokes the grant, deletes the pending credential, and requires a new setup.

When an estimated included Cloudflare allowance or configured cost threshold approaches exhaustion, interactive attendance, administration, and authentication traffic takes precedence. New inbox processing, AI extraction, and ordinary LINE delivery are retained as pending work and resume oldest-first after capacity recovers.

Background capacity is fairly apportioned among active Organizations. An Organization may borrow unused capacity, but exhausting its own current allocation pauses only its background work and must not consume another Organization's protected share.

R2 usage warnings are emailed to the deployment operator at `kenmatsu331@gmail.com` when estimated monthly storage reaches 80% and 95% of the free allowance. R2 ingestion is not automatically stopped and Source Snapshots are not automatically deleted, so ignored warnings may result in billable overage.

Deployment-level capacity warnings use a Cloudflare Email Service binding restricted to the verified destination `kenmatsu331@gmail.com`; they never use an Organization's Automation Inbox.

Estimated Workers, D1, Queues, R2, and other Cloudflare usage produces deployment warnings at 80% and 95% of each included monthly allowance. Cloudflare overage remains possible; failed or rate-limited work stays pending and never counts as successful delivery.

Estimated aggregate Cloudflare charges produce an additional deployment email warning at projected monthly totals of USD 6 and USD 10. Each threshold fires once per billing period, does not automatically stop processing, and resets for the next period.

A durable Job row in the owning Organization D1 database is the source of truth for every asynchronous unit of work. A Queue message is only a replaceable wake-up hint containing an Organization and Job identifier; scheduled recovery scans rediscover due Jobs if a hint expires or is lost.

The initial private deployment uses one Google OAuth application configured as `External / In production` without completed verification. It accepts Google's unverified-app warning and lifetime user cap to avoid Testing-mode refresh-token expiry. Organization creation requires the complete Automation Inbox grant before provisioning; broader public onboarding requires verification and any applicable security assessment.

Organization connection credentials are encrypted with an Organization-specific data-encryption key. That key is wrapped by a versioned deployment master key held as a Worker Secret, allowing stored credentials to be rewrapped during key rotation without exposing plaintext in D1.

If Google Drive policy prevents an attachment from becoming a Public Attachment, the event is retained only on the Automation Inbox's Calendar as an administrative draft. Recipient invitations and member notifications are withheld until publication succeeds, and an Automation Exception supports retry after policy correction.

Completed Delivery Records and audit history older than twelve months are moved from Organization D1 into encrypted, compressed monthly R2 archives. Organization D1 retains archive indexes for GUI retrieval; active rules, recipients, credentials, pending Jobs, attendance for active events, and future events are never archived by this process.

The initial deployment creates no separate daily D1 backup. It relies on Workers Paid D1 Time Travel for thirty-day database recovery and on encrypted R2 archives for cold Delivery Record and audit history.

Every successful external effect also creates an encrypted immutable Recovery Receipt in private R2 for thirty-five days. After an Organization D1 Time Travel restore, automation remains suspended until receipts newer than the restore point have rebuilt the missing idempotency and Delivery Records.

An Organization Owner may request a Time Travel restore, but only the deployment operator may execute it. Restore suspends the Organization, exports its current D1 state, performs recovery, and reconciles Recovery Receipts before resumption. A dedicated restore-request GUI is deferred beyond the initial delivery; the same policy may initially be followed through an operator runbook.

Attachment intake initially permits at most 20 MiB per attachment and 40 MiB across one Source Message. An Organization may configure smaller limits. Exceeding either limit withholds the message from automatic event delivery and creates an Automation Exception.

## Language

**Organization**:
A security and ownership scope whose members jointly manage Google Connections, typed lists, Automation Rules, Scheduled Events, and audit history.
_Avoid_: tenant, team, workspace

**Owner**:
An Organization member who controls membership, connections, settings, and all automation operations.
_Avoid_: super admin

**Admin**:
An Organization member who manages connections, typed lists, Automation Rules, and Automation Exceptions.
_Avoid_: administrator

**Operator**:
An Organization member who operates typed lists and Automation Rules and may pause, resume, or retry automation.
_Avoid_: editor

**Viewer**:
An Organization member with read-only access to Scheduled Events, Delivery Records, and Automation Exceptions.
_Avoid_: read-only user

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

**Attachment Association**:
A relevance link between one safe source attachment and one Event Candidate; either side may participate in multiple associations.
_Avoid_: attachment assignment, event file

**Google Connection**:
An authorized Google account owned by one Organization with an explicit set of Gmail, Calendar, or Drive capabilities.
_Avoid_: Google user, member account

**Automation Inbox**:
A single Google Connection authorized by an Organization to read Source Messages, send operational and recipient email, own Scheduled Events, and store their attachments. It never grants mailbox access to a Recipient Profile.
_Avoid_: shared Gmail, monitored account

**Member Address**:
A member's email address used only as a Calendar invitation destination, without OAuth or mailbox access.
_Avoid_: member Gmail connection, monitored user

**Recipient Profile**:
A person who may receive calendar or LINE deliveries, identified by a name, Member Addresses, LINE Destinations, membership status, and Organization-defined tags without needing application access.
_Avoid_: user, contact, account

**Recipient Link**:
A short-lived, single-use association that proves a LINE Destination belongs to one Recipient Profile without requiring application login or Google OAuth.
_Avoid_: invite, account link

**Registration Link**:
A revocable, unguessable link scoped to one Recipient Profile and one Scheduled Event that permits attendance and comment changes until the Registration Deadline.
_Avoid_: login link, public form

**LINE Connection**:
An authorized LINE Messaging API channel owned by one Organization and used as the sender for notifications.
_Avoid_: LINE account, bot

**AI Connection**:
An Organization-owned model provider authorization used to derive Event Details, with one Organization default and optional Automation Rule overrides.
_Avoid_: endpoint, model account

**LINE Destination**:
A LINE user, group, or room discovered through a verified webhook on one LINE Connection and named by an Organization member.
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
The Primary Rule retained by a Scheduled Event for interpreting its later Event Changes unless an Operator explicitly reassigns it.
_Avoid_: event rule, pinned rule

**Rule Revision**:
An immutable version of an Automation Rule's selection, extraction, routing, scheduling, and delivery configuration.
_Avoid_: rule history, configuration version

**Rule State**:
The Draft, Active, Suspended, or Archived lifecycle status that determines whether an Automation Rule may preview, execute, resume, or remain historical.
_Avoid_: enabled flag, rule status

**Event Details**:
The structured title, start and end time, time zone, location, and description extracted from a Source Message through an AI Connection and completed with an Automation Rule's defaults.
_Avoid_: parsed fields, event data

**Event Candidate**:
One distinct proposed event or recurring series extracted from a Source Message before it becomes a Scheduled Event or Automation Exception.
_Avoid_: detected event, draft

**Event Category**:
A nullable Organization-defined classification selected for an Event Candidate that may supply default recipients, LINE destinations, registration settings, and notification templates.
_Avoid_: tag, event type

**Extraction Policy**:
Trusted Organization-authored instructions and defaults that constrain how an Automation Rule derives Event Details from untrusted Source Message content.
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

**Manual Override**:
A field value changed by an authorized member in the GUI or directly on the organizer's Google Calendar that automated Event Changes may not overwrite.
_Avoid_: edit, correction

**Significant Change**:
A change to a Scheduled Event's date, time, location, or Registration Deadline that warrants a member-facing LINE notification.
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
The Organization's dedicated LINE Destination List for Automation Warnings, Automation Exceptions, and connection health alerts rather than member-facing event notifications.
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
A Recipient Profile's authoritative attending, not-attending, or unanswered decision for a Scheduled Event, changeable until that event's registration deadline.
_Avoid_: Calendar RSVP, attendance response

**Eligible Recipient**:
A Recipient Profile invited to a Scheduled Event and allowed to submit an Attendance Registration, without being presumed to attend.
_Avoid_: participant, confirmed attendee

**Recipient Snapshot**:
A versioned set of Eligible Recipients resolved from executed Routing Policies, changed by a newly due matched rule or an explicit previewed synchronization from current tメール部分だけにしてくださいyped lists.
_Avoid_: recipient cache, resolved list

**Registration Deadline**:
The instant after which Attendance Registrations are locked unless reopened by an authorized Organization member, extracted from the source or supplied by an Automation Rule default.
_Avoid_: RSVP deadline, cutoff

**Reminder Eligibility**:
The state of an Eligible Recipient whose Attendance Registration is unanswered before the Registration Deadline; attending and not-attending registrations are never eligible.
_Avoid_: reminder target, pending member

**Participant Comment**:
A note attached to an Attendance Registration and visible to all Eligible Recipients through the event's companion page.
_Avoid_: Calendar comment, public note

**Organizer Note**:
A note attached to an Attendance Registration and visible only to Owners, Admins, and Operators.
_Avoid_: private comment, admin memo

**Recipient**:
A Recipient Profile selected by an Automation Rule to receive a Scheduled Event invitation or LINE notification.
_Avoid_: user, attendee

**Task**:
An Organization-owned, deadline-bearing work item extracted once from a Source Message and tracked until completed.
_Avoid_: reminder, to-do

**Operational Task Role**:
The responsibility used to route a Task—currently Organizer or Treasurer—distinct from an Organization member's application authorization role.
_Avoid_: member role, permission

**Task Assignment**:
The current named Organization member who holds an Operational Task Role; each Task retains the assignee identity and name captured when it was created.
_Avoid_: recipient assignment, authorization
