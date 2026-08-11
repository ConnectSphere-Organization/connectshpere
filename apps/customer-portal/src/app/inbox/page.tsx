"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { 
  MessageSquare, 
  MoreVertical, 
  Plus, 
  Search, 
  Filter,
  CheckCircle2,
  AlertCircle,
  Clock,
  Send,
  Loader2,
  UserPlus,
  CheckCircle,
  ShieldAlert
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import { 
  fetchConversations, 
  fetchMessages, 
  markAsRead, 
  sendMessage, 
  sendMediaMessage,
  Conversation,
  Message,
  uploadMedia,
  fetchMembers,
  fetchTeams,
  performConversationAction
} from '@/lib/api/inbox';
import { fetchPipelines } from '@/lib/api/crm';
import ContactDetailsSidebar from '@/components/dashboard/inbox/contact-details-sidebar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useSocket } from '@/hooks/use-socket';
import { useAuthStore } from '@/store/auth-store';
import ConversationsList from '@/components/dashboard/inbox/conversations-list';
import MessageThread from '@/components/dashboard/inbox/message-thread';
import ChatInput from '@/components/dashboard/inbox/chat-input';
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuTrigger 
} from '@/components/ui/dropdown-menu';
import FlashLoader from '@/components/ui/flash-loader';

const toEntityId = (value: any): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if (value._id) return toEntityId(value._id);
    if (value.id) return toEntityId(value.id);
  }

  const normalized = value?.toString?.();
  return normalized && normalized !== '[object Object]' ? normalized : null;
};

const getMessageBody = (message: any) =>
  message?.body || message?.text || message?.media?.caption || message?.lastMessagePreview || '';

const messageIdentityValues = (message: any) => {
  const whatsappMessageId = message?.whatsappMessageId;
  return [
    toEntityId(message?._id),
    toEntityId(message?.id),
    typeof whatsappMessageId === 'object' ? toEntityId(whatsappMessageId) : whatsappMessageId,
    toEntityId(message?.messageId),
    toEntityId(message?.providerMessageId),
  ].filter(Boolean).map(String);
};

const isSameMessage = (left: any, right: any) => {
  const leftIds = new Set(messageIdentityValues(left));
  return messageIdentityValues(right).some((id) => leftIds.has(id));
};

const messageMatchesStatusPayload = (message: any, data: any) => {
  const statusIds = new Set([
    data?.messageId,
    data?.providerMessageId,
    data?.whatsappMessageId,
  ].filter(Boolean).map(String));

  if (statusIds.size === 0) return false;
  return messageIdentityValues(message).some((id) => statusIds.has(id));
};

const MESSAGE_STATUS_RANK: Record<string, number> = {
  pending: 0,
  queued: 0,
  sending: 1,
  sent: 2,
  received: 2,
  delivered: 3,
  read: 4,
};

const normalizeMessageStatusValue = (status: any) =>
  typeof status === 'string' ? status.toLowerCase() : '';

const getMessageStatusRank = (status: any) => {
  const normalized = normalizeMessageStatusValue(status);
  return MESSAGE_STATUS_RANK[normalized] ?? -1;
};

