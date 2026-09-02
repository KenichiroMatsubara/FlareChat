import { cleanup, render, type RenderResult } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type LoaderFunctionArgs } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { api } from '../api';
import { Dashboard, loadAccount } from '../dashboard';
import { screenRoute, type Screen } from '../router';
import { ACCOUNT_ID, ready } from './fixtures';

// Without globals, Testing Library does not unmount between tests on its own.
afterEach(cleanup);

/** Resolves when the test says so, so a control can be observed mid-operation. */
export const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
};

/**
 * Renders one screen inside the Account shell, against the mocked client. The
 * test file mocks `../api` and stubs the endpoints its screen's loader reads.
 */
export const renderScreen = (path: string, screen: Screen, url = `/organizations/${ACCOUNT_ID}/${path}`): RenderResult => {
  vi.mocked(api.bootstrap).mockResolvedValue(ready);
  const router = createMemoryRouter([{
    id: 'account',
    path: '/organizations/:accountId',
    loader: ({ params }: LoaderFunctionArgs) => loadAccount(params.accountId ?? ''),
    element: <Dashboard />,
    children: [screenRoute(path, screen)],
  }], { initialEntries: [url] });
  return render(<RouterProvider router={router} />);
};
