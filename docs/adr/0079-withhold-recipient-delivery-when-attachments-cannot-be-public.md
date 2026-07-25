# Withhold recipient delivery when attachments cannot be public

If Google Drive policy or an API failure prevents a required attachment from becoming a Public Attachment, Mail Automation creates or retains the Scheduled Event only on the Automation Inbox's Primary Calendar as an administrative draft.

It withholds recipient invitations and member-facing notifications rather than silently delivering an event with missing or inaccessible material. The failure becomes an Automation Exception, and correction followed by retry continues from the existing event and Delivery Records instead of creating duplicates.