const parseEventTime = (value: any) => {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const isStatusEventNewer = (message: any, data: any) => {
  const incomingTime = parseEventTime(data?.timestamp || data?.statusUpdatedAt || data?.updatedAt);
  const currentTime = parseEventTime(message?.statusUpdatedAt || message?.updatedAt);
  if (incomingTime && currentTime) return incomingTime > currentTime;
  if (incomingTime && !currentTime) return true;
  return normalizeMessageStatusValue(data?.status) !== normalizeMessageStatusValue(message?.status);
};

const shouldApplyStatusUpdate = (message: any, data: any) => {
  const incomingStatus = normalizeMessageStatusValue(data?.status);
  if (!incomingStatus) return false;

  const currentStatus = normalizeMessageStatusValue(message?.status);
  if (!currentStatus) return true;

  const incomingRank = getMessageStatusRank(incomingStatus);
  const currentRank = getMessageStatusRank(currentStatus);

  if (incomingStatus === 'failed') {
    if (currentStatus === 'failed') return isStatusEventNewer(message, data);
    return currentRank < MESSAGE_STATUS_RANK.delivered;
  }

  if (currentStatus === 'failed') {
    return incomingRank >= MESSAGE_STATUS_RANK.delivered;
  }

  if (incomingRank < currentRank) return false;
  if (incomingRank > currentRank) return true;
  return isStatusEventNewer(message, data);
};

const applyStatusUpdateToMessage = (message: any, data: any) => {
  if (!messageMatchesStatusPayload(message, data)) return { message, matched: false, changed: false };
  if (!shouldApplyStatusUpdate(message, data)) return { message, matched: true, changed: false };

  return {
    message: {
      ...message,
      status: normalizeMessageStatusValue(data.status),
      statusUpdatedAt: data.timestamp || message.statusUpdatedAt,
    },
    matched: true,
    changed: true,
  };
};

const rememberSocketEvent = (cache: Map<string, number>, key: string | null) => {
  if (!key) return true;

  const now = Date.now();
  if (cache.has(key)) return false;

  cache.set(key, now);
  if (cache.size > 500) {
    for (const [cachedKey, seenAt] of cache) {
      if (now - seenAt > 60_000 || cache.size > 400) {
        cache.delete(cachedKey);
      }
    }
  }

  return true;
};

const buildMessageEventKey = (data: any) => {
  const conversationId = toEntityId(data?.conversationId || data?.conversation?._id);
  const ids = messageIdentityValues(data?.message);
  if (!conversationId || ids.length === 0) return null;
  return `message:${conversationId}:${ids.sort().join('|')}`;
};

const buildStatusEventKey = (data: any) => {
  const conversationId = toEntityId(data?.conversationId);
  const ids = [data?.messageId, data?.providerMessageId, data?.whatsappMessageId]
    .filter(Boolean)
    .map(String)
    .sort();
  if (!conversationId || ids.length === 0) return null;
  return `status:${conversationId}:${ids.join('|')}:${normalizeMessageStatusValue(data?.status)}:${data?.timestamp || ''}`;
};

const getUnreadForUser = (counts: any, userId: string | null): number | undefined => {
  if (!counts || !userId) return undefined;
  if (counts instanceof Map) return Number(counts.get(userId)) || 0;
  if (typeof counts === 'object' && userId in counts) return Number(counts[userId]) || 0;
  return undefined;
};

const setUnreadForUser = (counts: any, userId: string | null, unreadCount: number) => {
  if (!userId) return counts;
  if (counts instanceof Map) {
    const next = new Map(counts);
    next.set(userId, unreadCount);
    return next;
  }
  return {
    ...(counts || {}),
    [userId]: unreadCount,
  };
};

const normalizeSocketMessage = (message: any): Message => ({
  ...(message || {}),
  body: getMessageBody(message),
  text: message?.text || getMessageBody(message),
  whatsappMessageId: message?.whatsappMessageId || message?.messageId,
  createdAt: message?.createdAt || message?.sentAt || message?.timestamp || new Date().toISOString(),
}) as Message;

export default function InboxPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { user, workspace } = useAuthStore();
  
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [assignmentFilter, setAssignmentFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [channelFilter, setChannelFilter] = useState('all');
  const [isDetailsOpen, setIsDetailsOpen] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const workspaceId = React.useMemo(
    () => toEntityId(workspace?._id || workspace?.id || user?.workspace?._id || user?.workspace),
    [workspace, user]
  );
  const currentUserId = React.useMemo(() => toEntityId(user?._id || user?.id), [user]);
  const seenMessageEventsRef = React.useRef(new Map<string, number>());
  const seenStatusEventsRef = React.useRef(new Map<string, number>());

  useEffect(() => {
    const updateCurrentTime = () => setCurrentTime(Date.now());
    updateCurrentTime();
    const timer = window.setInterval(updateCurrentTime, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // 1. Fetch Conversations
  const { data: convsData, isLoading: isConvsLoading } = useQuery({
    queryKey: ['conversations', statusFilter, assignmentFilter, channelFilter],
    queryFn: () => {
      let view = 'mine';
      if (['resolved', 'snoozed', 'spam'].includes(statusFilter)) {
        view = statusFilter;
      } else {
        view = assignmentFilter === 'me' ? 'mine' : assignmentFilter;
      }
      return fetchConversations({ 
        view,
        status: ['all', 'open'].includes(statusFilter) ? undefined : statusFilter,
        channel: channelFilter === 'all' ? undefined : channelFilter
      });
    }
  });

  const conversations = convsData?.data || [];

  // 1.5 Fetch Agents, Teams & Pipelines for sidebar/assignment
  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: fetchMembers
  });

  const { data: teamsData } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams
  });

  const agents = agentsData?.data || [];
  const teams = teamsData?.data || [];

  const { data: pipelinesData } = useQuery({
    queryKey: ['pipelines'],
    queryFn: fetchPipelines
  });

  const pipelines = pipelinesData?.data || pipelinesData || [];

  // 2. Fetch Messages with Infinite Loading (Chunked Pagination)
  const { 
    data: messagesPages, 
    fetchNextPage, 
    hasNextPage, 
    isFetchingNextPage, 
    isLoading: isMessagesLoading,
    refetch: refetchMessages
  } = useInfiniteQuery({
    queryKey: ['messages', selectedConversation?._id],
    queryFn: ({ pageParam }) => fetchMessages(selectedConversation!._id, { before: pageParam, limit: 20 }),
    getNextPageParam: (lastPage: any) => lastPage.pagination?.hasMore ? lastPage.pagination.lastTimestamp : undefined,
    enabled: !!selectedConversation?._id,
    initialPageParam: undefined as string | undefined,
    staleTime: 1000 * 60 * 5, // Keep messages "fresh" for 5 minutes
    gcTime: 1000 * 60 * 30,   // Keep in cache for 30 minutes
  });

  // Flatten messages from all pages
  const messages = React.useMemo(() => {
    if (!messagesPages) return [];
    return [...messagesPages.pages].reverse().flatMap(page => page.data || []);
  }, [messagesPages]);

  // Handle Socket Updates - Sync with React Query Cache
  const { socket, isConnected } = useSocket({
    workspaceId: workspaceId || undefined,
    conversationId: selectedConversation?._id
  });

  const clearUnreadInConversationCaches = useCallback((conversationId: string) => {
    queryClient.setQueriesData({ queryKey: ['conversations'] }, (old: any) => {
      if (!old?.data || !Array.isArray(old.data)) return old;

      let changed = false;
      const data = old.data.map((conv: any) => {
        if (toEntityId(conv?._id) !== conversationId) return conv;
        changed = true;
        return {
          ...conv,
          unreadCount: 0,
          myUnreadCount: 0,
          agentUnreadCounts: setUnreadForUser(conv.agentUnreadCounts, currentUserId, 0),
        };
      });

      return changed ? { ...old, data } : old;
    });

    setSelectedConversation((current) => (
      current && toEntityId(current._id) === conversationId
        ? {
            ...current,
            unreadCount: 0,
            myUnreadCount: 0,
            agentUnreadCounts: setUnreadForUser((current as any).agentUnreadCounts, currentUserId, 0),
          } as any
        : current
    ));
  }, [queryClient, currentUserId]);

  const markConversationAsRead = useCallback(async (conversationId: string | null) => {
    if (!conversationId) return;

    clearUnreadInConversationCaches(conversationId);
    try {
      await markAsRead(conversationId);
    } finally {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }
  }, [clearUnreadInConversationCaches, queryClient]);

  const conversationMatchesActiveFilters = useCallback((conversation: any) => {
    const status = conversation?.status || 'open';
    const channel = conversation?.channel || 'whatsapp';
    const assignedToId = toEntityId(conversation?.assignedTo);

    if (!['all', 'open'].includes(statusFilter) && status !== statusFilter) return false;
    if (channelFilter !== 'all' && channel !== channelFilter) return false;
    if (assignmentFilter === 'me' && assignedToId !== currentUserId) return false;
    if (assignmentFilter === 'unassigned' && assignedToId) return false;

    return true;
  }, [assignmentFilter, channelFilter, currentUserId, statusFilter]);

  const patchConversationCachesForMessage = useCallback((data: any, isSelected: boolean) => {
    const conversationId = toEntityId(data?.conversationId || data?.conversation?._id);
    if (!conversationId) return;

    const message = normalizeSocketMessage(data?.message);
    const eventConversation = data?.conversation || {};
    const baseConversation = {
      _id: conversationId,
      contact: data?.contact || eventConversation.contact || message.contact || {
        _id: toEntityId(message.contact),
        name: 'Unknown',
        phone: '',
      },
      channel: eventConversation.channel || 'whatsapp',
      status: eventConversation.status || 'open',
      priority: eventConversation.priority || 'normal',
      unreadCount: eventConversation.unreadCount || 0,
      myUnreadCount: eventConversation.myUnreadCount || 0,
      agentUnreadCounts: eventConversation.agentUnreadCounts || {},
      lastActivityAt: eventConversation.lastActivityAt,
      lastMessageAt: eventConversation.lastMessageAt,
      ...eventConversation,
    };
    const eventUnreadForUser = getUnreadForUser(eventConversation.agentUnreadCounts, currentUserId);
    const isInbound = !message.direction || message.direction === 'inbound';
    const timestamp =
      message.createdAt ||
      (message as any).sentAt ||
      data?.timestamp ||
      eventConversation.lastActivityAt ||
      new Date().toISOString();
    const preview = getMessageBody(message) || eventConversation.lastMessagePreview || 'New message';

    const patchConversation = (conv: any) => {
      const duplicateLastMessage = isSameMessage(conv.lastMessage, message);
      const shouldClearUnread = isSelected && isInbound;
      const shouldIncrementUnread = isInbound && !shouldClearUnread && !duplicateLastMessage;
      const nextUnreadCount = shouldClearUnread
        ? 0
        : Number(eventConversation.unreadCount ?? ((Number(conv.unreadCount) || 0) + (shouldIncrementUnread ? 1 : 0)));
      const nextMyUnreadCount = shouldClearUnread
        ? 0
        : Number(eventUnreadForUser ?? ((Number(conv.myUnreadCount) || 0) + (shouldIncrementUnread ? 1 : 0)));

      return {
        ...conv,
        ...eventConversation,
        _id: conv._id,
        contact: data?.contact || eventConversation.contact || conv.contact,
        lastMessage: message,
        lastMessageAt: timestamp,
        lastActivityAt: timestamp,
        lastMessagePreview: preview,
        lastMessageDirection: message.direction || eventConversation.lastMessageDirection || conv.lastMessageDirection,
        lastMessageType: message.type || eventConversation.lastMessageType || conv.lastMessageType,
        unreadCount: nextUnreadCount,
        myUnreadCount: nextMyUnreadCount,
        agentUnreadCounts: setUnreadForUser(
          eventConversation.agentUnreadCounts || conv.agentUnreadCounts,
          currentUserId,
          nextMyUnreadCount
        ),
      };
    };

    queryClient.setQueriesData({ queryKey: ['conversations'] }, (old: any) => {
      if (!old?.data || !Array.isArray(old.data)) return old;

      let changed = false;
      const dataList = old.data.map((conv: any) => {
        if (toEntityId(conv?._id) !== conversationId) return conv;
        changed = true;
        return patchConversation(conv);
      });

      if (!changed) return old;

      dataList.sort((left: any, right: any) => {
        const leftTime = new Date(left.lastActivityAt || left.lastMessageAt || 0).getTime();
        const rightTime = new Date(right.lastActivityAt || right.lastMessageAt || 0).getTime();
        return rightTime - leftTime;
      });

      return { ...old, data: dataList };
    });

    queryClient.setQueryData(['conversations', statusFilter, assignmentFilter, channelFilter], (old: any) => {
      if (!old?.data || !Array.isArray(old.data)) return old;
      const exists = old.data.some((conv: any) => toEntityId(conv?._id) === conversationId);
      if (exists || !conversationMatchesActiveFilters(baseConversation)) return old;

      return {
        ...old,
        data: [patchConversation(baseConversation), ...old.data],
        pagination: old.pagination
          ? { ...old.pagination, total: Number(old.pagination.total || 0) + 1 }
          : old.pagination,
      };
    });

    setSelectedConversation((current) => (
      current && toEntityId(current._id) === conversationId
        ? patchConversation(current)
        : current
    ));
  }, [
    queryClient,
    currentUserId,
    statusFilter,
    assignmentFilter,
    channelFilter,
    conversationMatchesActiveFilters,
  ]);

  const patchConversationCachesForStatus = useCallback((data: any) => {
    const conversationId = toEntityId(data?.conversationId);
    if (!conversationId) return;

    const patchStatus = (conv: any) => {
      if (toEntityId(conv?._id) !== conversationId) return conv;
      if (!conv.lastMessage) return conv;
      const result = applyStatusUpdateToMessage(conv.lastMessage, data);
      if (!result.changed) return conv;

      return {
        ...conv,
        lastMessage: result.message,
      };
    };

    queryClient.setQueriesData({ queryKey: ['conversations'] }, (old: any) => {
      if (!old?.data || !Array.isArray(old.data)) return old;
      let changed = false;
      const dataList = old.data.map((conv: any) => {
        const next = patchStatus(conv);
        if (next !== conv) changed = true;
        return next;
      });
      return changed ? { ...old, data: dataList } : old;
    });

    setSelectedConversation((current) => {
      if (!current) return current;
      const next = patchStatus(current);
      return next === current ? current : next;
    });
  }, [queryClient]);

  const patchConversationCachesForUpdate = useCallback((data: any) => {
    const conversationId = toEntityId(data?.conversationId || data?._id);
    if (!conversationId) return;

    queryClient.setQueriesData({ queryKey: ['conversations'] }, (old: any) => {
      if (!old?.data || !Array.isArray(old.data)) return old;

      let changed = false;
      const dataList = old.data.map((conv: any) => {
        if (toEntityId(conv?._id) !== conversationId) return conv;

        changed = true;
        const userReadThisConversation = data.readBy && currentUserId && String(data.readBy) === currentUserId;
        const nextMyUnreadCount = userReadThisConversation
          ? 0
          : Number(data.myUnreadCount ?? conv.myUnreadCount ?? 0);
        const nextUnreadCount = userReadThisConversation
          ? Number(data.unreadCount ?? 0)
          : Number(data.unreadCount ?? conv.unreadCount ?? 0);

        return {
          ...conv,
          ...data,
          _id: conv._id,
          unreadCount: nextUnreadCount,
          myUnreadCount: nextMyUnreadCount,
          agentUnreadCounts: setUnreadForUser(conv.agentUnreadCounts, currentUserId, nextMyUnreadCount),
        };
      });

      return changed ? { ...old, data: dataList } : old;
    });

    setSelectedConversation((current) => {
      if (!current || toEntityId(current._id) !== conversationId) return current;
      const userReadThisConversation = data.readBy && currentUserId && String(data.readBy) === currentUserId;
      return {
        ...current,
        ...data,
        _id: current._id,
        unreadCount: userReadThisConversation ? Number(data.unreadCount ?? 0) : Number(data.unreadCount ?? current.unreadCount ?? 0),
        myUnreadCount: userReadThisConversation ? 0 : Number(data.myUnreadCount ?? current.myUnreadCount ?? 0),
      } as any;
    });
  }, [queryClient, currentUserId]);

  // Diagnostic listeners — own effect so they don't get re-registered (and
  // never cleaned up) every time `isConnected`/`selectedConversation`
  // change. The previous version registered these in the same effect as
  // the inbox handlers and returned early when disconnected, leaking
  // listeners on every reconnect.
  useEffect(() => {
    if (!socket) return;
    const onConnect = () => console.log('[Inbox:Socket] Connected', socket.id);
    const onConnectError = (err: any) => console.error('[Inbox:Socket] Connection Error:', err.message);
    const onPing = (data: any) => console.log('[Inbox:Socket] Heartbeat:', data);
    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    socket.on('server:ping', onPing);
    return () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.off('server:ping', onPing);
    };
  }, [socket]);

  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleNewMessage = (data: any) => {
      if (!rememberSocketEvent(seenMessageEventsRef.current, buildMessageEventKey(data))) return;
      console.log('[Inbox:Socket] New Message Received:', data);

      const conversationId = toEntityId(data?.conversationId || data?.conversation?._id);
      const selectedConversationId = toEntityId(selectedConversation?._id);
      const message = normalizeSocketMessage(data?.message);
      const isSelectedConversation = !!conversationId && conversationId === selectedConversationId;

      patchConversationCachesForMessage(data, isSelectedConversation);

      // Update cache only if it matches current selected conversation.
      if (isSelectedConversation && selectedConversationId) {
        queryClient.setQueryData(['messages', selectedConversationId], (old: any) => {
          if (!old) return old;
          if (!Array.isArray(old.pages) || old.pages.length === 0) return old;
          const newestPageIdx = 0;
          const newestPage = old.pages[newestPageIdx];
          
          // Prevent duplicates
          const exists = old.pages.some((page: any) =>
            (page.data || []).some((cachedMessage: any) => isSameMessage(cachedMessage, message))
          );
          if (exists) return old;

          const updatedPages = [...old.pages];
          updatedPages[newestPageIdx] = {
            ...newestPage,
            data: [...(newestPage.data || []), message]
          };
          
          return { ...old, pages: updatedPages };
        });

        if (message.direction === 'inbound' || !message.direction) {
          void markConversationAsRead(selectedConversationId);
        }
      }
    };

    const handleStatusUpdate = (data: any) => {
      if (!rememberSocketEvent(seenStatusEventsRef.current, buildStatusEventKey(data))) return;
      console.log('[Inbox:Socket] Status Update:', data);
      const conversationId = toEntityId(data?.conversationId || selectedConversation?._id);
      if (!conversationId) return;

      let matched = false;
      queryClient.setQueryData(['messages', conversationId], (old: any) => {
        if (!old) return old;
        let changed = false;
        const pages = old.pages.map((page: any) => ({
          ...page,
          data: page.data.map((msg: any) => {
            const result = applyStatusUpdateToMessage(msg, data);
            if (result.matched) matched = true;
            if (result.changed) changed = true;
            return result.message;
          })
        }));
        return changed ? { ...old, pages } : old;
      });

      patchConversationCachesForStatus(data);
      if (!matched) {
        void queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
      }
    };

    const handleStatusBatch = (data: any) => {
      console.log('[Inbox:Socket] Status Batch Update:', data);
      const updates = data.updates || [];
      if (!updates.length) return;

      const conversationId = toEntityId(data?.conversationId || updates[0]?.conversationId || selectedConversation?._id);
      if (!conversationId) return;

      let matched = false;
      queryClient.setQueryData(['messages', conversationId], (old: any) => {
        if (!old) return old;
        let changed = false;
        const pages = old.pages.map((page: any) => ({
          ...page,
          data: page.data.map((msg: any) => {
            const update = updates.find((u: any) => messageMatchesStatusPayload(msg, u));
            if (!update) return msg;
            matched = true;
            const result = applyStatusUpdateToMessage(msg, update);
            if (result.changed) changed = true;
            return result.message;
          })
        }));
        return changed ? { ...old, pages } : old;
      });

      updates.forEach((update: any) => patchConversationCachesForStatus({
        ...update,
        conversationId: update.conversationId || conversationId,
      }));

      if (!matched) {
        void queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
      }
    };

    const handleConversationUpdate = (data: any) => {
      console.log('[Inbox:Socket] Conversation Update:', data);
      patchConversationCachesForUpdate(data);
    };

    const handleInboxSync = (envelope: any) => {
      if (!envelope?.type) return;

      if (envelope.type === 'message_created' || envelope.type === 'message_status_updated' || envelope.type === 'message_status_changed') {
        return;
      }

      if (envelope.type === 'conversation_status_changed' || envelope.type === 'conversation_read' || envelope.type === 'conversation_updated') {
        handleConversationUpdate({
          conversationId: envelope.conversationId || envelope.payload?.conversationId,
          ...envelope.payload,
          updatedAt: envelope.timestamp,
        });
      }
    };

    // Listen to CORRECT backend event names
    socket.on('inbox:sync', handleInboxSync);
    socket.on('inbox:message_new', handleNewMessage);
    socket.on('inbox:message_sent', handleNewMessage); // Also treat sent as new message
    socket.on('inbox:message_status', handleStatusUpdate);
    socket.on('inbox:status_batch', handleStatusBatch);
    socket.on('inbox:conversation_updated', handleConversationUpdate);

    return () => {
      socket.off('inbox:sync', handleInboxSync);
      socket.off('inbox:message_new', handleNewMessage);
      socket.off('inbox:message_sent', handleNewMessage);
      socket.off('inbox:message_status', handleStatusUpdate);
      socket.off('inbox:status_batch', handleStatusBatch);
      socket.off('inbox:conversation_updated', handleConversationUpdate);
    };
  }, [
    socket,
    isConnected,
    selectedConversation,
    queryClient,
    markConversationAsRead,
    patchConversationCachesForMessage,
    patchConversationCachesForStatus,
    patchConversationCachesForUpdate
  ]);

  // Handle Conversation Selection
  const handleSelectConversation = async (conv: Conversation) => {
    setSelectedConversation(conv);
    void markConversationAsRead(conv._id);
  };

  const isSelectedWhatsAppSessionExpired = Boolean(
    selectedConversation?.channel === 'whatsapp' &&
    selectedConversation?.windowExpiresAt &&
    currentTime > 0 && new Date(selectedConversation.windowExpiresAt).getTime() <= currentTime
  );

  const notifySessionExpired = () => {
    toast.error('The 24-hour WhatsApp session has expired. Send an approved template to restart the conversation.');
  };

  // Mutations
  const sendMutation = useMutation({
    mutationFn: (payload: { text: string; isNote: boolean; extraData?: any }) => 
      sendMessage(selectedConversation!._id, { 
        body: payload.text, 
        isInternalNote: payload.isNote,
        ...(payload.extraData || {})
      }, { 'x-socket-id': socket?.id }),
    
    onMutate: async (payload) => {
      // Optimistic Update
      const optimisticMsg: Message = {
        _id: `opt-${Date.now()}`,
        body: payload.text,
        type: payload.extraData?.type || (payload.isNote ? 'note' : 'text'),
        direction: 'outbound',
        status: 'queued',
        createdAt: new Date().toISOString(),
        isInternalNote: payload.isNote,
        sentBy: user,
        meta: payload.extraData 
      } as any;

      queryClient.setQueryData(['messages', selectedConversation?._id], (old: any) => {
        if (!old) return old;
        const lastPageIdx = old.pages.length - 1;
        const updatedPages = [...old.pages];
        updatedPages[lastPageIdx] = {
          ...updatedPages[lastPageIdx],
          data: [...updatedPages[lastPageIdx].data, optimisticMsg]
        };
        return { ...old, pages: updatedPages };
      });

      return { optimisticMsg };
    },

    onSuccess: (data: any, variables, context) => {
      const serverMessage = data?.data || data?.messageData || data;
      if (!serverMessage || typeof serverMessage !== 'object') {
        queryClient.invalidateQueries({ queryKey: ['messages', selectedConversation?._id] });
        return;
      }

      queryClient.setQueryData(['messages', selectedConversation?._id], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page: any) => ({
            ...page,
            data: page.data.map((m: any) => m._id === context?.optimisticMsg._id ? serverMessage : m)
          }))
        };
      });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    
    onError: (err: any, variables, context) => {
      queryClient.setQueryData(['messages', selectedConversation?._id], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page: any) => ({
            ...page,
            data: page.data.filter((m: any) => m._id !== context?.optimisticMsg._id)
          }))
        };
      });
      toast.error(err.message || 'Failed to send message');
    }
  });

  const mediaMutation = useMutation({
    mutationFn: async (file: File) => {
      const upload: any = await uploadMedia(file);
      const uploadedUrl = upload?.url || upload?.data?.url;
      if (!uploadedUrl) {
        throw new Error('Media upload failed: missing URL');
      }
      return sendMediaMessage(selectedConversation!._id, { 
        mediaUrl: uploadedUrl,
        mediaType: file.type.startsWith('image/') ? 'image' : 'document',
        mimeType: file.type,
        filename: file.name
      }, { 'x-socket-id': socket?.id });
    },
    
    onMutate: async (file) => {
      const optimisticMsg: Message = {
        _id: `opt-${Date.now()}`,
        body: `[Sending ${file.name}]`,
        type: file.type.startsWith('image/') ? 'image' : 'document',
        direction: 'outbound',
        status: 'queued',
        createdAt: new Date().toISOString(),
        media: {
           url: URL.createObjectURL(file),
           filename: file.name
        }
      } as any;

      queryClient.setQueryData(['messages', selectedConversation?._id], (old: any) => {
        if (!old) return old;
        const lastPageIdx = old.pages.length - 1;
        const updatedPages = [...old.pages];
        updatedPages[lastPageIdx] = {
          ...updatedPages[lastPageIdx],
          data: [...updatedPages[lastPageIdx].data, optimisticMsg]
        };
        return { ...old, pages: updatedPages };
      });

      return { optimisticMsg };
    },

    onSuccess: (data: any, variables, context) => {
      const serverMessage = data?.data || data?.messageData || data;
      if (!serverMessage || typeof serverMessage !== 'object') {
        queryClient.invalidateQueries({ queryKey: ['messages', selectedConversation?._id] });
        return;
      }

      queryClient.setQueryData(['messages', selectedConversation?._id], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page: any) => ({
            ...page,
            data: page.data.map((m: any) => m._id === context?.optimisticMsg._id ? serverMessage : m)
          }))
        };
      });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },

    onError: (err: any, variables, context) => {
      queryClient.setQueryData(['messages', selectedConversation?._id], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page: any) => ({
            ...page,
            data: page.data.filter((m: any) => m._id !== context?.optimisticMsg._id)
          }))
        };
      });
      toast.error(err.message || 'Failed to send media');
    }
  });

  const actionMutation = useMutation({
    mutationFn: ({ action, data = {} }: { action: string; data?: any }) => 
        performConversationAction(selectedConversation!._id, action, data),
    
    onMutate: async ({ action, data }) => {
        await queryClient.cancelQueries({ queryKey: ['conversations'] });

        const previousConversations = queryClient.getQueryData(['conversations', statusFilter, assignmentFilter]);
        const previousSelected = selectedConversation;

        const applyChanges = (conv: any) => {
            const updated = { ...conv };
            if (action === 'label') updated.label = data.label;
            if (action === 'priority') updated.priority = data.priority;
            if (action === 'assign') updated.assignedTo = agents.find((a: any) => a._id === data.agentId);
            if (action === 'unassign') updated.assignedTo = undefined;
            return updated;
        };

        queryClient.setQueryData(['conversations', statusFilter, assignmentFilter], (old: any) => {
            if (!old) return old;
            return {
                ...old,
                data: old.data.map((c: any) => c._id === selectedConversation?._id ? applyChanges(c) : c)
            };
        });

        if (selectedConversation) {
            setSelectedConversation(applyChanges(selectedConversation));
        }

        return { previousConversations, previousSelected };
    },

    onSuccess: (res: any, variables) => {
        const { action } = variables;
        toast.success(`Conversation ${action}${action.endsWith('e') ? 'd' : 'ed'} successfully`);
        
        if (['resolve', 'spam', 'snooze'].includes(action)) {
            setSelectedConversation(null);
        }
    },

    onError: (err: any, variables, context: any) => {
        toast.error(err.message || 'Action failed');
        if (context?.previousConversations) {
            queryClient.setQueryData(['conversations', statusFilter, assignmentFilter], context.previousConversations);
        }
        if (context?.previousSelected) {
            setSelectedConversation(context.previousSelected);
        }
    },

    onSettled: () => {
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }
  });

  if (isConvsLoading) return <FlashLoader />;

  return (
    <div className="flex h-[calc(100vh-theme(spacing.16))] overflow-hidden -m-8">
      {/* 1. Conversations List */}
      <div className="w-80 flex-shrink-0 flex flex-col border-r border-border/50 bg-card/50 backdrop-blur-sm">
        <ConversationsList 
          conversations={conversations} 
          selectedId={selectedConversation?._id || null} 
          onSelect={handleSelectConversation}
          isLoading={isConvsLoading}
          activeStatus={statusFilter}
          onFilterChange={setStatusFilter}
          activeAssignment={assignmentFilter}
          onAssignmentChange={setAssignmentFilter}
          activeChannel={channelFilter}
          onChannelChange={setChannelFilter}
        />
      </div>

      {/* 2. Main Chat Area */}
      <div className="flex-1 flex flex-col bg-background relative min-h-0">
        <AnimatePresence mode="wait">
          {selectedConversation ? (
            <motion.div 
              key={selectedConversation._id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col h-full"
            >
              {/* Chat Header */}
              <div className="h-16 flex-shrink-0 px-6 border-b border-border/50 flex items-center justify-between bg-card/50 backdrop-blur-sm z-10">
                <div className="flex items-center gap-4">
                  <div className="flex flex-col">
                    <div className="flex items-center gap-2">
                       <h3 className="text-sm font-black text-foreground">{selectedConversation.contact.name}</h3>
                       {selectedConversation.priority !== 'normal' && (
                         <Badge className={`scale-75
                           text-[8px] font-black uppercase tracking-widest px-1.5 py-0 h-4 border-none
                           ${selectedConversation.priority === 'urgent' ? 'bg-red-500 text-white' : 
                             selectedConversation.priority === 'high' ? 'bg-orange-500 text-white' : 
                             'bg-slate-400 text-white'}
                         `}>
                           {selectedConversation.priority}
                         </Badge>
                       )}
                    </div>
                    <div className="flex items-center gap-1.5">
                       <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                       <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                         {selectedConversation.status === 'open' ? 'Active now' : selectedConversation.status}
                       </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                   <Button 
                    variant="ghost" 
                    size="icon" 
                    onClick={() => setIsDetailsOpen(!isDetailsOpen)}
                    className={`rounded-xl h-10 w-10 ${isDetailsOpen ? 'bg-primary/5 text-primary' : ''}`}
                   >
                     <AlertCircle className="h-5 w-5" />
                   </Button>
                    <DropdownMenu>
                       <DropdownMenuTrigger className="h-10 w-10 flex items-center justify-center rounded-xl hover:bg-muted transition-colors cursor-pointer outline-none border border-transparent">
                         <MoreVertical className="h-5 w-5 text-muted-foreground" />
                       </DropdownMenuTrigger>
                       <DropdownMenuContent align="end" className="rounded-2xl p-2 shadow-premium border-border/50 w-56">
                         <DropdownMenuItem 
                           className="rounded-xl font-bold gap-3 cursor-pointer"
                           onClick={() => actionMutation.mutate({ action: selectedConversation.assignedTo ? 'unassign' : 'claim' })}
                         >
                           <UserPlus className="h-4 w-4" /> {selectedConversation.assignedTo ? 'Unassign Agent' : 'Assign to Me'}
                         </DropdownMenuItem>
                         <DropdownMenuItem 
                           className="rounded-xl font-bold gap-3 cursor-pointer"
                           onClick={() => actionMutation.mutate({ action: 'resolve' })}
                         >
                           <CheckCircle className="h-4 w-4 text-emerald-500" /> Mark as Resolved
                         </DropdownMenuItem>
                         <DropdownMenuItem 
                            className="rounded-xl font-bold gap-3 cursor-pointer"
                            onClick={() => {
                                const until = new Date();
                                until.setHours(until.getHours() + 2);
                                actionMutation.mutate({ action: 'snooze', data: { until } });
                            }}
                         >
                            <Clock className="h-4 w-4 text-amber-500" /> Snooze (2h)
                         </DropdownMenuItem>
                         <DropdownMenuItem 
                            className="rounded-xl font-bold gap-3 cursor-pointer text-destructive"
                            onClick={() => actionMutation.mutate({ action: 'spam' })}
                         >
                           <ShieldAlert className="h-4 w-4" /> Mark as Spam
                         </DropdownMenuItem>
                       </DropdownMenuContent>
                    </DropdownMenu>
                </div>
              </div>

              {/* Messages Thread */}
              <div className="flex-1 relative overflow-hidden">
                <MessageThread 
                  messages={messages} 
                  isLoading={isMessagesLoading} 
                  currentUser={user} 
                  hasNextPage={hasNextPage}
                  isFetchingNextPage={isFetchingNextPage}
                  onLoadMore={() => fetchNextPage()}
                  onReact={(message, emoji) => sendMutation.mutate({
                    text: emoji,
                    isNote: false,
                    extraData: {
                      type: 'reaction',
                      reaction: {
                        messageId: message.whatsappMessageId || message._id,
                        emoji
                      }
                    }
                  })}
                />
              </div>

              {/* Chat Input */}
              <ChatInput 
                onSendMessage={(text, isNote, extraData) => {
                  if (!isNote && isSelectedWhatsAppSessionExpired) {
                    notifySessionExpired();
                    return;
                  }
                  sendMutation.mutate({ text, isNote, extraData });
                }}
                onSendMedia={(file) => {
                  if (isSelectedWhatsAppSessionExpired) {
                    notifySessionExpired();
                    return;
                  }
                  mediaMutation.mutate(file);
                }}
                isSending={sendMutation.isPending || mediaMutation.isPending}
                disabled={false}
                onTyping={() => socket?.emit('typing', {
                  conversationId: selectedConversation._id,
                  workspaceId: workspaceId || undefined,
                  isTyping: true
                })}
                channel={selectedConversation.channel}
              />
            </motion.div>
          ) : (
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex-1 flex flex-col items-center justify-center text-center p-12 space-y-6"
            >
              <div className="w-24 h-24 rounded-[40px] bg-primary/5 flex items-center justify-center shadow-premium-sm border border-primary/10">
                 <MessageSquare className="h-12 w-12 text-primary opacity-40" />
              </div>
              <div className="space-y-2">
                <h2 className="text-2xl font-black tracking-tight text-foreground">Select a conversation</h2>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto font-medium">Choose a chat from the sidebar to start messaging or managing your contacts.</p>
              </div>
              <Button onClick={() => { router.push('/contacts'); }} className="rounded-2xl h-12 px-8 font-black shadow-lg shadow-primary/20">
                <Plus className="h-5 w-5 mr-2" /> Start New Chat
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 3. Contact Details Sidebar */}
      <AnimatePresence>
        {selectedConversation && isDetailsOpen && (
          <motion.div 
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 340, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className="flex-shrink-0 h-full min-h-0 border-l border-border/50 bg-card/50 backdrop-blur-sm"
          >
            <ContactDetailsSidebar 
              contact={selectedConversation.contact}
              conversation={selectedConversation}
              agents={agents}
              teams={teams}
              onAssign={(agentId) => actionMutation.mutate({ action: 'assign', data: { agentId } })}
              onAssignTeam={(teamId) => actionMutation.mutate({ action: 'assignToTeam', data: { teamId } })}
              onUnassign={() => actionMutation.mutate({ action: 'unassign' })}
              notes={[]} // In real app, fetch from separate query or include in contact
              onAddTag={(tag) => toast.success(`Tag ${tag} added`)}
              onRemoveTag={(tag) => toast.success(`Tag ${tag} removed`)}
              onAddNote={(note) => toast.info('Note saved')}
              onSetLabel={(label) => actionMutation.mutate({ action: 'label', data: { label } })}
              pipelines={pipelines}
              isUpdating={actionMutation.isPending}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
