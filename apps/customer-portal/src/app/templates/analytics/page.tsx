"use client";

import React, { useState, useEffect } from 'react';
import { BarChart4, TrendingUp, Send, MessageSquare, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

// API imports
import {
  getWorkspaceAnalytics,
  getTopPerformingTemplates,
  getLowPerformingTemplates,
  getTemplateBehavioralInsights
} from '@/lib/api/templates';

import TemplateAnalyticsChart from '@/components/dashboard/templates/template-analytics-chart';
import EngagementHeatmap from '@/components/dashboard/templates/engagement-heatmap';
import QualityScoreBadge from '@/components/dashboard/templates/quality-score-badge';

export default function TemplateAnalyticsPage() {
  const [analytics, setAnalytics] = useState<any>(null);
  const [topPerformers, setTopPerformers] = useState<any[]>([]);
  const [lowPerformers, setLowPerformers] = useState<any[]>([]);
  const [behavioralData, setBehavioralData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState('30'); // 30 days

  async function loadAnalytics() {
    try {
      setLoading(true);
      const days = parseInt(dateRange);
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

      const [analyticsData, topData, lowData, behaviorResult] = await Promise.all([
        getWorkspaceAnalytics({ startDate, endDate }),
        getTopPerformingTemplates(10),
        getLowPerformingTemplates(10),
        getTemplateBehavioralInsights({ days })
      ]);

      setAnalytics(analyticsData.analytics || {});
      setTopPerformers(topData.templates || []);
      setLowPerformers(lowData.templates || []);
      setBehavioralData(behaviorResult.data || null);
    } catch (error) {
      console.error('Failed to load analytics:', error);
      toast.error('Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAnalytics();
  }, [dateRange]);

  const handleExport = () => {
    toast.info('Analytics export is not available yet. No report was created.');
  };

  if (loading) {
    return (
      <div className="p-6 max-w-7xl mx-auto flex items-center justify-center min-h-[500px]">
        <div className="flex flex-col items-center gap-4 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p>Loading analytics data...</p>
        </div>
      </div>
    );
  }

  // Prepare chart data
  const messagesTrendData = analytics?.messagesTrend || [];
  const qualityDistributionData = [
    { name: 'Green', value: analytics?.qualityBreakdown?.GREEN || 0 },
    { name: 'Yellow', value: analytics?.qualityBreakdown?.YELLOW || 0 },
    { name: 'Red', value: analytics?.qualityBreakdown?.RED || 0 }
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
              <BarChart4 size={24} className="text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">Template Analytics</h1>
              <p className="text-slate-600 dark:text-slate-400">Workspace-wide performance metrics</p>
            </div>
          </div>
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Download size={18} />
            Export Report
          </button>
        </div>

        {/* Date Range */}
        <div className="flex gap-2">
          {['7', '30', '90'].map(days => (
            <button
              key={days}
              onClick={() => setDateRange(days)}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                dateRange === days
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700'
              }`}
            >
              Last {days} days
            </button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      {analytics?.summary && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
          <SummaryCard
            title="Total Templates"
            value={analytics.summary.totalTemplates}
            icon={<MessageSquare size={20} />}
            color="blue"
          />
          <SummaryCard
            title="Messages Sent"
            value={analytics.summary.totalMessages?.toLocaleString()}
            icon={<Send size={20} />}
            color="green"
          />
          <SummaryCard
            title="Delivery Rate"
            value={`${analytics.summary.deliveryRate?.toFixed(1)}%`}
            icon={<TrendingUp size={20} />}
            color="purple"
          />
          <SummaryCard
            title="Approved"
            value={analytics.summary.approvedTemplates}
            color="green"
            icon={<MessageSquare size={20} />}
          />
          <SummaryCard
            title="Rejected"
            value={analytics.summary.rejectedTemplates}
            color="red"
            icon={<MessageSquare size={20} />}
          />
        </div>
      )}

      {/* Behavioral Insights */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        <div className="lg:col-span-2">
          <EngagementHeatmap 
            matrix={behavioralData?.matrix} 
            maxEngagement={behavioralData?.maxEngagement} 
            isLoading={loading}
          />
        </div>
        <div className="flex flex-col gap-6">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-6 bg-indigo-600 rounded-2xl text-white shadow-xl shadow-indigo-100 dark:shadow-none"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-white/20 rounded-lg">
                <TrendingUp size={20} />
              </div>
              <h3 className="font-semibold">Best Time to Send</h3>
            </div>
            <p className="text-3xl font-bold mb-2">
              {behavioralData?.bestTime || 'Analyzing...'}
            </p>
            <p className="text-indigo-100 text-sm">
              Your customers are most active during this window. Send campaigns now for maximum engagement.
            </p>
          </motion.div>

          <div className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl">
            <h3 className="font-semibold text-slate-900 dark:text-white mb-4">Quick Recommendation</h3>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Recommendations will appear when enough message engagement data is available.
            </p>
          </div>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {messagesTrendData.length > 0 && (
          <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-slate-200 dark:border-slate-800">
            <TemplateAnalyticsChart
              data={messagesTrendData}
              type="line"
              title="Messages Trend"
              dataKey="count"
              xAxisKey="date"
            />
          </div>
        )}

        {qualityDistributionData.some(d => d.value > 0) && (
          <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-slate-200 dark:border-slate-800">
            <TemplateAnalyticsChart
              data={qualityDistributionData}
              type="pie"
              title="Quality Score Distribution"
              dataKey="value"
            />
          </div>
        )}
      </div>

      {/* Top vs Low Performers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Top Performers */}
        <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-slate-200 dark:border-slate-800">
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-4">
            🚀 Top Performing Templates
          </h2>
          {topPerformers.length > 0 ? (
            <div className="space-y-3">
              {topPerformers.map((template, idx) => (
                <div key={template._id?.toString() || template.id?.toString() || `top-${idx}`} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                  <div className="flex-1">
                    <p className="font-medium text-slate-900 dark:text-slate-100">{idx + 1}. {template.name}</p>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      {template.stats?.sentCount || 0} sent • {template.stats?.deliveryRate?.toFixed(1)}% delivery
                    </p>
                  </div>
                  {template.qualityScore?.score && (
                    <QualityScoreBadge score={template.qualityScore.score} />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-slate-500">No data available</p>
          )}
        </div>

        {/* Low Performers */}
        <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-slate-200 dark:border-slate-800">
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-4">
            ⚠️ Low Performing Templates
          </h2>
          {lowPerformers.length > 0 ? (
            <div className="space-y-3">
              {lowPerformers.map((template, idx) => (
                <div key={template._id?.toString() || template.id?.toString() || `low-${idx}`} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                  <div className="flex-1">
                    <p className="font-medium text-slate-900 dark:text-slate-100">{idx + 1}. {template.name}</p>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      {template.stats?.sentCount || 0} sent • {template.stats?.failureRate?.toFixed(1)}% failure rate
                    </p>
                  </div>
                  {template.qualityScore?.score && (
                    <QualityScoreBadge score={template.qualityScore.score} />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-slate-500">No data available</p>
          )}
        </div>
      </div>

      {/* Quality Breakdown */}
      {analytics?.qualityBreakdown && (
        <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-slate-200 dark:border-slate-800">
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-4">Quality Breakdown</h2>
          <div className="grid grid-cols-3 gap-4">
            <QualityBreakdownCard
              label="Excellent"
              value={analytics.qualityBreakdown.GREEN || 0}
              color="green"
            />
            <QualityBreakdownCard
              label="Good"
              value={analytics.qualityBreakdown.YELLOW || 0}
              color="yellow"
            />
            <QualityBreakdownCard
              label="Needs Review"
              value={analytics.qualityBreakdown.RED || 0}
              color="red"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ title, value, icon, color = 'blue' }: { title: string, value: any, icon: React.ReactNode, color: string }) {
  const colorClasses: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400',
    green: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400',
    red: 'bg-rose-50 text-rose-600 dark:bg-rose-900/20 dark:text-rose-400',
    purple: 'bg-purple-50 text-purple-600 dark:bg-purple-900/20 dark:text-purple-400'
  };

  return (
    <div className="bg-white dark:bg-slate-900 p-4 rounded-lg border border-slate-200 dark:border-slate-800">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${colorClasses[color]} mb-3`}>
        {icon}
      </div>
      <p className="text-slate-600 dark:text-slate-400 text-sm">{title}</p>
      <p className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1">{value}</p>
    </div>
  );
}

function QualityBreakdownCard({ label, value, color }: { label: string, value: any, color: string }) {
  const bgColors: Record<string, string> = {
    green: 'bg-emerald-100 dark:bg-emerald-900/20',
    yellow: 'bg-amber-100 dark:bg-amber-900/20',
    red: 'bg-rose-100 dark:bg-rose-900/20'
  };

  const textColors: Record<string, string> = {
    green: 'text-emerald-700 dark:text-emerald-400',
    yellow: 'text-amber-700 dark:text-amber-400',
    red: 'text-rose-700 dark:text-rose-400'
  };

  return (
    <div className={`p-4 rounded-lg ${bgColors[color]}`}>
      <p className={`${textColors[color]} text-sm opacity-80 uppercase tracking-wider font-semibold`}>{label}</p>
      <p className={`text-3xl font-bold ${textColors[color]} mt-2`}>{value}</p>
    </div>
  );
}
