import { defineConfig } from 'drizzle-kit';
import { findControlDatabase } from './scripts/find-local-d1.js';

export default defineConfig({
  dialect: 'sqlite',
  schema: './apps/worker/src/storage/control-schema.ts',
  out: './apps/worker/drizzle/control',
  dbCredentials: {
    url: findControlDatabase(),
  },
});
