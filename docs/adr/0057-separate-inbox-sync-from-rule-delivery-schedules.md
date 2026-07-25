# Separate inbox sync from rule delivery schedules

The Automation Inbox performs incremental Gmail synchronization every minute, independent of Automation Rule Run Schedules. Matching rules share extracted Event Candidates and Scheduled Events but execute their routing and deliveries once at their own due times; recipient and LINE destination identities deduplicate across runs so a fast rule and a daily rule can coexist without duplicate invitations or notifications.
