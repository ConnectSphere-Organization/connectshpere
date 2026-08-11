"use client";

import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';

export default function GetStartedWays({ isDark }: { isDark: boolean }) {
  const router = useRouter();
  const appName = process.env.NEXT_PUBLIC_APP_NAME || 'ConnectSphere';

  const cards = [
    {
      title: 'Flexible Payment Options',
      desc: 'Monthly or annual plans available. Choose what works best for your business needs.',
      btn: 'Explore Plans →',
      href: '/billing',
      svg: (
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
          <line x1="1" y1="10" x2="23" y2="10" />
        </svg>
      )
    },
    {
      title: `Setup in Minutes`,
      desc: `Get started quickly with our streamlined onboarding process. Save your time with ${appName}.`,
      btn: 'Get Started →',
      href: '/auth/register',
      svg: (
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12,6 12,12 16,14" />
        </svg>
      )
    },
    {
      title: '1-on-1 Expert Support',
      desc: 'Get personalized guidance from our WhatsApp Business specialists to maximize results.',
      btn: 'Talk to Expert →',
      href: '/support',
      svg: (
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      )
    }
  ];

  return (
    <section
      className="w-full py-20 px-4 transition-colors duration-300"
      style={{
        backgroundColor: isDark ? '#000000' : '#ffffff',
        color: isDark ? '#ffffff' : '#000000'
      }}
    >
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="text-3xl sm:text-4xl md:text-5xl font-bold mb-4 transition-colors duration-300"
          >
            <span style={{ color: isDark ? '#ffffff' : '#1a202c' }}>Get started with </span>
            <span className="text-primary">{appName}</span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-lg text-muted-foreground max-w-2xl mx-auto"
          >
            Choose the perfect way to start your WhatsApp Business journey
          </motion.p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {cards.map((card, idx) => (
            <motion.div
              key={idx}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.1 * (idx + 1) }}
              className="group rounded-2xl p-8 flex flex-col items-center text-center transition-all duration-300 hover:scale-105 hover:shadow-2xl cursor-pointer"
              style={{
                backgroundColor: isDark ? '#1a1a1a' : '#f9fafb',
                border: isDark ? '1px solid #333333' : '1px solid #e5e7eb'
              }}
            >
              <div className="w-20 h-20 rounded-2xl flex items-center justify-center mb-6 bg-gradient-to-br from-primary to-primary/80 shadow-premium group-hover:shadow-xl transition-all duration-300">
                {card.svg}
              </div>
              <h3 className="text-2xl font-bold mb-4 transition-colors duration-300" style={{ color: isDark ? '#ffffff' : '#1a202c' }}>
                {card.title}
              </h3>
              <p className="mb-6 flex-1 text-base leading-relaxed transition-colors duration-300" style={{ color: isDark ? '#cccccc' : '#666666' }}>
                {card.desc}
              </p>
              <button
                onClick={() => router.push(card.href)}
                className="px-6 py-3 rounded-xl font-semibold transition-all duration-300 hover:scale-105 text-white bg-gradient-to-r from-primary to-primary/80 shadow-premium hover:shadow-xl"
              >
                {card.btn}
              </button>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
