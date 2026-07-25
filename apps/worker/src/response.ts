import type { Context } from 'hono';

export const json = <T>(context: Context, data: T, status: 200 | 201 = 200): Response =>
  context.json({ data }, status);

export const failure = (
  context: Context,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 410 | 500 | 503 = 400,
): Response => context.json({ error: { message } }, status);
