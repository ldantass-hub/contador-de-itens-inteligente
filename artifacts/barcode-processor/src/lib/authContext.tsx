import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";

const USER_KEY    = "lg_inv_user";
const SESSION_KEY = "lg_inv_session";
const LEGACY_TOKEN_KEY = "lg_inv_token";

export interface AuthUser {
  id: number;
  username: string;
  role: string;
  mustChangePassword?: boolean;
}

export interface AuthSession {
  id: number;
  user_id: number | null;
  operator_user_id: number;
  operator_username: string;
  organization: string | null;
  start_time: string;
  end_time: string | null;
  last_update: string;
  status: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  session: AuthSession | null;
  isAdmin: boolean;
  authReady: boolean;
  setAuth: (user: AuthUser, session: AuthSession) => void;
  updateSession: (session: AuthSession) => void;
  logout: () => Promise<void>;
  /** Sends the HttpOnly authentication cookie with the request. */
  fetchAuth: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function loadStored<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function clearStored() {
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(SESSION_KEY);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(() => loadStored<AuthSession>(SESSION_KEY));
  const [authReady, setAuthReady] = useState(false);

  const setAuth = useCallback((nextUser: AuthUser, nextSession: AuthSession) => {
    localStorage.setItem(USER_KEY, JSON.stringify(nextUser));
    localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
    setUser(nextUser);
    setSession(nextSession);
  }, []);

  const updateSession = useCallback((nextSession: AuthSession) => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
    setSession(nextSession);
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } finally {
      localStorage.removeItem(LEGACY_TOKEN_KEY);
      clearStored();
      setUser(null);
      setSession(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    localStorage.removeItem(LEGACY_TOKEN_KEY);

    fetch("/api/auth/me", { credentials: "include" })
      .then(async response => {
        if (!response.ok) throw new Error("Not authenticated");
        return response.json() as Promise<{ user: AuthUser }>;
      })
      .then(data => {
        if (!active) return;
        localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        setUser(data.user);
      })
      .catch(() => {
        if (!active) return;
        clearStored();
        setUser(null);
        setSession(null);
      })
      .finally(() => {
        if (active) setAuthReady(true);
      });

    return () => { active = false; };
  }, []);

  const fetchAuth = useCallback(async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    const response = await fetch(input, {
      ...init,
      headers,
      credentials: "include",
    });

    if (response.status === 401) {
      clearStored();
      setUser(null);
      setSession(null);
      window.location.replace("/login");
    }

    return response;
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      session,
      isAdmin: user?.role === "admin",
      authReady,
      setAuth,
      updateSession,
      logout,
      fetchAuth,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
