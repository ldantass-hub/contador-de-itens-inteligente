import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

const TOKEN_KEY   = "lg_inv_token";
const USER_KEY    = "lg_inv_user";
const SESSION_KEY = "lg_inv_session";

export interface AuthUser {
  id: number;
  username: string;
  role: string;
}

export interface AuthSession {
  id: number;
  user_id: number;
  organization: string | null;
  start_time: string;
  end_time: string | null;
  last_update: string;
  status: string;
}

interface AuthContextValue {
  token: string | null;
  user: AuthUser | null;
  session: AuthSession | null;
  isAdmin: boolean;
  setAuth: (token: string, user: AuthUser, session: AuthSession) => void;
  updateSession: (session: AuthSession) => void;
  logout: () => void;
  authHeader: () => Record<string, string>;
  /**
   * Authenticated fetch wrapper.
   *
   * Automatically injects the Bearer token header.
   * If the server responds with 401 (token expired / invalid), the stored
   * credentials are cleared and the user is redirected to /login so they
   * can authenticate again — instead of receiving a silent save error.
   *
   * Usage: identical to the native `fetch` API, but without needing to add
   * the Authorization header manually.
   */
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
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(SESSION_KEY);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token,   setToken]   = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [user,    setUser]    = useState<AuthUser | null>(() => loadStored<AuthUser>(USER_KEY));
  const [session, setSession] = useState<AuthSession | null>(() => loadStored<AuthSession>(SESSION_KEY));

  const setAuth = useCallback((t: string, u: AuthUser, s: AuthSession) => {
    localStorage.setItem(TOKEN_KEY,   t);
    localStorage.setItem(USER_KEY,    JSON.stringify(u));
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    setToken(t);
    setUser(u);
    setSession(s);
  }, []);

  const updateSession = useCallback((s: AuthSession) => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    setSession(s);
  }, []);

  const logout = useCallback(() => {
    clearStored();
    setToken(null);
    setUser(null);
    setSession(null);
  }, []);

  const authHeader = useCallback((): Record<string, string> => {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [token]);

  /**
   * Authenticated fetch — injects the token and handles token expiry.
   *
   * On 401: clear stored credentials and redirect to /login.
   * On any other response: return the response as-is so callers can
   * inspect status codes and body normally.
   */
  const fetchAuth = useCallback(async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    const response = await fetch(input, { ...init, headers });

    if (response.status === 401) {
      /*
       * Token is expired or was signed with a different secret.
       * Clear local state and force re-login so the user gets a fresh token
       * rather than seeing an opaque "Não foi possível salvar" error.
       */
      clearStored();
      setToken(null);
      setUser(null);
      setSession(null);
      /* Hard-navigate so the Router re-mounts with clean state */
      window.location.replace("/login");
    }

    return response;
  }, [token]);

  return (
    <AuthContext.Provider value={{
      token,
      user,
      session,
      isAdmin: user?.role === "admin",
      setAuth,
      updateSession,
      logout,
      authHeader,
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
