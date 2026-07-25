# Warn but do not stop R2 ingestion

When estimated R2 monthly storage reaches 80% and 95% of the included free allowance, Mail Automation sends one warning for that threshold to the deployment operator at `kenmatsu331@gmail.com`. A warning threshold becomes eligible to fire again only after usage has fallen sufficiently below it.

Mail Automation does not automatically stop inbox processing, reject new Source Snapshots, or delete existing snapshots at either threshold. The deployment operator accepts that ignored warnings may allow billable R2 overage. This deliberately makes the approximate monthly cost an operational target rather than a guaranteed spending cap.
