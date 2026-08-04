# Write Calendar descriptions as summary-first HTML

A Scheduled Event's Calendar description is built as HTML: the Event Summary first, then each Public Attachment as an `<a href>` labelled with its filename, then the provenance sentence naming the Source Message. Raw Drive URLs are no longer written into the description. On a phone a published Drive URL wraps across five or six lines and pushes every readable fact out of view, which is exactly what the description exists to carry.

Google Calendar renders a small HTML subset in descriptions, so the filename label is the closest equivalent of Markdown's `[filename](url)`, which Calendar does not render. The Calendar `attachments` field is unchanged and still carries the same files as first-class attachment chips; the description links are the readable copy of that list, not a replacement for it.

The description is assembled from untrusted extracted text and untrusted filenames, so every text node is HTML-escaped and only an absolute `http(s)` URL becomes a link; anything else stays inert escaped text. Escaping is the reason this stays one function rather than a template scattered across the automation path: a Source Message that contains markup must never be able to author markup in an Organization's calendar.

## Considered options

Keeping the plain-text description and shortening the URL was rejected. Any shortening either loses the address or introduces a redirector that the deployment would then own, and the label a reader actually wants is the filename that already exists.

Making the link format an Organization setting was rejected. Both variants would have to stay tested and supported forever for a choice no Organization has a reason to make differently, and the raw-URL variant is the one this decision exists to remove.
