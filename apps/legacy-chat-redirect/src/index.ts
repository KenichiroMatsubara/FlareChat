interface Bindings {
  CANONICAL_ORIGIN: string;
}

type Fetcher = typeof fetch;

const expiredSessionCookie = 'mail_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';

const legacyApiResponse = (
  request: Request,
  data: unknown,
): Response => {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Set-Cookie': expiredSessionCookie,
  });
  const origin = request.headers.get('Origin');
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Vary', 'Origin');
  }
  return new Response(JSON.stringify({ data }), { status: 200, headers });
};

const revokeLegacySession = async (
  request: Request,
  canonicalOrigin: string,
  fetcher: Fetcher,
): Promise<void> => {
  const cookie = request.headers.get('Cookie');
  if (!cookie?.includes('mail_session=')) return;
  try {
    await fetcher(new URL('/api/auth/logout', canonicalOrigin), {
      method: 'POST',
      headers: { Cookie: cookie },
    });
  } catch {
    // Clearing the legacy host cookie must not depend on upstream availability.
  }
};

export const redirectRequest = async (
  request: Request,
  canonicalOrigin: string,
  fetcher: Fetcher = fetch,
): Promise<Response> => {
  const source = new URL(request.url);
  await revokeLegacySession(request, canonicalOrigin, fetcher);
  if (source.pathname === '/api/bootstrap') {
    return legacyApiResponse(request, { kind: 'signed_out' });
  }
  if (source.pathname === '/api/auth/logout') {
    return legacyApiResponse(request, { loggedOut: true });
  }
  const target = new URL(`${source.pathname}${source.search}`, canonicalOrigin);
  const headers = new Headers({ Location: target.toString() });
  if (request.headers.has('Cookie')) headers.set('Set-Cookie', expiredSessionCookie);
  return new Response(null, { status: 308, headers });
};

export default {
  fetch(request: Request, env: Bindings): Promise<Response> {
    return redirectRequest(request, env.CANONICAL_ORIGIN);
  },
} satisfies ExportedHandler<Bindings>;
