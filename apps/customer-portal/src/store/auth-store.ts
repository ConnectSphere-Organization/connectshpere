import { create } from 'zustand';
import { getSessionData, logoutUser } from '@/lib/api/auth';

const clearAuthCookie = () => {
    if (typeof document !== 'undefined') {
        document.cookie = 'auth_token=; path=/; max-age=0; SameSite=Lax';
    }
    if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem('socket_auth_token');
    }
}

const STARTER_PLAN_FALLBACK = {
    name: 'Starter (Standard)',
    slug: 'starter',
    features: [
        'MESSAGING', 'CONTACTS', 'BILLING', 'STATS_TOTAL_CONTACTS', 'STATS_MESSAGES_SENT'
    ],
    limits: {
        maxContacts: 1000,
        maxMessagesPerMonth: 5000,
        maxAutomations: 5
    }
};

interface AuthState {
    user: any;
    workspace: any;
    stage1Complete: boolean;
    phoneStatus: string;
    phone: {
        number: string | null;
        verified: boolean;
    };
    loading: boolean;
    authenticated: boolean;
    nextStep: string | null;
    accessRestriction: {
        kind: 'onboarding' | 'billing';
        title: string;
        description: string;
        targetPath: string;
        actionLabel: string;
    } | null;
    wallet: {
        balance: number;
        thresholdAmount: number;
        currency: string;
        isServiceDown?: boolean;
    };
    permissions: any;
    canCreateTemplates: boolean;
    canCreateCampaigns: boolean;
    canSendMessages: boolean;
    canManageTeam: boolean;
    canViewBilling: boolean;
    canAccessAdmin: boolean;
    systemStatus: {
        maintenanceMode: boolean;
        systemNotice: {
            message: string;
            level: 'info' | 'warning' | 'critical';
            active: boolean;
        } | null;
        features?: {
            serviceControls?: Record<string, {
                published?: boolean;
                customerVisible?: boolean;
                maintenance?: boolean;
                message?: string;
            }>;
            [key: string]: any;
        };
    };
    isImpersonating: boolean;
    inFlightPromise: Promise<any> | null;
    cachedSession: any | null;
    lastSessionFetchedAt: number;
    fetchSession: (force?: boolean) => Promise<any>;
    logout: () => void;
    stopImpersonating: () => Promise<void>;
    getRole: () => string;
    getTrialDaysLeft: () => number | null;
    getIsOnTrial: () => boolean;
    isSuperAdmin: () => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
    user: null,
    workspace: null,
    stage1Complete: false,
    phoneStatus: 'NOT_CONNECTED',
    phone: {
        number: null,
        verified: false
    },
    loading: true,
    authenticated: false,
    nextStep: null,
    accessRestriction: null,
    wallet: {
        balance: 0,
        thresholdAmount: 500,
        currency: 'INR'
    },
    permissions: null,
    canCreateTemplates: false,
    canCreateCampaigns: false,
    canSendMessages: false,
    canManageTeam: false,
    canViewBilling: false,
    canAccessAdmin: false,
    systemStatus: {
        maintenanceMode: false,
        systemNotice: null,
        features: {}
    },
    isImpersonating: false,
    inFlightPromise: null,
    cachedSession: null,
    lastSessionFetchedAt: 0,

    getRole: () => get().user?.role || 'viewer',

