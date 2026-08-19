# Build channels into the product

A Channel is implemented by the product, not configured by an Account. Adding one is a release. A Channel must supply a signature-verified inbound endpoint, a handle namespace its Contacts are discovered in, a recordable delivery receipt, and structured reply controls; an external MCP server can supply only the third, because it cannot mount a webhook on this Worker or own a namespace.

Allowing Accounts to define Channels would therefore only ever produce send-only ones. A send-only Channel cannot hold a Channel Handle in the sense ADR 0139 defines, since no reply ever arrives to discover the handle from, and it would make "delivered somewhere nobody is reading" an ordinary outcome.

Generality is supplied elsewhere. Posting to an arbitrary destination stays freely available through MCP; what stays privileged is the narrower idea of a place where a Contact lives and answers.
