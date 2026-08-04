# Store attachments under an Organization-configured folder path

Mail Automation stores Public Attachments beneath a Drive folder path the Organization types, creating one folder per Source Message under it, named by the message's received date and subject. ADR 0055's fixed year-and-event layout was never implemented — the upload carried no `parents`, so every attachment landed in the Drive root — and it could not have been implemented as written, because publication happens before the Scheduled Event exists so that the Calendar description can link the files. Naming the folder after the Source Message keeps every element known at upload time and needs no second pass to move anything. This supersedes ADR 0055.

Mail Automation creates the path itself. The `drive.file` grant of ADR 0095 sees only what the application created, so a folder the Organization made by hand is invisible to it and a same-named folder will sit beside that one; adopting an existing folder would instead require the Google Picker and a grant per selection. Whatever the Organization types is created verbatim, apart from `/` as the level separator, empty segments, control characters, and product length bounds. The path may not be empty, because an empty path is the Drive root this decision exists to stop.

## Consequences

One path per Organization rather than per Automation Rule: one Source Message may match several rules (ADR 0057) while its attachments are stored once (ADR 0047), so a per-rule path would need a precedence rule for the shared file.

Each Source Message's folder is recorded by its Drive folder ID and reused when the message is processed again, because ADR 0056 tracks manual renames and moves by stable ID and forbids restoring the generated layout. Two messages sharing a received date and subject therefore produce two folders. Changing the path never moves files already stored.
