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

## Commands

- `npm run dev`: run Worker and GUI locally
- `npm run build`: type-check and build all workspaces
- `npm test`: run tests
- `npm run db:local`: apply local Control and Organization D1 migrations
- `npm run deploy`: build the GUI and deploy the Worker
