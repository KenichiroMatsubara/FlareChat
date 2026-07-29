# Mail Automation

## Product

This repository contains one product: a Cloudflare-native Gmail-to-Calendar and LINE automation service with its own administration GUI. It is not a LibreChat fork and must not add chat, MongoDB, Redis, Meilisearch, or Node server dependencies.

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
- `npm run db:local`: apply local Control and Organization D1 migrations
- `npm run deploy`: build the GUI and deploy the Worker
