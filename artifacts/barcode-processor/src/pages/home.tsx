import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { processInput, type ProcessResult } from "@/lib/barcodeProcessor";
import { useAuth } from "@/lib/authContext";

const API = "/api/estoque";
const SESSIONS_API = "/api/sessions";

interface ItemEntry {
  id: string;
  raw: string;
  code: string | null;
  quantity: number | null;
  timestamp: Date;
  isError: boolean;
  log: string;
}

interface Toast {
  id: string;
  title: string;
  desc: string;
  type: "error" | "success" | "info";
}

interface CompareRow {
  item: string;
  contado: number;
  esperado: number;
  diferenca: number;
  sinal: string;
}

interface PreviewRow {
  code:      string;
  quantity:  number;
  esperado:  number | null;
  diferenca: number | null;
  sinal:     string | null;
}

function parseLogEntry(log: string): { code: string | null; quantity: number | null } {
  const codeMatch = log.match(/Codigo="([^"]+)"/);
  const qtyMatch  = log.match(/Quantidade=(\d+)/);
  return {
    code:     codeMatch ? codeMatch[1] : null,
    quantity: qtyMatch  ? parseInt(qtyMatch[1], 10) : null,
  };
}

export default function Home() {
  const { user, session, isAdmin, authHeader, fetchAuth, logout } = useAuth();
  const [, navigate] = useLocation();
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  const [rawLines,     setRawLines]     = useState<string[]>([]);
  const [items,        setItems]        = useState<ItemEntry[]>([]);
  const [inputValue,   setInputValue]   = useState("");
  const [hasResult,    setHasResult]    = useState(false);
  const [result,       setResult]       = useState<ProcessResult | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSalvando,   setIsSalvando]   = useState(false);
  const [savedOk,      setSavedOk]      = useState(false);
  const [toasts,       setToasts]       = useState<Toast[]>([]);
  const [compareRows,  setCompareRows]  = useState<CompareRow[] | null>(null);
  const [excelLoaded,  setExcelLoaded]  = useState(false);
  const [excelRows,    setExcelRows]    = useState(0);
  const [isComparing,       setIsComparing]       = useState(false);
  const [showPreview,       setShowPreview]       = useState(false);
  const [previewRows,       setPreviewRows]       = useState<PreviewRow[]>([]);
  const [previewHasComp,    setPreviewHasComp]    = useState(false);
  const [previewOrganization, setPreviewOrganization] = useState<string | null>(null);
  const [isLoadingPreview,  setIsLoadingPreview]  = useState(false);
  const previewExportUrl    = useRef<string>("");
  const scanInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const liveResult   = rawLines.length > 0 ? processInput(rawLines.join("\n")) : null;
  const runningTotal = liveResult?.total ?? 0;

  const hdr = () => ({ ...authHeader(), "Content-Type": "application/json" });

  function closePasswordModal() {
    setShowPasswordModal(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmNewPassword("");
    setPasswordError("");
    setPasswordSuccess("");
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError("");
    setPasswordSuccess("");

    if (!currentPassword || !newPassword || !confirmNewPassword) {
      setPasswordError("Preencha todos os campos de senha.");
      return;
    }
    if (newPassword.length < 12) {
      setPasswordError("A nova senha deve ter no mínimo 12 caracteres.");
      return;
    }
    if (newPassword.length > 200 || currentPassword.length > 200 || confirmNewPassword.length > 200) {
      setPasswordError("A senha excede o limite permitido.");
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError("A confirmação da nova senha não confere.");
      return;
    }

    setIsChangingPassword(true);
    try {
      const response = await fetchAuth("/api/auth/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword: confirmNewPassword }),
      });
      const data = await response.json() as { message?: string; error?: string };
      if (!response.ok) {
        setPasswordError(data.error ?? "Não foi possível alterar a senha.");
        return;
      }
      setPasswordSuccess(data.message ?? "Senha alterada com sucesso.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      setTimeout(closePasswordModal, 900);
    } catch {
      setPasswordError("Erro de conexão com o servidor.");
    } finally {
      setIsChangingPassword(false);
    }
  }

  /* Ping the server on every scan to update last_update */
  function pingSession() {
    if (!session) return;
    fetchAuth(`${SESSIONS_API}/ping`, { method: "PUT" }).catch(() => {});
  }

  function showToast(title: string, desc: string, type: Toast["type"] = "error") {
    const id = Date.now().toString() + Math.random().toString(36).slice(2);
    setToasts(prev => [...prev, { id, title, desc, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }

  function handleScan(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;

    const newLines  = [...rawLines, trimmed];
    const newResult = processInput(newLines.join("\n"));
    const lastLog   = newResult.logs[newResult.logs.length - 1] ?? "";
    const isError   = lastLog.includes("Erro:");

    if (isError) {
      const errMsg = lastLog.split(": ").slice(2).join(": ") || lastLog;
      showToast("Linha ignorada", errMsg, "error");
    }

    const parsed = parseLogEntry(lastLog);
    const item: ItemEntry = {
      id:        Date.now().toString() + "-" + Math.random().toString(36).slice(2),
      raw:       trimmed,
      code:      parsed.code ?? newResult.activeCode ?? trimmed,
      quantity:  parsed.quantity,
      timestamp: new Date(),
      isError,
      log:       lastLog,
    };

    setRawLines(newLines);
    setItems(prev => [item, ...prev]);
    setInputValue("");
    setTimeout(() => scanInputRef.current?.focus(), 0);

    /* Update session last_update in background */
    pingSession();
  }

  async function handleFinalizar() {
    if (rawLines.length === 0 || hasResult) return;
    setIsProcessing(true);

    await new Promise(r => setTimeout(r, 400));

    const finalResult = processInput(rawLines.join("\n"));

    if (!finalResult.activeCode && finalResult.total === 0) {
      showToast("Erro ao processar", "Nenhuma linha válida encontrada.", "error");
      setIsProcessing(false);
      return;
    }

    setResult(finalResult);
    setHasResult(true);
    setIsProcessing(false);
  }

  async function handleSalvarNoBanco() {
    if (!result || !session || savedOk) return;
    const errorLogs = result.logs.filter(l => l.includes("Erro:"));
    setIsSalvando(true);
    try {
      const resp = await fetchAuth(`${SESSIONS_API}/salvar`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          sessionId:   session.id,
          codigo:      result.activeCode,
          total:       result.total,
          ignoredLogs: errorLogs,
        }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      setSavedOk(true);
      showToast("Item salvo", `${result.activeCode} · ${result.total.toLocaleString("pt-BR")} un — registrado na sessão #${session.id}.`, "success");
    } catch {
      showToast("Erro ao salvar", "Não foi possível salvar no banco de dados.", "error");
    } finally {
      setIsSalvando(false);
    }
  }

  function handleLimpar() {
    setRawLines([]);
    setItems([]);
    setInputValue("");
    setHasResult(false);
    setResult(null);
    setSavedOk(false);
    setCompareRows(null);
    setTimeout(() => scanInputRef.current?.focus(), 0);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("planilha", file);

    try {
      const resp = await fetchAuth(`${API}/upload`, {
        method: "POST",
        body:   formData,
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json() as { rows: number };
      setExcelLoaded(true);
      setExcelRows(data.rows);
      setCompareRows(null);
      showToast("Planilha importada", `${data.rows} itens carregados.`, "success");
    } catch {
      showToast("Erro ao importar", "Verifique o formato da planilha (ITEM | QUANTIDADE).", "error");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleComparar() {
    setIsComparing(true);
    try {
      const url = session
        ? `${API}/comparar?sessionId=${session.id}`
        : `${API}/comparar`;
      const resp = await fetchAuth(url);
      if (!resp.ok) throw new Error(await resp.text());
      const rows = await resp.json() as CompareRow[];
      setCompareRows(rows);
    } catch {
      showToast("Erro ao comparar", "Importe uma planilha primeiro.", "error");
    } finally {
      setIsComparing(false);
    }
  }

  async function handleExportar() {
    const qs = session ? `?sessionId=${session.id}` : "";
    previewExportUrl.current = `${API}/exportar${qs}`;
    setIsLoadingPreview(true);
    try {
      const resp = await fetchAuth(`${API}/preview-exportar${qs}`);
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json() as {
        hasComparison: boolean;
        organization: string | null;
        rows: PreviewRow[];
      };
      setPreviewRows(data.rows);
      setPreviewHasComp(data.hasComparison);
      setPreviewOrganization(data.organization);
      setShowPreview(true);
    } catch {
      showToast("Erro", "Não foi possível carregar os dados para prévia.", "error");
    } finally {
      setIsLoadingPreview(false);
    }
  }

  function handleConfirmarExportacao() {
    setShowPreview(false);
    fetchAuth(previewExportUrl.current)
      .then(r => r.blob())
      .then(blob => {
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = "resultado.xlsx";
        a.click();
        URL.revokeObjectURL(objUrl);
      })
      .catch(() => showToast("Erro ao exportar", "Não foi possível gerar o arquivo Excel.", "error"));
  }

  function handleLogout() {
    logout();
    navigate("/login");
  }

  async function handleEncerrarSessao() {
    if (!session || !window.confirm(
      "A sessão atual será finalizada. Para inventariar outra organização, será necessário iniciar uma nova sessão. Deseja continuar?"
    )) {
      return;
    }

    try {
      const resp = await fetchAuth(`${SESSIONS_API}/encerrar`, { method: "POST" });
      if (!resp.ok) throw new Error(await resp.text());
      logout();
      navigate("/login");
    } catch {
      showToast("Erro ao finalizar", "Não foi possível finalizar a sessão atual.", "error");
    }
  }

  const finalizarDisabled = items.length === 0 || hasResult || isProcessing;
  const limparDisabled    = items.length === 0 && !hasResult;

  const sessionStart = session
    ? new Date(session.start_time + (session.start_time.endsWith("Z") ? "" : "Z")).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div
      className="app-container"
      onClick={(e) => {
        const tag = (e.target as HTMLElement).tagName.toUpperCase();
        if (!hasResult && tag !== "BUTTON" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "LABEL" && tag !== "SELECT") {
          scanInputRef.current?.focus();
        }
      }}
    >
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="app-header">
        <div className="header-title">
          <svg className="icon-package" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16.5 9.4 7.55 4.24"/>
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            <polyline points="3.29 7 12 12 20.71 7"/>
            <line x1="12" y1="22" x2="12" y2="12"/>
          </svg>
          <div>
            <h1>Inventário de Códigos</h1>
            <p className="app-subtitle">
              Insira o formato <code>CÓDIGO;QUANTIDADE</code>
            </p>
          </div>
        </div>

        <div className="header-right">
          {user && (
            <div className="header-user-info">
              {sessionStart && (
                <span className="session-info">
                  Sessão #{session!.id} · iniciada às {sessionStart}
                </span>
              )}
              <span className="session-info">
                Organização atual: {session?.organization ?? "Não informada"}
              </span>
              <span className="user-chip">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                  <circle cx="12" cy="7" r="4"/>
                </svg>
                {user.username}
              </span>
              {isAdmin && (
                <button className="app-btn app-btn-outline app-btn-sm" onClick={() => navigate("/admin")}>
                  Supervisor
                </button>
              )}
              <button
                className="app-btn app-btn-outline app-btn-sm"
                onClick={() => {
                  setPasswordError("");
                  setPasswordSuccess("");
                  setShowPasswordModal(true);
                }}
              >
                Alterar senha
              </button>
              <button className="app-btn app-btn-outline app-btn-sm" onClick={handleLogout}>
                Sair
              </button>
              {session && (
                <button className="app-btn app-btn-outline app-btn-sm" onClick={handleEncerrarSessao}>
                  Finalizar sessão
                </button>
              )}
            </div>
          )}
          <div className="total-badge">
            <span className="total-label">Total Acumulado</span>
            <div className="total-value">
              <span className="running-total-num">{runningTotal.toLocaleString("pt-BR")}</span>
              <span className="total-unit">un</span>
            </div>
          </div>
        </div>
      </header>

      {showPasswordModal && (
        <div className="modal-overlay" role="presentation" onMouseDown={e => {
          if (e.target === e.currentTarget && !isChangingPassword) closePasswordModal();
        }}>
          <form className="modal-card password-modal-card" onSubmit={handleChangePassword}>
            <h2 className="modal-title">Alterar senha</h2>
            <div className="login-field">
              <label htmlFor="current-password">Senha atual</label>
              <input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                disabled={isChangingPassword}
              />
            </div>
            <div className="login-field">
              <label htmlFor="new-password">Nova senha</label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                disabled={isChangingPassword}
              />
            </div>
            <div className="login-field">
              <label htmlFor="confirm-new-password">Confirmar nova senha</label>
              <input
                id="confirm-new-password"
                type="password"
                autoComplete="new-password"
                value={confirmNewPassword}
                onChange={e => setConfirmNewPassword(e.target.value)}
                disabled={isChangingPassword}
              />
            </div>
            {passwordError && <div className="admin-error">{passwordError}</div>}
            {passwordSuccess && <div className="admin-success">{passwordSuccess}</div>}
            <div className="modal-actions">
              <button className="app-btn app-btn-outline" type="button" onClick={closePasswordModal} disabled={isChangingPassword}>
                Cancelar
              </button>
              <button className="app-btn app-btn-primary" type="submit" disabled={isChangingPassword}>
                {isChangingPassword ? "Alterando..." : "Alterar senha"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Main Grid ──────────────────────────────────────────── */}
      <div className="main-grid">

        {/* ── Left Column ──────────────────────────────────────── */}
        <div className="left-col">

          {/* Scanner Card */}
          <div className="app-card scanner-card">
            <div className="scanner-bar" />
            <div className="scanner-status">
              <span className="status-dot" />
              <span className="status-label">Entrada de Dados</span>
            </div>
            <div className="scan-input-wrapper">
              <svg className="scan-input-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
                <path d="M17 3h2a2 2 0 0 1 2 2v2"/>
                <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
                <path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
                <line x1="7" y1="12" x2="7" y2="12"/>
                <line x1="12" y1="12" x2="12" y2="12"/>
                <line x1="17" y1="12" x2="17" y2="12"/>
              </svg>
              <input
                ref={scanInputRef}
                id="scan-input"
                type="text"
                inputMode="text"
                enterKeyHint="done"
                placeholder="Aguardando leitura do leitor..."
                autoComplete="off"
                spellCheck={false}
                autoFocus
                disabled={hasResult}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleScan(inputValue);
                  }
                }}
              />
              {inputValue.trim() && (
                <span className="enter-hint">Pressione Enter</span>
              )}
            </div>
            <p className="waiting-msg">
              {hasResult
                ? savedOk
                  ? "Item registrado na sessão."
                  : "Pronto para salvar — clique em \"Salvar no banco\"."
                : "Aguardando leitura..."}
            </p>
          </div>

          {/* Actions Card */}
          <div className="app-card actions-card">
            <button className="app-btn app-btn-primary" disabled={finalizarDisabled} onClick={handleFinalizar}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
              {isProcessing ? "Processando..." : "Finalizar Operação"}
            </button>

            {hasResult && !savedOk && (
              <button className="app-btn app-btn-save" disabled={isSalvando} onClick={handleSalvarNoBanco}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                  <polyline points="17 21 17 13 7 13 7 21"/>
                  <polyline points="7 3 7 8 15 8"/>
                </svg>
                {isSalvando ? "Salvando..." : "Salvar no banco"}
              </button>
            )}

            <button className="app-btn app-btn-outline" disabled={limparDisabled} onClick={handleLimpar}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10"/>
                <path d="M3.51 15a9 9 0 1 0 .49-3.68"/>
              </svg>
              {hasResult ? "Nova Operação" : "Limpar Dados"}
            </button>

            <div className="actions-divider" />

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: "none" }}
              onChange={handleUpload}
            />

            <button
              className="app-btn app-btn-secondary"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              {excelLoaded ? `Planilha carregada (${excelRows} itens)` : "Importar Planilha"}
            </button>

            <button
              className="app-btn app-btn-secondary"
              disabled={!excelLoaded || isComparing}
              onClick={handleComparar}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10"/>
                <line x1="12" y1="20" x2="12" y2="4"/>
                <line x1="6"  y1="20" x2="6"  y2="14"/>
              </svg>
              {isComparing ? "Comparando..." : "Comparar Dados"}
            </button>

            <button className="app-btn app-btn-secondary" disabled={isLoadingPreview} onClick={handleExportar}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              {isLoadingPreview ? "Carregando prévia..." : "Exportar para Excel"}
            </button>
          </div>
        </div>

        {/* ── Right Column ─────────────────────────────────────── */}
        <div className="right-col">

          {/* Comparison Table */}
          {compareRows && (
            <div className="app-card compare-card">
              <div className="compare-header">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="20" x2="18" y2="10"/>
                  <line x1="12" y1="20" x2="12" y2="4"/>
                  <line x1="6"  y1="20" x2="6"  y2="14"/>
                </svg>
                Análise de Gaps ({compareRows.length} itens)
              </div>
              <div className="compare-body">
                <table className="compare-table">
                  <thead>
                    <tr>
                      <th>ITEM</th>
                      <th className="text-right">CONTADO</th>
                      <th className="text-right">ESPERADO</th>
                      <th className="text-right">DIFERENÇA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compareRows.map(row => (
                      <tr key={row.item} className={
                        row.diferenca > 0 ? "row-surplus"
                        : row.diferenca < 0 ? "row-deficit"
                        : "row-ok"
                      }>
                        <td className="mono">{row.item}</td>
                        <td className="mono text-right">{row.contado.toLocaleString("pt-BR")}</td>
                        <td className="mono text-right">{row.esperado.toLocaleString("pt-BR")}</td>
                        <td className="mono text-right diff-cell">
                          <span className={`diff-badge diff-${row.sinal === "+" ? "plus" : row.sinal === "-" ? "minus" : "zero"}`}>
                            {row.sinal !== "=" ? `${row.sinal}${Math.abs(row.diferenca).toLocaleString("pt-BR")}` : "OK"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Result Card */}
          {hasResult && result && (
            <div className="app-card result-card">
              <div className="result-icon">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                  <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
              </div>
              <h2 className="result-title">Sucesso!</h2>
              <p className="result-subtitle">
                {savedOk
                  ? `Registrado na sessão #${session?.id ?? "—"}.`
                  : "Confira o resultado e clique em \"Salvar no banco\"."}
              </p>
              <div className="result-table-wrapper">
                <table className="result-table">
                  <thead>
                    <tr>
                      <th>ITEM</th>
                      <th className="text-right">RESULTADO FINAL</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="mono">{result.activeCode ?? "-"}</td>
                      <td className="mono text-right total-cell">
                        {result.total.toLocaleString("pt-BR")}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {result.logs.filter(l => l.includes("Erro:")).length > 0 && (
                <div className="result-errors">
                  <span className="result-errors-count">
                    {result.logs.filter(l => l.includes("Erro:")).length} linha(s) ignorada(s) — salvas em log
                  </span>
                  <div className="result-log-list">
                    {result.logs.filter(l => l.includes("Erro:")).map((log, i) => (
                      <div key={i} className="result-log-error">{log}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Items List Card */}
          {!hasResult && !compareRows && (
            <div className="app-card list-card">
              <div className="list-header">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="8" y1="6" x2="21" y2="6"/>
                  <line x1="8" y1="12" x2="21" y2="12"/>
                  <line x1="8" y1="18" x2="21" y2="18"/>
                  <line x1="3" y1="6" x2="3.01" y2="6"/>
                  <line x1="3" y1="12" x2="3.01" y2="12"/>
                  <line x1="3" y1="18" x2="3.01" y2="18"/>
                </svg>
                Itens Lidos (<span>{items.length}</span>)
              </div>
              <div className="list-body">
                {items.length === 0 ? (
                  <div className="empty-state">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
                      <path d="M17 3h2a2 2 0 0 1 2 2v2"/>
                      <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
                      <path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
                      <line x1="7" y1="12" x2="7" y2="12"/>
                      <line x1="12" y1="12" x2="12" y2="12"/>
                      <line x1="17" y1="12" x2="17" y2="12"/>
                    </svg>
                    <p>Nenhum item lido ainda.</p>
                  </div>
                ) : (
                  items.map((item, idx) => {
                    const num     = items.length - idx;
                    const timeStr = item.timestamp.toLocaleTimeString("pt-BR");
                    return (
                      <div key={item.id} className={`scan-item${item.isError ? " scan-item-error" : ""}`}>
                        <div className="scan-item-left">
                          <div className="item-num">{num}</div>
                          <div>
                            <div className="item-code">{item.code ?? item.raw}</div>
                            <div className="item-time">
                              {item.isError
                                ? item.log.split(": ").slice(2).join(": ") || item.log
                                : `Lida em ${timeStr}`}
                            </div>
                          </div>
                        </div>
                        <div className="scan-item-right">
                          <div className="item-qty-label">Qtd</div>
                          <div className={`item-qty${item.isError ? " item-qty-error" : ""}`}>
                            {item.quantity !== null ? item.quantity.toLocaleString("pt-BR") : "—"}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Export Preview Modal ───────────────────────────────── */}
      {showPreview && (
        <div className="modal-overlay" onClick={() => setShowPreview(false)}>
          <div className="modal-panel export-preview-panel" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
              <div>
                <h3 className="modal-title">Prévia da Exportação</h3>
                <p className="modal-subtitle">
                  {previewRows.length} {previewRows.length === 1 ? "item" : "itens"} · sessão #{session?.id ?? "—"}
                  {" · Organização: "}{previewOrganization ?? "Não informada"}
                  {previewHasComp && " · com comparação"}
                </p>
              </div>
              <button className="modal-close-btn" onClick={() => setShowPreview(false)}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <div className="modal-body">
              {previewRows.length === 0 ? (
                <div className="preview-empty">Nenhum dado encontrado para exportar.</div>
              ) : (
                <div className="preview-table-wrapper">
                  <table className="preview-table">
                    <thead>
                      <tr>
                        <th>CÓDIGO</th>
                        <th className="text-right">CONTADO</th>
                        {previewHasComp && <th className="text-right">ESPERADO</th>}
                        {previewHasComp && <th className="text-right">GAP</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map(row => {
                        const gapClass = row.sinal === "=" ? "gap-ok"
                          : row.sinal === "+" ? "gap-surplus"
                          : "gap-deficit";
                        return (
                          <tr key={row.code} className={previewHasComp ? gapClass : ""}>
                            <td className="mono">{row.code}</td>
                            <td className="mono text-right">{row.quantity.toLocaleString("pt-BR")}</td>
                            {previewHasComp && (
                              <td className="mono text-right">{(row.esperado ?? 0).toLocaleString("pt-BR")}</td>
                            )}
                            {previewHasComp && (
                              <td className="mono text-right">
                                <span className={`diff-badge diff-${row.sinal === "+" ? "plus" : row.sinal === "-" ? "minus" : "zero"}`}>
                                  {row.sinal === "=" ? "OK"
                                    : `${row.sinal}${Math.abs(row.diferenca ?? 0).toLocaleString("pt-BR")}`}
                                </span>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="app-btn app-btn-outline" onClick={() => setShowPreview(false)}>
                Cancelar
              </button>
              <button
                className="app-btn app-btn-save"
                disabled={previewRows.length === 0}
                onClick={handleConfirmarExportacao}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Confirmar exportação
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toasts ─────────────────────────────────────────────── */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`app-toast app-toast-${t.type}`}>
            <span className="toast-title">{t.title}</span>
            <span className="toast-desc">{t.desc}</span>
          </div>
        ))}
      </div>

      <footer className="app-footer">
        Lael Henrique Campos Dantas — LG Electronics Brasil Ltda · 2026
      </footer>
    </div>
  );
}
