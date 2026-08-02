# State the Received Date as a Trusted Extraction Fact

Mail Automation tells the extraction model when the Source Message arrived,
and permits exactly one use of that fact: completing a date that states its
month and day but omits its year. The received date is stated in the system
message, as `receivedAt` with the `Asia/Tokyo` time zone this product
schedules in, and never in the user message that carries the email and its
attachments.

Japanese invitations routinely write a payment deadline as `5月15日(金)`
while stating the year only in a covering paragraph, or in an attachment, or
nowhere at all. Extraction previously required an explicit year and dropped
those deadlines, which meant the Operational Task that the invitation exists
to prompt was the one thing the extraction lost. Completing the year is a
bounded repair: the month and day are stated, and the received date decides
between the only two candidate years. A date missing its month or its day is
still omitted rather than completed, and no relative expression is resolved.

The received date comes from Gmail's `internalDate`, not from the message.
Document metadata was considered as the reference date and rejected. A PDF's
`CreationDate` records when someone authored a file, which a forward or a
resend detaches from the invitation entirely, and every field in that
metadata block is written by the sender. Delivery time is the one temporal
fact this product observes rather than receives.

Placing the fact in the system message makes the trust boundary the same as
the message boundary. The user message is already declared to the model as
data to be read and never obeyed; a sender who writes their own
`receivedAt` block into an email body is writing it inside that untrusted
region, where the instructions tell the model to ignore it. When Gmail
supplies no usable `internalDate`, both the fact and the permission are
withheld and extraction returns to refusing year completion, because a
guessed reference date would silently produce confident, wrong deadlines.
