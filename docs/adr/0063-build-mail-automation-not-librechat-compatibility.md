---
status: superseded by ADR-0137
---

# Build mail automation rather than LibreChat compatibility

The Cloudflare-native product is Mail Automation, not a feature-complete port of LibreChat or FlareChat. Existing code, concepts, and UI may be reused where they directly support Gmail ingestion, AI extraction, Calendar and Drive publication, recipient registration, LINE delivery, or operations, while unrelated chat, Agents, MCP, RAG, and administration compatibility is outside scope.
