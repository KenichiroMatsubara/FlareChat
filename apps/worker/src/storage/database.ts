import { drizzle } from 'drizzle-orm/d1';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as controlSchema from './control-schema';
import * as accountSchema from './account-schema';

export type ControlDatabase = DrizzleD1Database<typeof controlSchema>;
export type AccountDatabase = DrizzleD1Database<typeof accountSchema>;

export const controlDatabase = (binding: D1Database): ControlDatabase =>
  drizzle(binding, { schema: controlSchema });

export const accountDatabase = (binding: D1Database): AccountDatabase =>
  drizzle(binding, { schema: accountSchema });
