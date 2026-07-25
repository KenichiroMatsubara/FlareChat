# Quarantine and scan source attachments

Superseded by ADR 0066.

All Source Message attachments enter encrypted quarantine before any extraction or sharing. Cloudflare Containers perform malware, encryption, type, and size checks; safe PDF, Office, image, and text content may be extracted by AI, while other safe formats are still copied to Drive. Dangerous, encrypted, or oversized attachments are withheld and create Automation Exceptions rather than reaching recipients.
