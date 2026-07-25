# Preserve manual calendar edits

Edits made in the GUI or directly on the organizer's Google Calendar become Manual Overrides and are never overwritten by stale Source Messages or old local state. Calendar synchronization stores incremental sync tokens and per-event Calendar Revisions, writes with ETag preconditions, and converts conflicts into Automation Warnings; an expired sync token rebuilds only the Calendar projection and never deletes Scheduled Events, attendance, comments, or Delivery Records.
