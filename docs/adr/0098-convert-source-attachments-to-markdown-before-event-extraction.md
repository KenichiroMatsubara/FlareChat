# Convert Source Attachments to Markdown before Event Extraction

Mail Automation converts every accepted Source Attachment with the Worker AI
binding's `env.AI.toMarkdown()` before sending material to the selected AI
Connection. The OpenAI-compatible API receives only the filename, original
MIME type, and bounded event-relevant Markdown or plain text; it never
receives an attachment's original bytes.

A converted attachment is admitted whole. There is no token budget and no
chunk selection: a document that states its date once, in a sentence that
reads like prose, is exactly the document a relevance filter discards, and an
attachment silently reduced to its date-bearing fragments produces a
confident extraction from material an Admin never saw. The Worker records
Cloudflare's `ConversionResult.tokens` as the conversion estimate and a
selected-token count measured from the text actually sent, so deployment
observability can detect document growth and Workers AI failures.

What is removed is the conversion's own by-products, never the document's
contents. Mail Automation asks Workers AI to omit the PDF metadata section
through `conversionOptions.pdf.metadata`, and independently strips a leading
metadata section, the converter's echo of the filename, the contents heading,
and blank-line padding from every conversion, including the local Office
fallback. The metadata section is removed only when it opens the conversion
and consists entirely of `key=value` entries, so a document whose own
contents use that heading keeps them. Removal is deletion only: text is never
reordered, rewritten, truncated, or summarized. The opt-out and the removal
are deliberately redundant, because a conversion option that a future
binding ignores would otherwise degrade silently.

XLSX Markdown is additionally compacted to TSV, which is a change of
representation rather than a selection of contents.

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
- [Conversion options, including the PDF metadata opt-out](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/conversion-options/)
