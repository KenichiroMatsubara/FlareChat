interface Bindings {
  CANONICAL_ORIGIN: string;
}

export const redirectRequest = (
  request: Request,
  canonicalOrigin: string,
): Response => {
  const source = new URL(request.url);
  const target = new URL(`${source.pathname}${source.search}`, canonicalOrigin);
  return Response.redirect(target.toString(), 308);
};

export default {
  fetch(request: Request, env: Bindings): Response {
    return redirectRequest(request, env.CANONICAL_ORIGIN);
  },
} satisfies ExportedHandler<Bindings>;
