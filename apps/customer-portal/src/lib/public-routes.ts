const PUBLIC_ENTRY_ROUTES = new Set([
  '/',
  '/auth/login',
  '/auth/register',
  '/privacy',
  '/terms',
  '/maintenance',
]);

const AUTH_FLOW_ROUTES = new Set([
  '/auth/accept-invite',
  '/auth/google/callback',
  '/auth/register/verify',
  '/auth/reset',
]);

export function normalizeRoutePath(pathname: string | null | undefined) {
  if (!pathname) return '/';
  if (pathname === '/') return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

export function isPublicEntryRoute(pathname: string | null | undefined) {
  return PUBLIC_ENTRY_ROUTES.has(normalizeRoutePath(pathname));
}

export function isPublicCustomerRoute(pathname: string | null | undefined) {
  const route = normalizeRoutePath(pathname);
  return PUBLIC_ENTRY_ROUTES.has(route) || AUTH_FLOW_ROUTES.has(route);
}

export function isAuthEntryRoute(pathname: string | null | undefined) {
  const route = normalizeRoutePath(pathname);
  return route === '/auth/login' || route === '/auth/register';
}

export function isCustomerPortalUnavailable(systemStatus: unknown) {
  const control = (systemStatus as { features?: { serviceControls?: Record<string, { published?: boolean; maintenance?: boolean }> } } | null)
    ?.features?.serviceControls?.['customer-portal'];
  return control?.published === false || control?.maintenance === true;
}
