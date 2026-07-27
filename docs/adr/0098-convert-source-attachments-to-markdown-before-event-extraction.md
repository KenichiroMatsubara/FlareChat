# Convert Source Attachments to Markdown before Event Extraction

Mail Automation converts every accepted Source Attachment with the Worker AI
binding's `env.AI.toMarkdown()` before sending material to Gemini. Gemini
receives only the filename, original MIME type, and bounded event-relevant
Markdown or plain text; it never receives an attachment's original bytes.

The converter records Cloudflare's `ConversionResult.tokens` and admits at
most 4,000 attachment tokens in total to a single Event Details extraction.
For documents above that budget, it chunks the conversion and keeps only
date, time, title, and location-bearing chunks with their immediate context.
The Worker logs both the source conversion tokens and selected-token count so
deployment observability can detect document growth and Workers AI failures.

PDF, DOCX, XLSX, and ordinary document conversion use the Workers AI Markdown
service, which Cloudflare documents as free for most format conversions.
Image and scanned-document conversion can invoke Workers AI models; usage
outside the included allocation is therefore an operational cost signal, not
a successful conversion to ignore.

If Workers AI returns an error, an empty result, or no event-bearing text for
DOCX or spreadsheet formats, Mail Automation falls back to its bounded local
Office normalizer. That fallback preserves XLSX sheet names, addresses, value
types, and formulae when Markdown's presentation-oriented representation
would lose information needed for Event Details. Other failed conversions are
treated as extraction failures: the normal Automation Inbox creates an
Automation Exception and the manual Mailbox Test returns an error. Neither
path creates an attachment-less successful Scheduled Event.

Drive and Calendar continue to receive the original Source Attachment. The
converted text is extraction input only and is never substituted for the
published attachment.

References:

- [Cloudflare Markdown Conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/)
- [Workers binding usage](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/)
- [Supported formats and image-cost note](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/)
