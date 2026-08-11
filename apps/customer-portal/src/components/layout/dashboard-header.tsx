"use client";

import React from "react";
import Link from "next/link";

import {
  Search,
  User as UserIcon,
  Moon,
  Sun,
  Settings,
  Wallet,
  LogOut,
  ChevronRight,
  Sparkles,
  Calendar,
  MessageSquare,
  Users,
  Tag,
  Reply,
  Code,
} from "lucide-react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "next-themes";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuthStore } from "@/store/auth-store";
import { usePathname, useRouter } from "next/navigation";
import { useCommandStore } from "@/store/command-center-store";
import { cn, formatWalletMoney, normalizeWalletBalanceForDisplay } from "@/lib/utils";
import { NotificationPanel } from "./notification-panel";


export function DashboardHeader() {
  const { setTheme, theme } = useTheme();
  const { user, wallet, logout } = useAuthStore();
  const { toggle } = useCommandStore();
  const router = useRouter();
  const pathname = usePathname();
  const [showSettings, setShowSettings] = React.useState(false);
  const settingsRef = React.useRef<HTMLDivElement | null>(null);

  const CRITICAL_THRESHOLD = 500;
  const LOW_THRESHOLD = 1000;
  const displayBalance = normalizeWalletBalanceForDisplay(wallet?.balance);
  const walletCurrency = wallet?.currency || 'INR';
  const isZeroBalance = displayBalance <= 0;
  const isCriticalBalance = displayBalance < CRITICAL_THRESHOLD && !isZeroBalance;
  const isLowBalance = displayBalance < LOW_THRESHOLD && !isCriticalBalance && !isZeroBalance;


  const getBreadcrumbs = () => {
    const segments = pathname.split('/').filter(Boolean);
    const isOpaqueId = (segment: string) =>
      /^[a-f0-9]{24}$/i.test(segment) || /^[a-z0-9_-]{16,}$/i.test(segment);
    const nonRoutableBreadcrumbs = new Set([
      '/analytics',
      '/automation/workflows/builder',
    ]);

    const crumbs = segments.map((segment, index) => {
      const url = `/${segments.slice(0, index + 1).join('/')}`;
      let title = segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');
      const clickable = !isOpaqueId(segment) && !nonRoutableBreadcrumbs.has(url);

      // Specialized titles for better UX
      if (segment === 'crm') title = 'CRM';
      if (segment === 'waba') title = 'WhatsApp API';
      if (segment === 'ads') title = 'Campaign Analytics';
      if (segment === 'automation') title = 'Automation Hub';
      if (segment === 'billing') title = 'Plans & Billing';
      if (isOpaqueId(segment)) title = 'Details';

      return { title, url, clickable };
    });
    return crumbs;
  };

  const breadcrumbs = getBreadcrumbs();

  const settingsItems = [
    { label: 'WhatsApp Profile', path: '/settings/whatsapp-profile', icon: UserIcon, color: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
    { label: 'Developer Settings', path: '/settings/developer', icon: Code, color: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
    { label: 'Manage Teams', path: '/settings/teams', icon: Users, color: 'bg-pink-500/10 text-pink-600 dark:text-pink-400' },
    { label: 'Manage Tags', path: '/settings/tags', icon: Tag, color: 'bg-purple-500/10 text-purple-600 dark:text-purple-400' },
    { label: 'Quick Replies', path: '/settings/quick-replies', icon: Reply, color: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400' },
    { label: 'Member Profile', path: '/settings/member-profile', icon: UserIcon, color: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
    { label: 'Manage Events', path: '/settings/developer/webhooks', icon: Calendar, color: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400' },
    { label: 'Configure Channels', path: '/settings/channels', icon: MessageSquare, color: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' },
  ];

  const handleSettingsClick = (path: string) => {
    setShowSettings(false);
    router.push(path);
  };

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        setShowSettings(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <header className="sticky top-0 z-30 flex h-16 w-full items-center justify-between border-b border-border/50 bg-background/80 backdrop-blur-md px-4 lg:px-6">
      <div className="flex items-center gap-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 h-4 hidden sm:block" />

        <Breadcrumb className="hidden md:flex">
          <BreadcrumbList>
            {/* <BreadcrumbItem>
            <BreadcrumbLink href="/" className="text-muted-foreground/60 hover:text-primary transition-colors">ConnectSphere</BreadcrumbLink>
            </BreadcrumbItem> */}
            {breadcrumbs.map((crumb, i) => (
              <React.Fragment key={crumb.url}>
                <BreadcrumbSeparator className="opacity-40"><ChevronRight className="h-3 w-3" /></BreadcrumbSeparator>
                <BreadcrumbItem>
                  {i === breadcrumbs.length - 1 ? (
                    <BreadcrumbPage className="font-bold text-foreground">{crumb.title}</BreadcrumbPage>
                  ) : !crumb.clickable ? (
                    <BreadcrumbPage className="font-bold text-muted-foreground/80">{crumb.title}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink href={crumb.url} className="text-muted-foreground/80 hover:text-foreground transition-colors">{crumb.title}</BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </React.Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <div className="flex flex-1 items-center justify-center px-4 md:max-w-md lg:max-w-xl">
        <button
          onClick={toggle}
          className="relative w-full group flex items-center h-10 px-4 bg-muted/30 hover:bg-muted/50 border border-border/50 rounded-2xl transition-all cursor-text outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
        >
          <Search className="h-4 w-4 mr-3 text-muted-foreground transition-colors group-hover:text-primary" />
          <span className="text-sm font-medium text-muted-foreground/60 group-hover:text-muted-foreground transition-colors truncate">
            Search modules, actions or press ⌘K
          </span>
          <div className="absolute right-3 top-1/2 -translate-y-1/2 hidden sm:flex items-center gap-1.5 px-1.5 py-0.5 rounded-lg border bg-background/50 text-[10px] font-bold text-muted-foreground">
            <span className="text-xs">⌘</span>K
          </div>
        </button>
      </div>

      <div className="flex items-center gap-2 lg:gap-4">
        {/* Wallet Balance */}
        <Link
          href={wallet?.isServiceDown ? "#" : "/billing"}
          className={cn(
            "hidden lg:flex items-center gap-3 px-4 py-1.5 border rounded-2xl group cursor-pointer hover:shadow-lg transition-all",
            isZeroBalance
              ? "bg-rose-500/10 border-rose-500/20 shadow-rose-500/10 hover:shadow-rose-500/20"
              : isCriticalBalance
                ? "bg-rose-500/5 border-rose-500/20 shadow-rose-500/5 hover:shadow-rose-500/15"
                : isLowBalance
                  ? "bg-amber-500/10 border-amber-500/20 shadow-amber-500/10 hover:shadow-amber-500/20"
                  : "bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 border-emerald-100 dark:border-emerald-800 hover:shadow-emerald-500/10"
          )}
        >
          <div className={cn(
            "p-1.5 rounded-xl shadow-lg transition-transform group-hover:scale-110",
            isZeroBalance || isCriticalBalance ? "bg-rose-500 shadow-rose-500/20" : isLowBalance ? "bg-amber-500 shadow-amber-500/20" : "bg-emerald-500 shadow-emerald-500/20"
          )}>
            <Wallet className="h-3.5 w-3.5 text-white" />
          </div>
          <div className="flex flex-col gap-0">
            <span className={cn(
              "text-[10px] font-bold uppercase tracking-widest",
              isZeroBalance || isCriticalBalance ? "text-rose-600 dark:text-rose-400" : isLowBalance ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"
            )}>
              {isZeroBalance ? "Critical" : isCriticalBalance ? "Critical" : isLowBalance ? "Low Balance" : "Balance"}
            </span>
            <span className="text-sm font-black text-foreground">
              {wallet?.isServiceDown ? (
                <span className="text-muted-foreground animate-pulse">Unavailable</span>
              ) : (
                formatWalletMoney(wallet?.balance, walletCurrency)
              )}
            </span>
          </div>
          {(isLowBalance || isCriticalBalance || isZeroBalance) && (
            <div className="ml-1 h-2 w-2 rounded-full bg-current animate-pulse shrink-0" />
          )}
        </Link>

        {/* Notifications */}
        <NotificationPanel />

        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="p-2.5 hover:bg-accent rounded-xl transition-colors group"
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? (
            <Sun className="h-[18px] w-[18px] text-amber-400 group-hover:text-amber-300 transition-colors" />
          ) : (
            <Moon className="h-[18px] w-[18px] text-muted-foreground group-hover:text-foreground transition-colors" />
          )}
        </button>

        <div className="relative" ref={settingsRef}>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="p-2.5 hover:bg-accent rounded-xl transition-colors group"
            aria-label="Open quick settings"
            aria-expanded={showSettings}
          >
            <Settings className="h-[18px] w-[18px] text-muted-foreground group-hover:text-foreground transition-colors" />
          </button>

          {showSettings && (
            <div className="absolute right-0 mt-2 w-[420px] bg-card rounded-2xl shadow-premium border border-border/50 overflow-hidden animate-fade-in-up">
              <div className="p-4">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Quick Settings</h3>
                <div className="grid grid-cols-2 gap-2">
                  {settingsItems.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      onClick={() => handleSettingsClick(item.path)}
                      className="flex items-center gap-3 p-3 rounded-xl hover:bg-accent/80 transition-all duration-200 group text-left"
                    >
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${item.color} transition-colors`}>
                        <item.icon className="h-4 w-4" />
                      </div>
                      <span className="text-sm font-medium text-foreground/80 group-hover:text-foreground transition-colors">
                        {item.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <Separator orientation="vertical" className="hidden sm:block h-6 opacity-30" />

        {/* User Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Open account menu"
            className="relative h-10 w-10 rounded-full cursor-pointer ring-offset-background transition-all hover:ring-2 hover:ring-primary/40 focus:outline-none"
          >
            <Avatar className="h-10 w-10 border-2 border-primary/10 transition-all group-hover:border-primary/40">
              <AvatarImage src={user?.avatar || ""} alt={user?.name} />
              <AvatarFallback className="bg-primary/10 text-primary font-bold text-base uppercase">
                {user?.name?.charAt(0) || <UserIcon className="h-5 w-5" />}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64 rounded-2xl shadow-premium border-border/50 p-2" align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal p-4">
                <div className="flex flex-col space-y-2">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-bold leading-none">{user?.name}</p>
                    <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-black uppercase tracking-tighter">
                      <Sparkles className="h-2 w-2" />
                      {user?.plan?.name || "Trial"}
                    </div>
                  </div>
                  <p className="text-xs leading-none text-muted-foreground font-medium italic">
                    {user?.email}
                  </p>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator className="opacity-50" />
            <DropdownMenuGroup className="p-1 space-y-1">
              <DropdownMenuItem render={<Link href="/settings/member-profile" />} className="rounded-xl h-10 hover:bg-muted/50 transition-colors cursor-pointer group">
                <UserIcon className="mr-3 h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                <span className="font-medium">Profile Settings</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/billing" />} className="rounded-xl h-10 hover:bg-muted/50 transition-colors cursor-pointer group">
                <Wallet className="mr-3 h-4 w-4 text-muted-foreground group-hover:text-emerald-500 transition-colors" />
                <span className="font-medium">Add Credits</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/settings" />} className="rounded-xl h-10 hover:bg-muted/50 transition-colors cursor-pointer group">
                <Settings className="mr-3 h-4 w-4 text-muted-foreground group-hover:text-blue-500 transition-colors" />
                <span className="font-medium">Workspace Config</span>
              </DropdownMenuItem>

            </DropdownMenuGroup>
            <DropdownMenuSeparator className="opacity-50" />
            <div className="p-1">
              <DropdownMenuItem
                onClick={logout}
                className="rounded-xl h-10 text-destructive focus:bg-destructive/10 focus:text-destructive font-bold transition-all cursor-pointer group"
              >
                <LogOut className="mr-3 h-4 w-4 group-hover:-translate-x-1 transition-transform" />
                <span>Log out</span>
              </DropdownMenuItem>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
