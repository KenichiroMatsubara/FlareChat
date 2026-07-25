# Warn at six and ten dollars

Mail Automation estimates aggregate Cloudflare charges from available Workers, D1, Queues, R2, Containers, and related usage metrics. It sends a deployment-level warning to `kenmatsu331@gmail.com` when the projected monthly total first reaches USD 6 and again when it reaches USD 10.

Each threshold fires once per Cloudflare billing period and resets for the next period. The estimate is explicitly labeled as approximate and does not replace Cloudflare's invoice. Reaching either threshold does not automatically suspend processing or delete data.
