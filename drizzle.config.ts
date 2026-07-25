import { defineConfig } from 'drizzle-kit';
import { findControlDatabase } from './scripts/find-local-d1.js';

export default defineConfig({
  dialect: 'sqlite',
  dbCredentials: {
    url: findControlDatabase(),
  },
});
