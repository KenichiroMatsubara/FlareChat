import { describe, expect, it } from 'vitest';

import { AGENT_TOKEN_CEILING, runReadOnlyAgent } from './agent-runs';
import type { OrganizationDatabase } from './storage/database';

describe('read-only Agent Rule bounds', () => {
  it('aborts a run that exceeds the named token ceiling', async () => {
    await expect(runReadOnlyAgent({
      database: {} as OrganizationDatabase,
      model: { complete: async () => ({
        model: 'test-model',
        content: 'Too large',
        toolCalls: [],
        totalTokens: AGENT_TOKEN_CEILING + 1,
      }) },
      connection: { apiKey: 'test-key', baseUrl: 'https://ai.example.com/v1', model: 'test-model' },
      prompt: 'Read only.',
      source: { id: 'source-1', sender: 'sender@example.com', subject: 'Notice', body: 'Body', attachments: [] },
    })).rejects.toThrow(`Agent Rule token ceiling of ${AGENT_TOKEN_CEILING} was exceeded.`);
  });
});
