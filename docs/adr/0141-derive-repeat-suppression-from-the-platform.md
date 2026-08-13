# Derive repeat suppression from the platform

Because ADR 0140 leaves a scheduled run with no Source Message, the idempotency key ADR 0134 gives every Rule Effect loses the material it was built from. A run that observes an unchanged world reaches the same conclusion every morning and notifies the same people again, which is this product's worst failure.

The platform therefore derives the key itself, from the Automation, the tool, the normalised arguments, and a suppression window declared per Automation and overridable per tool. A repeat inside the window is suppressed. The model is neither asked to supply a key nor trusted to consult its own history first, because that would make repeat suppression a property of the prompt; ADR 0010's Delivery Record already holds the evidence the check needs.
