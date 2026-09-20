import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/authContext";

interface AdminSession {
  id: number;
  username: string;
  organization: string | null;
  start_time: string;
  end_time: string | null;
  last_update: string;
  status: string;
  total_quantity: number;
}

interface SessionCount {
  code: string;
  quantity: number;
}

interface AdminUser {
  id: number;
  username: string;
  role: string;
}

export default function Admin() {
  const { user, isAdmin, fetchAuth, logout } = useAuth();
  const [, navigate] = useLocation();

  const [sessions,       setSessions]       = useState<AdminSession[]>([]);
  const [users,          setUsers]          = useState<AdminUser[]>([]);
  const [detailSession,  setDetailSession]  = useState<AdminSession | null>(null);
  const [detailCounts,   setDetailCounts]   = useState<SessionCount[]>([]);
  const [filterUser,     setFilterUser]     = useState("");
  const [filterStatus,   setFilterStatus]   = useState("");
  const [filterOrganization, setFilterOrganization] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo,   setFilterDateTo]   = useState("");
  const [loading,        setLoading]        = useState(false);
  const [error,          setError]          = useState("");

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (filterUser)     params.set("userId",   filterUser);
      if (filterStatus)   params.set("status",   filterStatus);
      if (filterOrganization) params.set("organization", filterOrganization);
      if (filterDateFrom) params.set("dateFrom", filterDateFrom);
      if (filterDateTo)   params.set("dateTo",   filterDateTo);

      const resp = await fetchAuth(`/api/admin/sessions?${params}`);
      if (!resp.ok) throw new Error();
      setSessions(await resp.json() as AdminSession[]);
    } catch {
      setError("Erro ao carregar sessões.");
    } finally {
      setLoading(false);
    }
  }, [filterUser, filterStatus, filterOrganization, filterDateFrom, filterDateTo, fetchAuth]);

  useEffect(() => {
    if (!isAdmin) { navigate("/"); return; }

    fetchAuth("/api/admin/users")
      .then(r => r.json())
      .then(data => setUsers(data as AdminUser[]))
      .catch(() => {});

    fetchSessions();
  }, [isAdmin]);

  async function fetchDetail(session: AdminSession) {
    setDetailSession(session);
    try {
      const resp = await fetchAuth(`/api/admin/sessions/${session.id}`);
      const data = await resp.json() as { counts: SessionCount[] };
      setDetailCounts(data.counts);
    } catch {
      setDetailCounts([]);
    }
  }

  function exportSession(id: number) {
    fetchAuth(`/api/admin/sessions/${id}/export`)
      .then(r => r.blob())
      .then(blob => {
        const objUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objUrl;
        link.download = `sessao_${id}.xlsx`;
        link.click();
        URL.revokeObjectURL(objUrl);
      });
  }

  function fmtDate(dt: string | null): string {
    if (!dt) return "—";
    return new Date(dt + (dt.endsWith("Z") ? "" : "Z")).toLocaleString("pt-BR");
  }

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header-left">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16.5 9.4 7.55 4.24"/>
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            <polyline points="3.29 7 12 12 20.71 7"/>
            <line x1="12" y1="22" x2="12" y2="12"/>
          </svg>
          <div>
            <h1>Painel do Supervisor</h1>
            <p className="admin-subtitle">LG Electronics Brasil · 2026</p>
          </div>
        </div>
        <div className="admin-header-right">
          <span className="admin-user-badge">{user?.username}</span>
          <button className="app-btn app-btn-outline app-btn-sm" onClick={() => navigate("/")}>
            Voltar
          </button>
          <button className="app-btn app-btn-outline app-btn-sm" onClick={() => { logout(); navigate("/login"); }}>
            Sair
          </button>
        </div>
      </header>

      <div className="admin-body">

        {/* ── Filters ─────────────────────────────────────────────── */}
        <div className="app-card admin-filters">
          <div className="filters-row">
            <div className="filter-group">
              <label>Usuário</label>
              <select value={filterUser} onChange={e => setFilterUser(e.target.value)}>
                <option value="">Todos</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.username}</option>
                ))}
              </select>
            </div>
            <div className="filter-group">
              <label>Status</label>
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                <option value="">Todos</option>
                <option value="active">Ativa</option>
                <option value="finished">Finalizada</option>
              </select>
            </div>
            <div className="filter-group">
              <label>Organização</label>
              <select value={filterOrganization} onChange={e => setFilterOrganization(e.target.value)}>
                <option value="">Todas</option>
                <option value="PC">PC</option>
                <option value="TV">TV</option>
                <option value="MEDIA">MEDIA</option>
                <option value="ARCON">ARCON</option>
                <option value="MWO">MWO</option>
              </select>
            </div>
            <div className="filter-group">
              <label>De</label>
              <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} />
            </div>
            <div className="filter-group">
              <label>Até</label>
              <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} />
            </div>
            <button className="app-btn app-btn-primary app-btn-sm" onClick={fetchSessions}>
              Filtrar
            </button>
          </div>
        </div>

        {error && <div className="admin-error">{error}</div>}

        <div className="admin-main-grid">

          {/* ── Sessions Table ───────────────────────────────────── */}
          <div className="app-card sessions-card">
            <div className="compare-header">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                <line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="8" y1="2" x2="8" y2="6"/>
                <line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
              Sessões ({sessions.length})
            </div>
            {loading ? (
              <div className="admin-loading">Carregando...</div>
            ) : (
              <div className="compare-body">
                <table className="compare-table admin-sessions-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Usuário</th>
                      <th>Organização</th>
                      <th>Início</th>
                      <th>Fim</th>
                      <th className="text-right">Qtd. Total</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.length === 0 ? (
                      <tr><td colSpan={8} className="admin-empty">Nenhuma sessão encontrada.</td></tr>
                    ) : sessions.map(s => (
                      <tr
                        key={s.id}
                        className={`admin-session-row${detailSession?.id === s.id ? " admin-session-selected" : ""}`}
                        onClick={() => fetchDetail(s)}
                        style={{ cursor: "pointer" }}
                      >
                        <td className="mono">#{s.id}</td>
                        <td>{s.username}</td>
                        <td>{s.organization ?? "Não informada"}</td>
                        <td className="mono">{fmtDate(s.start_time)}</td>
                        <td className="mono">{fmtDate(s.end_time)}</td>
                        <td className="mono text-right">{s.total_quantity.toLocaleString("pt-BR")}</td>
                        <td>
                          <span className={`status-badge status-${s.status}`}>
                            {s.status === "active" ? "Ativa" : "Finalizada"}
                          </span>
                        </td>
                        <td>
                          <button
                            className="app-btn app-btn-secondary app-btn-sm"
                            onClick={e => { e.stopPropagation(); exportSession(s.id); }}
                          >
                            Exportar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Detail Panel ──────────────────────────────────────── */}
          {detailSession && (
            <div className="app-card detail-card">
              <div className="compare-header">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="8" y1="6" x2="21" y2="6"/>
                  <line x1="8" y1="12" x2="21" y2="12"/>
                  <line x1="8" y1="18" x2="21" y2="18"/>
                  <line x1="3" y1="6" x2="3.01" y2="6"/>
                  <line x1="3" y1="12" x2="3.01" y2="12"/>
                  <line x1="3" y1="18" x2="3.01" y2="18"/>
                </svg>
                 Detalhe — Sessão #{detailSession.id} ({detailSession.username}) · Organização: {detailSession.organization ?? "Não informada"}
              </div>
              <div className="compare-body">
                <table className="compare-table">
                  <thead>
                    <tr>
                      <th>CÓDIGO</th>
                      <th className="text-right">QUANTIDADE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailCounts.length === 0 ? (
                      <tr><td colSpan={2} className="admin-empty">Nenhum item nesta sessão.</td></tr>
                    ) : detailCounts.map(c => (
                      <tr key={c.code}>
                        <td className="mono">{c.code}</td>
                        <td className="mono text-right">{c.quantity.toLocaleString("pt-BR")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <footer className="app-footer">
        Lael Henrique Campos Dantas — LG Electronics Brasil Ltda · 2026
      </footer>
    </div>
  );
}
