# Do not modify the automation inbox

Mail Automation uses `gmail.readonly` for ingestion and `gmail.send` for outbound operational and recipient mail. It stores processing state in the Organization's D1 database rather than adding labels, changing read status, archiving, or otherwise mutating the Automation Inbox. Calendar and Drive retain their separate write scopes, while Gmail avoids the broader `gmail.modify` grant.
