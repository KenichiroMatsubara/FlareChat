import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import JSON5 from 'json5';

import { cloudflareControlPlane } from '../apps/worker/src/cloudflare';
import { fleetMigration } from '../apps/worker/src/fleet-migration';
import type { Bindings } from '../apps/worker/src/types';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for production fleet migration.`);
  return value;
};

const wrangler = JSON5.parse(readFileSync(
  resolve(import.meta.dirname, '../apps/worker/wrangler.jsonc'),
  'utf8',
)) as {
  name?: string;
  vars?: Record<string, unknown>;
};

const configured = (name: string, fallback: unknown): string => {
  const value = process.env[name]?.trim() || fallback;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is missing from the environment and wrangler.jsonc.`);
  }
  return value.trim();
};

const command = process.argv[2];
if (command !== 'prepare' && command !== 'complete') {
  throw new Error('Use migrate-organization-fleet.ts prepare|complete.');
}

const environment = {
  CLOUDFLARE_ACCOUNT_ID: configured(
    'CLOUDFLARE_ACCOUNT_ID',
    wrangler.vars?.CLOUDFLARE_ACCOUNT_ID,
  ),
  CLOUDFLARE_API_TOKEN: required('CLOUDFLARE_API_TOKEN'),
  CLOUDFLARE_WORKER_NAME: configured('CLOUDFLARE_WORKER_NAME', wrangler.name),
} as unknown as Bindings;
const controlPlane = cloudflareControlPlane(environment);
environment.CONTROL_DB = await controlPlane.openBoundDatabase('CONTROL_DB');

const receipt = command === 'prepare'
  ? await fleetMigration.prepareRelease(environment)
  : await fleetMigration.completeRelease(environment);
process.stdout.write(`${JSON.stringify({ phase: command, ...receipt })}\n`);
