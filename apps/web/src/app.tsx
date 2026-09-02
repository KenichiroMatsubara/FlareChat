import { RouterProvider } from 'react-router-dom';

import { createAppRouter } from './router';

const router = typeof window === 'undefined' ? null : createAppRouter();

export const App = () => router ? <RouterProvider router={router} /> : null;
