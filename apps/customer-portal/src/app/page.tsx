"use client"

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useRouter } from 'next/navigation'
import { ArrowUp } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useAuthStore } from '@/store/auth-store';
import { isCustomerPortalUnavailable } from '@/lib/public-routes';
import { getCustomerPortalStatus } from '@/lib/api/service-status';
import FlashLoader from '@/components/ui/flash-loader';

// Modular Components
import HeroSection from '@/components/shared/hero-section'
import FeatureBar from '@/components/layout/feature-bar'
import StatsShowcase from '@/components/landing/stats-showcase'
import ClickToWhatsAppAds from '@/components/landing/click-to-whatsapp-ads'
import GetStartedWays from '@/components/landing/get-started-ways'
import IndustrySolutions from '@/components/landing/industry-solutions'
import IntegrationLogos from '@/components/landing/integration-logos'
import AutomatedSequence from '@/components/landing/automated-sequence'
import TestimonialSection from '@/components/landing/testimonial-section'
import WhyChooseUs from '@/components/landing/why-choose-us'
import FeatureGrid from '@/components/landing/feature-grid'
import BottomCTA from '@/components/landing/bottom-cta'

export default function HomePage() {
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const { authenticated, loading: authContextLoading, fetchSession, accessRestriction, nextStep, systemStatus } = useAuthStore()

  const [mounted, setMounted] = useState(false)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const [portalUnavailable, setPortalUnavailable] = useState(false)
  const isDark = resolvedTheme === 'dark';

  // Wait until mounted to avoid hydration errors
  useEffect(() => {
    setMounted(true)
    fetchSession()
    getCustomerPortalStatus().then((status) => {
      setPortalUnavailable(status.statusKnown === true && status.available === false)
      if (status.statusKnown === true && status.available === false) router.replace('/maintenance')
    }).catch(() => undefined)
  }, [fetchSession])

  // Auto-redirect authenticated users to dashboard
  useEffect(() => {
    if (mounted && !authContextLoading && authenticated) {
      const target = accessRestriction?.targetPath || nextStep || '/dashboard';
      if (target !== '/') {
        router.push(target);
      }
    }
  }, [accessRestriction, authenticated, authContextLoading, nextStep, router, mounted])

  useEffect(() => {
    if (mounted && !authContextLoading && isCustomerPortalUnavailable(systemStatus)) {
      router.replace('/maintenance');
    }
  }, [authContextLoading, mounted, router, systemStatus])

  // Handle scroll events for "scroll to top" button
  useEffect(() => {
    if (!mounted) return;
    const handleScroll = () => setShowScrollTop(window.scrollY > 300);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [mounted]);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (authContextLoading || !mounted) return <FlashLoader />;

  // Prevent flash while redirecting
  if (portalUnavailable || isCustomerPortalUnavailable(systemStatus)) {
    return null;
  }

  if (authenticated && (accessRestriction?.targetPath || nextStep || '/dashboard') !== '/') {
    return null;
  }

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground transition-colors duration-300">
      <button
        onClick={() => setTheme(isDark ? 'light' : 'dark')}
        className="fixed top-4 right-4 z-50 w-12 h-12 sm:w-14 sm:h-14 rounded-full flex items-center justify-center transition-all duration-300 hover:scale-110 shadow-sm backdrop-blur-md bg-white/80 dark:bg-black/80 border border-border"
        aria-label="Toggle theme"
      >
        {isDark ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6 transition-transform duration-300 text-foreground">
            <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.36 6.36-3.54-3.54M20.5 12.5l-3-3M3.5 12.5l3-3" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6 transition-transform duration-300 text-foreground">
            <path d="M12 2v1M12 20v1M4 12H3M20 12h1M16.5 7.5l-3-3M8.5 16.5l-3 3" />
          </svg>
        )}
      </button>

      <div className="flex-[0.5] flex flex-col justify-center">
        <HeroSection />
      </div>
      <div className="flex-[0.5]">
        <FeatureBar />
      </div>

      <StatsShowcase isDark={isDark} />
      <ClickToWhatsAppAds isDark={isDark} />
      <GetStartedWays isDark={isDark} />
      <IndustrySolutions isDark={isDark} />
      <IntegrationLogos isDark={isDark} />
      <AutomatedSequence isDark={isDark} />
      <TestimonialSection isDark={isDark} />
      <WhyChooseUs isDark={isDark} />
      <FeatureGrid isDark={isDark} />
      <BottomCTA isDark={isDark} />

      {/* Scroll to Top Button */}
      <AnimatePresence>
        {showScrollTop && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            onClick={scrollToTop}
            className="fixed bottom-4 sm:bottom-6 md:bottom-8 right-4 sm:right-6 md:right-8 z-50 w-10 h-10 sm:w-12 sm:h-12 bg-[#25D366] hover:bg-[#1DA851] text-white rounded-full shadow-md hover:shadow-lg transition-all duration-300 flex items-center justify-center group"
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.95 }}
          >
            <ArrowUp className="w-4 h-4 sm:w-5 sm:h-5" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="w-full border-t border-border bg-gray-50 dark:bg-black py-6 mt-8 text-center text-muted-foreground text-sm font-medium">
        &copy; 2026 {process.env.NEXT_PUBLIC_APP_NAME || 'ConnectSphere'}. All rights reserved.
      </footer>
    </div>
  )
}
