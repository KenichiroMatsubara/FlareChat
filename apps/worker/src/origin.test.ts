import { describe, expect, it } from 'vitest';

import { loginReturnOrigin } from './origin';

describe('Google login return origin', () => {
  it('keeps the dynamically selected local Vite port', () => {
    const request = new Request('http://localhost:8787/api/auth/google', { headers: { Origin: 'http://localhost:5174' } });
    expect(loginReturnOrigin(request, 'http://localhost:8787', 'http://localhost:5173')).toBe('http://localhost:5174');
  });

  it('does not allow a production callback to become an open redirect', () => {
    const request = new Request('https://worker.example/api/auth/google', { headers: { Origin: 'https://attacker.example' } });
    expect(loginReturnOrigin(request, 'https://worker.example', 'https://app.example')).toBe('https://app.example');
  });
});
