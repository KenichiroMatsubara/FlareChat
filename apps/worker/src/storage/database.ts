import { drizzle } from 'drizzle-orm/d1';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as controlSchema from './control-schema';
import * as organizationSchema from './organization-schema';

export type ControlDatabase = DrizzleD1Database<typeof controlSchema>;
export type OrganizationDatabase = DrizzleD1Database<typeof organizationSchema>;

export const controlDatabase = (binding: D1Database): ControlDatabase =>
  drizzle(binding, { schema: controlSchema });

export const organizationDatabase = (binding: D1Database): OrganizationDatabase =>
  drizzle(binding, { schema: organizationSchema });
