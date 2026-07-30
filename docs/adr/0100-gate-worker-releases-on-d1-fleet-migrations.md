# Gate Worker releases on D1 fleet migrations

Mail Automation treats database schema readiness as a prerequisite for a Worker release rather than as a user-login side effect.

The supported production release command:

1. applies Control D1 migrations;
2. acquires the Organization schema-release barrier;
3. discovers every database recorded by either an Organization or an in-progress Organization provisioning;
4. applies and verifies all missing Organization migrations;
5. deploys the Worker only after the fleet migration succeeds;
6. verifies the fleet again after deployment; and
7. releases the barrier.

Any failure before Worker deployment leaves the previously deployed Worker serving traffic. Any failure after deployment leaves new Organization provisioning paused until the release verification is retried. A different schema target cannot replace a release barrier already in progress.

Schema Lifecycle is the single Module that orders migrations, records checksums, applies each migration transactionally, absorbs concurrent attempts that converge on the same target, and rejects modified migration history. Checked-in Organization migration files and the Worker migration manifest must remain complete and ordered.

Database Access is the runtime seam for Organization D1. HTTP requests, scheduled work, Automation Inbox recovery, and background automation receive a database only after Schema Lifecycle has made it current. This is a repair path for drift and missed fleet entries, not the primary release mechanism. A schema failure occurs before schema-dependent queries and external effects.

New Organization provisioning uses the same Schema Lifecycle implementation and checks the release barrier before allocation and again before activation. Provisioning waits without becoming failed while a schema release is in progress.

Pre-deployment migrations must remain compatible with both the currently deployed Worker and the candidate Worker. Column or table removal, renaming, new uniqueness constraints, and large data rewrites require later contract releases or resumable data Jobs. Migration files are immutable after release; their recorded checksum makes modification a terminal schema error.

This extends ADR 0087 from new-database provisioning to the full Organization database fleet and defines the production guarantee that was previously absent from the deployment command.

The first rollout of this decision is a bootstrap release because the previously deployed Worker does not yet observe the release barrier. Its pre-deployment fleet pass, post-deployment fleet pass, and runtime Database Access repair prevent incompatible queries, but the strict guarantee against an old in-flight provisioning race begins after this barrier-aware Worker is active. Later schema releases use the full barrier protocol from their first step.
