# Maintain event lifecycle across related messages

Related Source Messages will be classified as Event Changes that create, modify, or cancel one Scheduled Event. Mail Automation correlates Gmail thread context and extracted event identity, updates the existing Calendar event, and notifies the same destinations of meaningful changes instead of creating duplicate events for follow-up messages.
