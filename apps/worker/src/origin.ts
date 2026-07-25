const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);

const originOf = (value: string): string | null => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const isLocalOrigin = (origin: string): boolean => {
  const url = new URL(origin);
  return url.protocol === 'http:' && localHostnames.has(url.hostname);
};

/**
 * In local development Vite can select a free port. In deployed environments,
 * only the configured web origin can become an OAuth redirect target.
 */
export const loginReturnOrigin = (request: Request, appUrl: string, webOrigin: string): string => {
  const configured = originOf(webOrigin) ?? originOf(appUrl);
  if (!configured) throw new Error('A valid application origin is required.');
  const requested = request.headers.get('Origin');
  if (!requested) return configured;
  const origin = originOf(requested);
  if (!origin) return configured;
  if (origin === configured) return origin;
  const appOrigin = originOf(appUrl);
  if (appOrigin && isLocalOrigin(appOrigin) && isLocalOrigin(origin)) return origin;
  return configured;
};
