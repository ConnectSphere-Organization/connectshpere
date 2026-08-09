"use client";

import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/store/auth-store';
import { config as appConfig } from '@/lib/config';

/**
 * SINGLETON SOCKET INSTANCE
 * Ensures one connection across the entire dashboard
 */
let globalSocket: Socket | null = null;
let connectionPromise: Promise<Socket> | null = null;

/**
 * Disconnect the shared singleton socket. Call this on logout so the next
 * user does not inherit the previous user's socket / room subscriptions.
 */
export function disconnectGlobalSocket() {
  if (globalSocket) {
    try {
      globalSocket.removeAllListeners();
      globalSocket.disconnect();
    } catch (err) {
      console.warn('[Socket:Singleton] Error during disconnect:', err);
    }
  }
  globalSocket = null;
  connectionPromise = null;
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem('socket_auth_token');
  }
}

interface SocketOptions {
  workspaceId?: string;
  conversationId?: string;
}

const normalizeRoomId = (value: unknown): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const maybeId = (value as any)?._id;
    if (typeof maybeId === 'string') return maybeId;
  }

  if (typeof (value as any)?.toString === 'function') {
    const normalized = (value as any).toString();
    if (normalized && normalized !== '[object Object]') return normalized;
  }

  return null;
};

import { getSessionData } from '@/lib/api/auth';

const getSocket = async (): Promise<Socket> => {
  // If already connected, return it
  if (globalSocket?.connected) return globalSocket;
  // If connection is in progress, return the existing promise
  if (connectionPromise) return connectionPromise;

  connectionPromise = new Promise(async (resolve, reject) => {
    const socketBase = appConfig.socketUrl;

    // Try to get token from multiple sources
    let token: string | null = null;

    // Source 1: SessionStorage (stored during login)
    if (typeof sessionStorage !== 'undefined') {
      token = sessionStorage.getItem('socket_auth_token');
      if (token) console.log('[Socket:Singleton] 🔐 Found token in sessionStorage');
    }

    // Source 2: Try to read from auth_token cookie (accessible)
    if (!token && typeof document !== 'undefined') {
      const allCookies = document.cookie;
      const cookieArray = allCookies.split(';');
      const authCookie = cookieArray.find(row => row.trim().startsWith('auth_token='));
      token = authCookie ? authCookie.split('=')[1]?.trim() : null;
      if (token) console.log('[Socket:Singleton] 🍪 Found auth_token cookie');
    }

    // Source 3: Fetch fresh token from session endpoint if not found.
    // Note: Next.js rewrites `/api/:path*` → `/api/v1/:path*`, so this URL
    // must NOT include `/v1` itself or the backend host will see `/v1/v1`.
    if (!token) {
      try {
        console.log('[Socket:Singleton] Token not found locally, fetching from session endpoint...');
        const session = await getSessionData();
        token = session?.token;
        if (token) {
          console.log('[Socket:Singleton] Got token from session endpoint');
          if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem('socket_auth_token', token);
          }
        }
      } catch (err) {
        console.warn('[Socket:Singleton] Could not fetch token from session:', err);
      }
    }

    console.log('[Socket:Singleton] 🌐 Connecting to:', socketBase || 'current origin');
    if (token) {
      console.log('[Socket:Singleton] 🔑 Found auth token (Length: ' + token.length + ')');
    } else {
      console.warn('[Socket:Singleton] ⚠️ No auth token available. Will attempt connection with withCredentials.');
    }

    const socket = io(socketBase || undefined, {
      auth: { token },
      withCredentials: true,
      transports: ['websocket', 'polling'],
      upgrade: true,
      tryAllTransports: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socket.on('connect', () => {
      // console.log('%c[Socket:Singleton] Connected:', 'color: #00ff00; font-weight: bold;', socket.id);
      globalSocket = socket;
      connectionPromise = null;
      resolve(socket);
    });

    socket.on('connect_error', (err) => {
      // ONLY reject if it's a fatal authentication error from the server
      const message = err.message || '';
      const isFatalAuthError =
        message.toLowerCase().includes('unauthorized') ||
        message.toLowerCase().includes('authentication') ||
        message.toLowerCase().includes('token');

      if (isFatalAuthError) {
        console.error('[Socket:Singleton] ❌ FATAL AUTH ERROR:', err.message);
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.removeItem('socket_auth_token');
        }
        try {
          socket.removeAllListeners();
          socket.disconnect();
        } catch {}
        globalSocket = null;
        connectionPromise = null;
        reject(err);
      } else {
        // Log but don't reject yet, let it retry/fallback
        console.warn('[Socket:Singleton] 🔄 Connection Attempt Error (Retrying...):', err.message);
      }
    });

    socket.on('disconnect', (reason) => {
      console.warn('[Socket:Singleton] Disconnected:', reason);
      if (reason === 'io server disconnect') {
        // the disconnection was initiated by the server, you need to reconnect manually
        socket.connect();
      }
    });
  });

  return connectionPromise;
};

