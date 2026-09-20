import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth, type AuthUser, type AuthSession } from "@/lib/authContext";

interface LoginResponse {
  token: string;
  user: AuthUser;
  session?: AuthSession;
  activeSession?: AuthSession;
  needsResume: boolean;
}

const ORGANIZATIONS = ["PC", "TV", "MEDIA", "ARCON", "MWO"] as const;
type Organization = (typeof ORGANIZATIONS)[number];

export default function Login() {
  const { setAuth } = useAuth();
  const [, navigate] = useLocation();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);

  const [pendingLogin, setPendingLogin] = useState<LoginResponse | null>(null);
  const [selectedOrganization, setSelectedOrganization] = useState<Organization | "">("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const resp = await fetch("/api/auth/login", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ username: username.trim(), password }),
      });

      const data = await resp.json() as LoginResponse & { error?: string };

      if (!resp.ok) {
        setError(data.error ?? "Erro ao entrar.");
        return;
      }

      setPendingLogin(data);
      const activeOrganization = data.activeSession?.organization;
      setSelectedOrganization(
        ORGANIZATIONS.includes(activeOrganization as Organization)
          ? activeOrganization as Organization
          : ""
      );
    } catch {
      setError("Erro de conexão com o servidor.");
    } finally {
      setLoading(false);
    }
  }

  async function handleOrganizationContinue(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingLogin) return;

    if (!selectedOrganization) {
      setError("Selecione uma organização para continuar.");
      return;
    }

    setLoading(true);

    try {
      const resp = await fetch("/api/sessions/select-organization", {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pendingLogin.token}`,
        },
        body: JSON.stringify({ organization: selectedOrganization }),
      });

      const data = await resp.json() as { session: AuthSession; error?: string };
      if (!resp.ok) {
        setError(data.error ?? "Erro ao configurar a organização.");
        return;
      }

      setAuth(pendingLogin.token, pendingLogin.user, data.session);
      navigate("/");
    } catch {
      setError("Erro de conexão com o servidor.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <path d="M16.5 9.4 7.55 4.24"/>
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            <polyline points="3.29 7 12 12 20.71 7"/>
            <line x1="12" y1="22" x2="12" y2="12"/>
          </svg>
        </div>
        <h1 className="login-title">Inventário LG</h1>
        <p className="login-subtitle">LG Electronics Brasil · 2026</p>

        {!pendingLogin ? (
          <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-field">
              <label htmlFor="username">Usuário</label>
              <input
                id="username"
                type="text"
                inputMode="text"
                enterKeyHint="next"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="Digite seu usuário"
                disabled={loading}
              />
            </div>
            <div className="login-field">
              <label htmlFor="password">Senha</label>
                <div className="password-input-wrapper">
                  <input
                    id="password"
                    className="password-input"
                    type={showPassword ? "text" : "password"}
                    enterKeyHint="go"
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Digite sua senha"
                    disabled={loading}
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword(value => !value)}
                    disabled={loading}
                  >
                    {showPassword ? (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                        fill="none" stroke="currentColor" strokeWidth="2"
                        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 3l18 18"/>
                        <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/>
                        <path d="M9.9 4.2A10.8 10.8 0 0 1 12 4c5 0 8.5 4 9.5 8a11.8 11.8 0 0 1-2.1 4.1"/>
                        <path d="M6.6 6.6C4.4 8 3.1 10.2 2.5 12c1 4 4.5 8 9.5 8 1.4 0 2.7-.3 3.9-.8"/>
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                        fill="none" stroke="currentColor" strokeWidth="2"
                        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M2.5 12s3.5-8 9.5-8 9.5 8 9.5 8-3.5 8-9.5 8-9.5-8-9.5-8Z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                    )}
                  </button>
                </div>
            </div>

            {error && <div className="login-error">{error}</div>}

            <button
              type="submit"
              className="app-btn app-btn-primary login-submit"
              disabled={loading || !username.trim() || !password}
            >
              {loading ? "Entrando..." : "Entrar"}
            </button>
          </form>
        ) : (
          <form className="login-form organization-form" onSubmit={handleOrganizationContinue}>
            <h2 className="modal-title">Qual Organização você deseja inventariar?</h2>
            {pendingLogin.activeSession?.organization && (
              <p className="modal-body">
                A sessão ativa pertence à organização{" "}
                <strong>{pendingLogin.activeSession.organization}</strong>.
                Para mudar de organização, finalize a sessão atual antes de iniciar outra.
              </p>
            )}
            <div className="organization-options" role="radiogroup" aria-label="Organização">
              {ORGANIZATIONS.map(organization => {
                const locked =
                  Boolean(pendingLogin.activeSession?.organization) &&
                  pendingLogin.activeSession?.organization !== organization;
                return (
                  <label
                    key={organization}
                    className={`organization-option${selectedOrganization === organization ? " selected" : ""}${locked ? " disabled" : ""}`}
                  >
                    <input
                      type="radio"
                      name="organization"
                      value={organization}
                      checked={selectedOrganization === organization}
                      disabled={loading || locked}
                      onChange={() => {
                        setSelectedOrganization(organization);
                        setError("");
                      }}
                    />
                    <span>{organization}</span>
                  </label>
                );
              })}
            </div>

            {error && <div className="login-error">{error}</div>}

            <button
              type="submit"
              className="app-btn app-btn-primary login-submit"
              disabled={loading}
            >
              {loading ? "Configurando..." : "Continuar"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
