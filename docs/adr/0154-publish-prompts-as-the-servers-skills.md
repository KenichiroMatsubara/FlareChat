# Publish Prompts as the server's skills

The MCP server of ADR 0152 advertises what an Account can do by publishing MCP prompts alongside its tools. A Prompt the Account already authored under ADR 0108 becomes one by being marked public, so the skills an outside agent sees are the same instructions an Automation runs and no second authoring surface appears.

Tools alone would hand an outside agent implements without intent. It could resolve a Contact and send to it, but nothing would tell it what this Account usually sends, to whom, or when, so "send the usual weekly notice" would have no meaning to it. The prompts carry that.

Resources are deliberately not published. Exposing the roster as a readable resource would create a second read path beside `contacts.search`, and ADR 0152's Contact List bound would then have to be enforced on both; one missed application of it discloses the whole roster. The read path stays single.
