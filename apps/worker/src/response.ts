import type { Context } from 'hono';

export const json = <T>(context: Context, data: T, status: 200 | 201 = 200): Response =>
  context.json({ data }, status);

export const failure = (
  context: Context,
  message: string,
  status: 400 | 404 | 409 | 500 = 400,
): Response => context.json({ error: { message } }, status);
