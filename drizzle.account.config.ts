import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './apps/worker/src/storage/account-schema.ts',
  out: './apps/worker/migrations/organization',
});
