# Run Operator Chat as Rule Runs

One exchange in Operator Chat is one Rule Run, recorded exactly as an unattended run is. ADR 0137 claims that the interactive and the unattended surface share an engine, and this is what makes the claim structural rather than rhetorical: the Suppression Window of ADR 0141, the mode-dependent tool binding of ADR 0142, and the effect graph of ADR 0134 apply to chat without being written a second time, and there is one history rather than two.

An ad-hoc conversation runs against the Account's whole tool set rather than an Automation's Tool Grant, which makes it the widest execution path in the product. Naming a working conversation's Prompt and tool set and attaching a Trigger is how it becomes an Automation, so the default-deny grant is authored by narrowing something that already worked rather than by filling in a form.

Chat defaults to unattended, because approval mode would stop at every write and make the surface useless for the debugging it exists to support. Individual tools that delete or reach many Contacts at once ask for confirmation instead, so caution is a property of the tool rather than of the run.