export const useSocket = (options: SocketOptions = {}) => {
  const { user, authenticated } = useAuthStore();
  const [socket, setSocket] = useState<Socket | null>(globalSocket);
  const [isConnected, setIsConnected] = useState(globalSocket?.connected || false);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // Initialize/Retrieve Connection.
  //
  // The previous version returned a cleanup function from inside the inner
  // async `init()` instead of from `useEffect` itself, so listeners were
  // never removed when `authenticated`/`user` changed and they accumulated
  // on every render. Track the registered handlers in a closure-scoped ref
  // and unregister them in the effect's cleanup.
  useEffect(() => {
    if (!authenticated || !user) return;

    let activeSocket: Socket | null = null;
    let onConnect: (() => void) | null = null;
    let onDisconnect: (() => void) | null = null;

    (async () => {
      try {
        const s = await getSocket();
        if (!isMounted.current) return;

        activeSocket = s;
        setSocket(s);
        setIsConnected(s.connected);

        onConnect = () => {
          if (isMounted.current) setIsConnected(true);
        };
        onDisconnect = () => {
          if (isMounted.current) setIsConnected(false);
        };

        s.on('connect', onConnect);
        s.on('disconnect', onDisconnect);
      } catch (err) {
        console.error('[useSocket] Initialization failed:', err);
      }
    })();

    return () => {
      if (activeSocket) {
        if (onConnect) activeSocket.off('connect', onConnect);
        if (onDisconnect) activeSocket.off('disconnect', onDisconnect);
      }
    };
  }, [authenticated, user]);

  // Handle Room Subscriptions (Robust Multi-Registration)
  useEffect(() => {
    if (!socket || !isConnected) return;

    const workspaceId = normalizeRoomId(options.workspaceId);
    const conversationId = normalizeRoomId(options.conversationId);

    const workspaceRoom = workspaceId ? `workspace:${workspaceId}` : null;
    const conversationRoom = conversationId ? `conversation:${conversationId}` : null;

    if (workspaceRoom) {
      // console.log(`%c[Socket:Singleton] Joining Workspace: ${workspaceRoom}`, 'color: #ea580c; font-weight: bold;');
      socket.emit('workspace:join', { workspaceId });
    }

    if (conversationRoom) {
      // console.log(`%c[Socket:Singleton] Joining Conversation: ${conversationRoom}`, 'color: #0891b2; font-weight: bold;');
      socket.emit('conversation:join', { conversationId, workspaceId });
      
      return () => {
        console.log(`[Socket:Singleton] Leaving Conversation: ${conversationRoom}`);
        socket.emit('conversation:leave', { conversationId });
      };
    }
  }, [socket, isConnected, options.workspaceId, options.conversationId]);

  return {
    socket,
    isConnected
  };
};
