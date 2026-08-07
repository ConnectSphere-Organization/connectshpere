'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Activity, ArrowLeft, CheckCircle2, CircleDashed, Radio, RefreshCw, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { getCustomerPortalStatus } from '@/lib/api/service-status';
import { useAuthStore } from '@/store/auth-store';

const milestones = [
    { label: 'Systems secured', state: 'complete' },
    { label: 'Updates in progress', state: 'active' },
    { label: 'Back online soon', state: 'pending' },
] as const;

export default function MaintenancePage() {
    const router = useRouter();
    const fetchSession = useAuthStore((state) => state.fetchSession);
    const [time, setTime] = useState('');

    useEffect(() => {
        const updateTime = () => setTime(new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date()));
        updateTime();

        // Only a real browser reload checks whether maintenance has ended. Route
        // navigation into this page must not immediately bounce back to `/`.
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        if (navigation?.type === 'reload') {
            getCustomerPortalStatus()
                .then((status) => {
                    if (status.statusKnown !== true || !status.available) return;

                    // The maintenance route is public, so AuthInitializer intentionally
                    // does not run here. Resolve the session once after a manual reload
                    // and choose the correct destination for this customer.
                    return fetchSession(true).then((session) => {
                        if (!session?.authenticated) {
                            const callbackUrl = `${window.location.pathname}${window.location.search}`;
                            router.replace(`/auth/login?callbackUrl=${encodeURIComponent(callbackUrl || '/')}`);
                            return;
                        }

                        const target = session.accessRestriction?.targetPath || session.nextStep || '/dashboard';
                        router.replace(target);
                    });
                })
                .catch(() => undefined);
        }
    }, [fetchSession, router]);

    return (
        <main className="relative min-h-screen overflow-hidden bg-[#07111f] text-white selection:bg-cyan-300 selection:text-[#07111f]">
            <div className="pointer-events-none absolute inset-0 opacity-70" aria-hidden="true">
                <div className="absolute -left-32 -top-40 h-[32rem] w-[32rem] rounded-full bg-cyan-400/20 blur-3xl" />
                <div className="absolute -bottom-48 -right-20 h-[34rem] w-[34rem] rounded-full bg-amber-300/10 blur-3xl" />
                <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:linear-gradient(to_bottom,black,transparent_80%)]" />
            </div>

            <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-7 sm:px-10 lg:px-16">
                <header className="flex items-center justify-between border-b border-white/10 pb-6">
                    <button onClick={() => router.push('/')} className="group flex items-center gap-3" aria-label="Go to ConnectSphere home">
                        <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-300 text-[#07111f] shadow-[0_0_28px_rgba(103,232,249,0.35)] transition-transform group-hover:rotate-12">
                            <Sparkles className="h-5 w-5" />
                        </span>
                        <span className="text-sm font-semibold tracking-[0.2em] text-white/90">CONNECTSPHERE</span>
                    </button>
                    <span className="hidden items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-white/45 sm:flex">
                        <Radio className="h-3.5 w-3.5 text-cyan-300" /> Platform update
                    </span>
                </header>

                <section className="grid flex-1 items-center gap-14 py-16 lg:grid-cols-[1.08fr_0.92fr] lg:gap-24">
                    <div>
                        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }} className="mb-8 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200">
                            <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-300 shadow-[0_0_16px_#67e8f9]" /> Maintenance mode active
                        </motion.div>
                        <motion.h1 initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.7 }} className="max-w-2xl text-5xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-7xl">
                            We’re tuning the <span className="text-cyan-300">signal.</span>
                        </motion.h1>
                        <motion.p initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.7 }} className="mt-7 max-w-xl text-base leading-8 text-white/60 sm:text-lg">
                            ConnectSphere is temporarily offline while our team applies a platform update. Your workspace and data are safe. We’ll be back shortly with a smoother experience.
                        </motion.p>
                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.45 }} className="mt-10 flex flex-wrap items-center gap-3">
                            <button onClick={() => window.location.reload()} className="inline-flex h-12 items-center gap-2 rounded-xl bg-cyan-300 px-5 text-sm font-semibold text-[#07111f] transition hover:bg-cyan-200 hover:shadow-[0_0_28px_rgba(103,232,249,0.25)]">
                                <RefreshCw className="h-4 w-4" /> Check again
                            </button>
                            <button onClick={() => router.push('/')} className="inline-flex h-12 items-center gap-2 rounded-xl border border-white/15 px-5 text-sm font-medium text-white/75 transition hover:border-white/30 hover:bg-white/5">
                                <ArrowLeft className="h-4 w-4" /> Return home
                            </button>
                        </motion.div>
                    </div>

                    <motion.aside initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25, duration: 0.7 }} className="relative rounded-[2rem] border border-white/10 bg-white/[0.055] p-6 shadow-2xl backdrop-blur-xl sm:p-8">
                        <div className="mb-8 flex items-start justify-between">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/40">Live status</p>
                                <p className="mt-2 text-2xl font-medium tracking-tight">Platform maintenance</p>
                            </div>
                            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-300/10 text-amber-200"><Activity className="h-5 w-5" /></div>
                        </div>
                        <div className="space-y-5">
                            {milestones.map((milestone, index) => (
                                <div key={milestone.label} className="flex items-center gap-4">
                                    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${milestone.state === 'complete' ? 'bg-cyan-300 text-[#07111f]' : milestone.state === 'active' ? 'border border-amber-200/50 bg-amber-200/10 text-amber-200' : 'border border-white/15 text-white/25'}`}>
                                        {milestone.state === 'complete' ? <CheckCircle2 className="h-4 w-4" /> : milestone.state === 'active' ? <CircleDashed className="h-4 w-4 animate-spin" /> : <span className="text-xs">{index + 1}</span>}
                                    </div>
                                    <div className="flex-1 border-b border-white/10 pb-5 text-sm text-white/75 last:border-0">{milestone.label}</div>
                                </div>
                            ))}
                        </div>
                        <div className="mt-3 flex items-center justify-between rounded-xl bg-black/20 px-4 py-3 text-xs text-white/45">
                            <span>Last checked</span><span className="font-mono text-white/70">{time || '—'}</span>
                        </div>
                    </motion.aside>
                </section>

                <footer className="flex flex-col gap-2 border-t border-white/10 pt-6 text-xs text-white/35 sm:flex-row sm:items-center sm:justify-between">
                    <span>© {new Date().getFullYear()} ConnectSphere</span>
                    <span>Need help? Contact your workspace administrator.</span>
                </footer>
            </div>
        </main>
    );
}