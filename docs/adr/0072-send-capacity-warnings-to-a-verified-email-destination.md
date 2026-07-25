# Send capacity warnings to a verified email destination

Deployment-level Cloudflare capacity warnings are sent through a Cloudflare Email Service binding whose destination is restricted to the verified address `kenmatsu331@gmail.com`.

This delivery path is separate from every Organization's Automation Inbox and Google Connection. A tenant credential is never reused for platform operations, and one Organization's connection failure cannot suppress a deployment-level capacity warning.