    getTrialDaysLeft: () => {
        const user = get().user;
        return user?.trialEndsAt
            ? Math.max(0, Math.ceil((new Date(user.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
            : null;
    },

    getIsOnTrial: () => {
        const user = get().user;
        const days = get().getTrialDaysLeft();
        return user?.plan?.slug === 'trial' || (days !== null && days > 0);
    },

    isSuperAdmin: () => get().user?.role === 'super_admin',

    fetchSession: async (force = false) => {
        const { inFlightPromise, cachedSession, lastSessionFetchedAt, authenticated } = get();
        if (inFlightPromise) return inFlightPromise;
        if (!force && authenticated && cachedSession && Date.now() - lastSessionFetchedAt < 60 * 1000) {
            return cachedSession;
        }

        const doFetch = async () => {
            try {
                const sessionData: any = await getSessionData();

                if (!sessionData || !sessionData.authenticated) {
                    clearAuthCookie();
                    set({
                        user: null,
                        workspace: null,
                        loading: false,
                        inFlightPromise: null,
                        authenticated: false,
                        accessRestriction: null,
                        cachedSession: null,
                        lastSessionFetchedAt: 0,
                        phone: { number: null, verified: false }
                    });
                    return null;
                }

                // Store token from session for Socket.io access
                if (sessionData.token && typeof sessionStorage !== 'undefined') {
                    try {
                        sessionStorage.setItem('socket_auth_token', sessionData.token);
                        console.log('[AuthStore] ✓ Token stored in sessionStorage');
                    } catch (err) {
                        console.warn('[AuthStore] Could not store token in sessionStorage:', err);
                    }
                }

                const { user: userData, workspace: userWorkspace, phone: phoneData, permissions: userPerms } = sessionData;
                const role = userData.role || 'viewer';
                const stage1Complete = userWorkspace?.stage1?.complete || false;
                const accessRestriction = sessionData.accessRestriction || null;

                let activePlan = userWorkspace?.plan || userData.plan;
                if (!activePlan || (typeof activePlan === 'string' && activePlan === 'free') || !activePlan.features) {
                    activePlan = STARTER_PLAN_FALLBACK;
                }

                set({
                    user: {
                        ...userData,
                        role,
                        plan: activePlan,
                    },
                    workspace: userWorkspace ? {
                        ...userWorkspace,
                        id: userWorkspace.id || userWorkspace._id,
                    } : null,
                    stage1Complete,
                    phoneStatus: userWorkspace?.stage1?.phoneStatus || 'NOT_CONNECTED',
                    phone: {
                        number: phoneData?.number || null,
                        verified: !!phoneData?.verified
                    },
                    authenticated: true,
                    nextStep: sessionData.nextStep,
                    accessRestriction,
                    permissions: userPerms,
                    wallet: userWorkspace?.wallet || { balance: 0, thresholdAmount: 500, currency: 'INR' },

                    canCreateTemplates: stage1Complete && (userPerms?.createTemplates ?? ['owner', 'manager', 'admin'].includes(role)),
                    canCreateCampaigns: stage1Complete && (userPerms?.createCampaigns ?? ['owner', 'manager', 'admin'].includes(role)),
                    canSendMessages: stage1Complete && (userPerms?.sendMessages ?? ['owner', 'manager', 'agent', 'admin'].includes(role)),
                    canManageTeam: userPerms?.manageTeam ?? ['owner', 'manager', 'admin'].includes(role),
                    canViewBilling: (userPerms?.manageBilling || userPerms?.billing?.view) ?? ['owner', 'admin'].includes(role),
                    canAccessAdmin: role === 'super_admin',
                    systemStatus: sessionData.systemStatus || { maintenanceMode: false, systemNotice: null, features: {} },
                    isImpersonating: !!sessionData.isImpersonating,
                    cachedSession: sessionData,
                    lastSessionFetchedAt: Date.now()
                });
                return sessionData;
            } catch (err: any) {
                const status = err?.response?.status || err?.status;
                if (status === 503 && err?.response?.data?.error === 'MAINTENANCE_MODE') {
                    set({ loading: false, inFlightPromise: null });
                    throw err;
                }
                if (status !== 401 && status !== 402) {
                    console.error('[AuthStore] Session fetch failed:', err);
                }
                clearAuthCookie();
                set({
                    user: null,
                    workspace: null,
                    stage1Complete: false,
                    authenticated: false,
                    isImpersonating: false,
                    accessRestriction: null,
                    permissions: null,
                    cachedSession: null,
                    lastSessionFetchedAt: 0,
                    phone: { number: null, verified: false }
                });
                return null;
            } finally {
                set({ loading: false, inFlightPromise: null });
            }
        };

        const promise = doFetch();
        set({ inFlightPromise: promise });
        return promise;
    },

    logout: () => {
        clearAuthCookie();
        // Tear down the shared socket so the next user doesn't inherit the
        // previous user's rooms or auth token.
        try {
            // Lazy import to avoid pulling socket.io into the auth store
            // bundle on cold paths that never authenticate.
            import('@/hooks/use-socket').then(mod => mod.disconnectGlobalSocket?.()).catch(() => { });
        } catch { }
        set({
            user: null,
            workspace: null,
            stage1Complete: false,
            authenticated: false,
            accessRestriction: null,
            isImpersonating: false,
            cachedSession: null,
            lastSessionFetchedAt: 0
        });
        logoutUser()
            .catch(() => { })
            .finally(() => {
                if (typeof window !== 'undefined') {
                    window.location.href = '/auth/login';
                }
            });
    },

    stopImpersonating: async () => {
        // Impersonation is started from the separate admin portal, which hands the
        // operator an impersonated auth_token for the customer app. Terminating it
        // here just clears that session and returns the operator to the admin portal.
        try {
            await logoutUser().catch(() => { });
        } finally {
            clearAuthCookie();
            set({
                user: null,
                workspace: null,
                authenticated: false,
                isImpersonating: false,
                accessRestriction: null,
                cachedSession: null,
                lastSessionFetchedAt: 0,
            });
            if (typeof window !== 'undefined') {
                const adminUrl = process.env.NEXT_PUBLIC_ADMIN_PORTAL_URL || 'http://localhost:3100';
                window.location.href = `${adminUrl}/workspaces`;
            }
        }
    }
}));

/**
 * Feature Gating Hook (Ported from Legacy)
 */
export function useFeatureGate(feature: string) {
    const store = useAuthStore();
    const userPlan = store.user?.plan;
    const features = userPlan?.features || [];

    const getMappedFeatureKey = (f: string) => {
        const map: Record<string, string> = {
            'campaigns': 'CAMPAIGNS',
            'commerce': 'COMMERCE',
            'whatsform': 'WA_FORMS',
            'whatsapp-forms': 'WA_FORMS',
            'analytics': 'ANALYTICS',
            'automation': 'AUTOMATION',
            'crm': 'CRM',
            'answerbot': 'ANSWERBOT',
            'templates-library': 'TEMPLATES_LIBRARY',
            'flow-hub': 'FLOW_HUB',
            'workflows': 'WORKFLOWS',
            'auto-replies': 'AUTO_REPLIES',
            'ai-intent-matching': 'AI_INTENT',
            'interaktive-list': 'INTERAKTIVE_LIST',
            'pipeline': 'PIPELINE',
            'tasks': 'TASKS',
            'reports': 'REPORTS',
            'catalog': 'CATALOG',
            'orders': 'ORDERS',
            'checkout-bot': 'CHECKOUT_BOT',
            'commerce-settings': 'COMMERCE_SETTINGS',
            'chat-assignment': 'CHAT_ASSIGNMENT',
            'team-management': 'TEAM_MGMT',
            'macros': 'MACROS',
            'integrations': 'INTEGRATIONS',
            'widget-config': 'WIDGET_CONFIG',
            'stats-total-contacts': 'STATS_TOTAL_CONTACTS',
            'stats-messages-sent': 'STATS_MESSAGES_SENT',
            'stats-delivery-rate': 'STATS_DELIVERY_RATE',
            'stats-open-rate': 'STATS_OPEN_RATE'
        };
        const normalized = f.toLowerCase().replace(/-/g, '_');
        return map[normalized] || normalized.toUpperCase();
    };

    const featureKey = getMappedFeatureKey(feature);
    const hasPlanAccess = features.includes(featureKey) || features.includes('ALL');
    const serviceControls = store.systemStatus?.features?.serviceControls || {};
    const serviceLabels: Record<string, string> = {
        auth: 'Sign in',
        chat: 'Inbox',
        contact: 'Contacts',
        billing: 'Billing',
        campaign: 'Campaigns',
        automation: 'Automation',
        bsp: 'WhatsApp connection',
        ingestor: 'Webhooks',
    };
    const featureServices: Record<string, string[]> = {
        analytics: ['chat', 'campaign'],
        crm: ['contact'],
        automation: ['automation'],
        commerce: ['billing'],
        inbox: ['chat', 'websocket'],
        contacts: ['contact'],
        templates: ['campaign', 'bsp'],
        campaigns: ['campaign'],
        messaging: ['chat', 'bsp'],
        team: ['auth'],
        billing: ['billing'],
    };
    const blockedService = (featureServices[feature.toLowerCase()] || []).find((serviceId) => {
        const control = serviceControls[serviceId];
        return control?.published === false || control?.maintenance === true;
    });

    const gates: Record<string, { allowed: boolean; reason?: string }> = {
        analytics: {
            allowed: hasPlanAccess || features.includes('ANALYTICS'),
            reason: !hasPlanAccess ? 'Upgrade your plan to unlock analytics' : undefined
        },
        crm: {
            allowed: hasPlanAccess || features.includes('CRM'),
            reason: !hasPlanAccess ? 'Upgrade your plan to unlock Sales CRM' : undefined
        },
        automation: {
            allowed: hasPlanAccess || features.includes('AUTOMATION'),
            reason: !hasPlanAccess ? 'Upgrade your plan to unlock advanced automation' : undefined
        },
        commerce: {
            allowed: hasPlanAccess || features.includes('COMMERCE'),
            reason: !hasPlanAccess ? 'Upgrade your plan to unlock WhatsApp Commerce' : undefined
        },
        inbox: {
            allowed: store.stage1Complete && (hasPlanAccess || features.includes('INBOX')),
            reason: !store.stage1Complete
                ? 'Connect your WhatsApp number to use the Shared Inbox'
                : !hasPlanAccess ? 'Upgrade your plan to unlock the Shared Inbox' : undefined
        },
        contacts: {
            allowed: hasPlanAccess || features.includes('CONTACTS'),
            reason: !hasPlanAccess ? 'Upgrade your plan to unlock Contact Management' : undefined
        },
        templates: {
            allowed: store.canCreateTemplates && (hasPlanAccess || features.includes('TEMPLATES') || features.includes('BULK_CAMPAIGN')),
            reason: !store.stage1Complete
                ? 'Connect your WhatsApp number to create templates'
                : !hasPlanAccess && !features.includes('BULK_CAMPAIGN')
                    ? 'Upgrade required for advanced templates'
                    : !store.canCreateTemplates
                        ? 'You do not have permission to create templates'
                        : undefined
        },
        campaigns: {
            allowed: store.canCreateCampaigns && (hasPlanAccess || features.includes('BULK_CAMPAIGN')),
            reason: !store.stage1Complete
                ? 'Connect your WhatsApp number to create campaigns'
                : !hasPlanAccess && !features.includes('BULK_CAMPAIGN')
                    ? 'Upgrade required for advanced campaigns'
                    : !store.canCreateCampaigns
                        ? 'You do not have permission to create campaigns'
                        : undefined
        },
        messaging: {
            allowed: store.canSendMessages,
            reason: !store.stage1Complete
                ? 'Connect your WhatsApp number to send messages'
                : !store.canSendMessages
                    ? 'You do not have permission to send messages'
                    : undefined
        },
        team: {
            allowed: store.canManageTeam && (hasPlanAccess || features.includes('TEAM')),
            reason: !store.canManageTeam
                ? 'You do not have permission to manage team'
                : !hasPlanAccess && !features.includes('TEAM')
                    ? 'Upgrade your plan to unlock Team Management'
                    : undefined
        },
        billing: {
            allowed: store.canViewBilling,
            reason: !store.canViewBilling
                ? 'Only the workspace Owner or Admin can access billing'
                : undefined
        },
        admin: {
            allowed: store.canAccessAdmin,
            reason: !store.canAccessAdmin
                ? 'Only the workspace Owner or Admin can access admin settings'
                : undefined
        }
    };

    const baseGate = gates[feature.toLowerCase()] || {
        allowed: hasPlanAccess,
        reason: !hasPlanAccess ? `Upgrade your plan to unlock ${feature}` : undefined
    };

    const gate = store.isSuperAdmin()
        ? { allowed: true, reason: undefined }
        : blockedService
            ? {
                allowed: false,
                reason: `${serviceLabels[blockedService] || blockedService} is temporarily unavailable`
            }
            : baseGate;

    return {
        ...store,
        gate,
        isPlanLocked: store.isSuperAdmin() ? false : !hasPlanAccess
    };
}// Re-triggering build
