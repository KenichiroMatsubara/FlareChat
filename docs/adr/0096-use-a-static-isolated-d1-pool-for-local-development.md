# Use a static isolated D1 pool for local development

Production continues to provision and bind one Cloudflare D1 database per Organization through the control plane. Local Wrangler development instead declares a bounded pool of local-only Organization D1 bindings and allocates one distinct binding per Organization, because a running local Worker cannot add arbitrary bindings dynamically. Reusing a released local slot clears its Organization data first; Organization credentials never fall back to Control D1, and normal application access remains binding-only in both environments.
