export async function getCustomerPortalStatus() {
  const response = await fetch('/api/public/service-status', {
    cache: 'no-store',
  });

  if (!response.ok) return { available: true, statusKnown: false };
  return response.json() as Promise<{
    available: boolean;
    statusKnown?: boolean;
    maintenance?: boolean;
    published?: boolean;
    message?: string;
  }>;
}