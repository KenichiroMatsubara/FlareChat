# Handle LINE monthly quota exhaustion

Mail Automation monitors usage and limits for every LINE Connection and alerts its Operations Destination List at 80% and 95%. Once a monthly limit is exhausted, LINE attempts stop rather than retrying indefinitely; unanswered registration reminders fall back to Automation Inbox email, while ordinary event notifications remain visibly undelivered in the GUI.
