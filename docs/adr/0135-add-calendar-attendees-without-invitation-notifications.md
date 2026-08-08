# Add Calendar attendees without invitation notifications

Every path that adds a person to a Google Calendar event uses `sendUpdates=none`. The person remains an attendee, but Google is not asked to send an invitation email or Calendar notification when the event is created, when Event Refresh adds a newly active Member, or when an Admin retries one recipient's Calendar delivery. Agent Rules use the same explicit parameter rather than depending on Google's default.

This changes only invitation delivery. A later merge that makes a Significant Change still uses `sendUpdates=all` under ADR 0133, because notifying existing attendees that a meeting moved is a different effect from announcing that they were added. Recipient Snapshots and Delivery Records still describe who was added to an event; success now means that Calendar accepted the attendee, not that Google notified them.

Google warns that `sendUpdates=none` can prevent events from syncing to some external calendar systems. That trade-off is accepted because the Organization wants attendee membership without an invitation notification. This supersedes the notification choices in ADR 0125 and ADR 0128 while leaving their attendee-selection and additive-merge rules intact.
