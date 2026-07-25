# Target Cloudflare's free tier

Superseded by ADR 0084.

Mail Automation must be deployable within Cloudflare's free-tier allowances under its intended small-organization workload. The design therefore avoids paid-only Cloudflare products and monitors free-tier consumption.

This is an operational target rather than a hard spending guarantee. ADR 0071 permits R2 ingestion to continue after warning thresholds, which can produce billable overage if the deployment operator does not intervene.

Google, LINE, and AI providers remain separate Organization-managed services. Their quotas, plans, and possible charges are monitored where their APIs expose sufficient information, but they are not included in the Cloudflare free-tier guarantee.

Turso was added later by ADR 0081. Its overages are disabled under ADR 0083, making its free-plan allowances hard operational limits rather than billable overage.
