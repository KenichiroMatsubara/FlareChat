# Send a test message through the one Channel seam

An operator can send one arbitrary message to one Contact from the administration GUI, and can call one registered MCP Server's tool with arguments they wrote. Both answers are evidence about production, because both travel the path production travels.

That required a seam that did not exist. Reaching a Contact on a Channel was written three times: the MCP Server's `channel.send`, the scheduled reminder of ADR 0156, and the Automation broadcast each resolved the Connection, decrypted the credential, found the handle, called the provider, and recorded the Delivery Record in their own way. The copies had already diverged — `reminder.schedule` accepted `channel: 'discord'` and enqueued the Job, and the Job handler refused every Channel but LINE, so an outside agent could schedule a Discord reminder that could never be delivered. A test send added as a fourth copy would have proved only that the fourth copy works.

`channel.ts` is now the only way the product reaches a Contact. A caller states a Contact, a Channel and a text; resolving the Connection, the handle, the provider request and the Delivery Record is the module's work, and every surface — the MCP Server, the reminder Job, an Automation run, and the Channel Test — passes through it. Reaching a Contact and asking where a Contact is reachable stay together, because a caller that has to guess a Channel will guess wrong.

Suppression stays outside that seam. What a repeat means differs between an Access Token, an Automation and a hand-run test, so the caller holding the scope decides and the seam only ever performs the send it was given. A Channel Test therefore consults no Suppression Window: a second run that silently sent nothing would report a Channel as working when it never spoke.

A Channel Test is an ordinary send in every other respect. It leaves a Delivery Record, because a real message really left, and the record is what an operator reading the history a week later needs to find. Its result names the destination and the identifier the provider returned, since `送信しました` on its own proves only that the request was made.

Testing a registered MCP Server is the second half, and it is not the same question. Listing a server's tools is the cheapest proof that its URL, token and revision are right; calling one tool with stated arguments is the only proof that the server does what it claims. Both use the client of ADR 0142 and report the server's own answer, failures included — a failed `tools/call` is returned as failed rather than as an error the GUI invented.

## Consequences

A Channel Test spends real provider quota and reaches a real person, so it is bounded to one Contact, one thousand characters, and one message per request, and it is reachable only by an authenticated operator of that Account — never by an Access Token, which has ADR 0152's suppression for a reason.

Calling a registered MCP Server's tool from the GUI has whatever effect that tool has. The arguments are the operator's, unmediated: this is the one place in the product where an outside tool is invoked without an Automation's Prompt or Tool Grant between, which is exactly what makes it a test.

A Discord reminder now delivers instead of failing, because the reminder Job asks the same seam every other surface asks.
