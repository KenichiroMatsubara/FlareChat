import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './apps/worker/src/storage/control-schema.ts',
  out: './apps/worker/migrations/control',
});
