# Alert only operators about calendar deletion

When the organizer's Google Calendar event is deleted, Mail Automation does not recreate it and sends no member-facing LINE cancellation. It emits an operations alert, allows a 15-minute restoration window, then closes attendance and reminders as cancelled if the event remains deleted; member-facing Calendar behavior is left to Google Calendar.
