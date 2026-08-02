# Treat unassigned tasks as a normal outcome

Every extraction offers an always-present unassigned Operational Task Role in addition to the Organization's own roles, because real organizations hold work that must be done before anyone owns it. A Task whose role does not match any Organization-defined role is created as unassigned rather than discarded, and the whole extraction is never rejected for it, so one misclassified deadline cannot also suppress the Scheduled Events and Message Summary derived from the same Source Message.
