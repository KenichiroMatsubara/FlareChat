# Extract multiple events from one message

A Source Message may yield multiple distinct Event Candidates, each becoming its own Scheduled Event or Event Series when extraction is confident. Matching Automation Rules still merge and deduplicate their recipients and LINE destinations for each candidate; ambiguous event boundaries create an Automation Exception rather than silently combining or dropping events.
