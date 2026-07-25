# Dispatch rule schedules from D1

Superseded by ADR 0081.

A single Cloudflare Cron Trigger will run every minute and dispatch only Automation Rules whose D1-backed Run Schedule is due. Run Schedules remain editable in the GUI without redeploying Worker cron configuration, and Gmail processing uses incremental history synchronization with full synchronization only for initialization or expired history.
