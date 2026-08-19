# FlareChat

## Product

This repository contains one product: FlareChat, a Cloudflare-native automation platform for schedules and contacts, with its own administration GUI. An Automation runs on a Trigger, thinks with a Prompt, acts through the tools its Account granted it, and reaches Contacts on built-in Channels. The Gmail-to-Calendar-and-LINE service this began as is one configuration of that platform.

It remains Cloudflare-native and is not a LibreChat port. Do not add MongoDB, Redis, Meilisearch, or Node server dependencies. Only remote HTTP or SSE MCP servers can be reached, because Workers have no child processes.

The rebuild is mid-migration and ADR 0137 fixes its shape: Schema Rules are left alone while Agent Rules are strengthened until Schema Rules are redundant, so both rule types are correct until the first is deleted. ADR 0148 fixes the release order. Read `docs/adr/0137` through `docs/adr/0151` before changing the domain model — they supersede a large amount of what the earlier ADRs say about Organizations, Admins, and Members.

## Architecture

- `apps/worker`: Hono on Cloudflare Workers, D1, Queues, R2, Cron
- `apps/web`: React/Vite administration GUI
- `packages/domain`: shared TypeScript domain contracts
- `docs/adr`: architectural decisions
- `CONTEXT.md`: canonical domain language

All code is strict TypeScript. Prefer flat functions, explicit types, early returns, and single-word file names. Never use `any`.

## Screenshot and URL evidence

Mobile browser address bars may truncate or elide the beginning, middle, or end of a URL. In particular, a visible
`chat.pinara.workers.dev` may be the truncated tail of `flarechat.pinara.workers.dev`; screenshot text alone is not
evidence that a separate host or service exists.

- The canonical production origin for this repository is `https://flarechat.pinara.workers.dev/`.
- When the user provides an exact URL, treat it as authoritative over a cropped or elided screenshot.
- Never create, modify, diagnose, or delete a domain, redirect, compatibility service, or Worker based only on a URL
  fragment visible in a screenshot.
- If no exact URL is provided, verify the complete URL from browser state, deployment configuration, or another
  non-truncated source before acting.

## Commands

- `npm run dev`: run Worker and GUI locally
- `npm run build`: type-check and build all workspaces
- `npm test`: run tests
- `npm run db:local`: apply local Control and Account D1 migrations
- `npm run deploy`: build the GUI and deploy the Worker
