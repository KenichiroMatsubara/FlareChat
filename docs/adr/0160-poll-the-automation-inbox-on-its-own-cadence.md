# Poll the Automation Inbox on its own cadence

The Worker wakes on two crons. `*/30 * * * *` runs the work that is late the moment its stated time passes — provisioning retries, attendance and Task reminders, due Jobs, and the Automations whose Trigger carries no payload. `0 */3 * * *` reads each Automation Inbox for new Source Messages.

One cadence had to serve both, and the mailbox was the reason it was frequent. Mail that arrived an hour ago is not late in the way a reminder due at 09:00 is: a Source Message becomes a Calendar event and a notice, and both are read hours later by whoever the notice reached. Every poll, meanwhile, costs a Gmail history request per Account whether or not anything arrived, so the frequent tick spent its requests mostly discovering that nothing had.

Slowing the single cron instead would have taken the reminders with it. A `daily 08:00` Automation would fire at 09:00, a reminder an outside agent scheduled for a stated instant would arrive up to three hours after it, and a failed provisioning retry would keep an installer waiting through the same gap. Those are the cases the frequent tick exists for.

`runBackgroundWork` therefore reads which cron woke it. A wake-up naming neither cadence — a local trigger, or a test — stands for both, so a caller that does not know the schedule skips nothing silently. The two constants live beside the runner and `deployment-contract.test.ts` asserts that `wrangler.jsonc` declares exactly them, because a cron the code reads and a cron the deployment fires are the same decision written twice.

## Consequences

A Source Message is now seen up to three hours after it arrives, and its notice, its Scheduled Events, and its Tasks follow from that. An Account that needs a mail acted on sooner has the Mailbox Test to run one by hand.

Each poll carries up to three hours of mail instead of thirty minutes of it. Gmail's history window is measured in days, so the cursor stays inside it, and the poll already pages through everything the window holds rather than capping a run. A burst arriving in one window makes one invocation do more work — more Gmail, AI, Calendar, and Drive requests inside a single scheduled run — which is well within a Worker invocation's limits at the intended small-Account workload but is the number to watch if a much busier mailbox is ever onboarded.

The two crons coincide every three hours. Cloudflare delivers them as two separate invocations, each naming its own expression, so the poll and the due work never run as one.
