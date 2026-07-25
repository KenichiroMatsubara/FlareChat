# Send recipient mail through the Automation Inbox

The Organization's Automation Inbox receives the narrow Gmail scopes `gmail.readonly` and `gmail.send`. Mail Automation uses that account to send attendance reminders, attendance-change confirmations, and email fallbacks that belong to the Organization.

It does not request `gmail.modify`, change labels or read state, archive messages, or delete messages. Recipient Profiles and Member Addresses remain outbound destinations and are never asked for Google OAuth. Deployment-level Cloudflare capacity warnings remain separate under ADR 0072.
