'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { isCustomerPortalUnavailable, isPublicCustomerRoute } from '@/lib/public-routes';
import { getCustomerPortalStatus } from '@/lib/api/service-status';

export function AuthInitializer() {
    const pathname = usePathname();
    const router = useRouter();
    const { fetchSession, authenticated, loading, nextStep, user, accessRestriction } = useAuthStore();
    const isPublicRoute = isPublicCustomerRoute(pathname);

    useEffect(() => {
        let active = true;

        // The maintenance page must be reachable while the portal is down,
        // but every other public entry point still needs to be protected.
        // This covers `/`, `/auth/login`, and `/auth/register` before login.
        if (pathname === '/maintenance') return () => {
            active = false;
        };

        const checkPortalAvailability = async () => {
            try {
                const status = await getCustomerPortalStatus();
                if (active && status.statusKnown === true && status.available === false) {
                    router.replace('/maintenance');
                }
            } catch {
                // Do not block entry when the status dependency is unavailable.
            }
        };

        if (isPublicRoute) {
            checkPortalAvailability();
            return () => {
                active = false;
            };
        }

        const redirectToLogin = () => {
            if (!active || typeof window === 'undefined') return;
            const callbackUrl = `${window.location.pathname}${window.location.search}`;
            router.replace(`/auth/login?callbackUrl=${encodeURIComponent(callbackUrl || '/')}`);
        };

        const loadSession = async (force = false) => {
            let session;
            try {
                session = await fetchSession(force);
            } catch (error: any) {
                if (error?.response?.status === 503 && error?.response?.data?.error === 'MAINTENANCE_MODE') {
                    router.replace('/maintenance');
                    return;
                }
                throw error;
            }
            if (session && isCustomerPortalUnavailable(session.systemStatus)) {
                router.replace('/maintenance');
                return;
            }
            if (!session?.authenticated) {
                redirectToLogin();
            }
        };

        loadSession();

        checkPortalAvailability();

        const handleAuthChange = () => {
            loadSession(true);
        };
        window.addEventListener('storage', handleAuthChange);
        window.addEventListener('authChange', handleAuthChange);
        return () => {
            active = false;
            window.removeEventListener('storage', handleAuthChange);
            window.removeEventListener('authChange', handleAuthChange);
        };
    }, [fetchSession, isPublicRoute, router]);

    useEffect(() => {
        if (loading || !authenticated || !user || isPublicRoute) return;

        const currentPath = pathname.split('?')[0];
        const targetPath = (accessRestriction?.targetPath || nextStep || '').split('?')[0] || null;

        if (user.accountStatus === 'SIGNUP_COMPLETED') {
            if (currentPath.startsWith('/onboarding') && !targetPath) {
                router.replace('/');
            }
        }

        if (!targetPath) return;

        if (currentPath.startsWith('/') && targetPath.startsWith('/') && currentPath === targetPath) return;
        if (currentPath.startsWith('/onboarding') && targetPath.startsWith('/onboarding') && currentPath === targetPath) return;
        if (currentPath.startsWith('/dashboard') && targetPath === '/dashboard') return;
        if (currentPath === targetPath) return;

        router.replace(targetPath);
    }, [pathname, nextStep, authenticated, user, accessRestriction, loading, router]);

    return null;
}
