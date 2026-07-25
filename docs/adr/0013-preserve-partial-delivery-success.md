# Preserve partial delivery success

External actions succeed or fail per Delivery Attempt rather than as one global transaction. Successful Calendar, Drive-publication, and notification actions remain in place; failed attempts are retried independently and eventually become Automation Exceptions, while LINE completion notifications are never sent before the Calendar event itself exists.
