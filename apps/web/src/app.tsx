import { RouterProvider } from 'react-router-dom';

import { createAppRouter } from './router';

export { defaultAccountName, setupPhaseLabel, shouldShowAccountLoading, SignedOutEntry } from './entry';

const router = typeof window === 'undefined' ? null : createAppRouter();

export const App = () => router ? <RouterProvider router={router} /> : null;
