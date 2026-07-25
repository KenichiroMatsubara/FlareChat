# Separate extraction policy from message content

Automation Rules contain trusted Extraction Policies editable by Admins and previewable against real or sample messages before activation. Source Message bodies and attachments are always treated as untrusted data and cannot redefine extraction instructions, reducing prompt-injection risk while allowing domain-specific rules.
