import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/lib/authContext";

interface AdminUser {
  id: number;
  username: string;
  role: string;
}

type NewUserRole = "user" | "admin";

export default function UserManagement() {
  const { user, fetchAuth, logout } = useAuth();
  const [, navigate] = useLocation();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [newRole, setNewRole] = useState<NewUserRole>("user");
  const [creating, setCreating] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<AdminUser | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetchAuth("/api/admin/users");
      if (!response.ok) throw new Error();
      setUsers(await response.json() as AdminUser[]);
    } catch {
      setError("Não foi possível carregar os usuários.");
    } finally {
      setLoading(false);
    }
  }, [fetchAuth]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  async function createUser(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");

    const username = newUsername.trim();
    if (username.length < 3 || username.length > 100) {
      setError("O usuário deve ter entre 3 e 100 caracteres.");
      return;
    }
    if (newPassword.length < 12) {
      setError("A senha deve ter no mínimo 12 caracteres.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("A confirmação da senha não confere.");
      return;
    }

    setCreating(true);
    try {
      const response = await fetchAuth("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: newPassword, role: newRole }),
      });
      const data = await response.json() as { user?: AdminUser; error?: string };
      if (!response.ok) {
        setError(data.error ?? "Não foi possível criar o usuário.");
        return;
      }
      if (data.user) {
        setUsers(current => [...current, data.user!].sort((left, right) => left.username.localeCompare(right.username)));
      }
      setNewUsername("");
      setNewPassword("");
      setConfirmPassword("");
      setNewRole("user");
      setShowForm(false);
      setSuccess("Usuário criado com sucesso.");
    } catch {
      setError("Erro de conexão com o servidor.");
    } finally {
      setCreating(false);
    }
  }

  async function removeUser() {
    if (!pendingRemoval) return;
    setRemoving(true);
    setRemoveError("");
    setError("");
    setSuccess("");
    try {
      const response = await fetchAuth(`/api/admin/users/${pendingRemoval.id}`, { method: "DELETE" });
      const data = await response.json() as { error?: string; message?: string };
      if (!response.ok) {
        setRemoveError(data.error ?? "Não foi possível remover o usuário.");
        return;
      }
      setUsers(current => current.filter(item => item.id !== pendingRemoval.id));
      setPendingRemoval(null);
      setSuccess(data.message ?? "Usuário removido com sucesso.");
    } catch {
      setRemoveError("Erro de conexão com o servidor.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header-left">
          <div>
            <h1>Gerenciamento de Usuários</h1>
            <p className="admin-subtitle">Contas e acessos administrativos</p>
          </div>
        </div>
        <div className="admin-header-right">
          <span className="admin-user-badge">{user?.username}</span>
          <button className="app-btn app-btn-outline app-btn-sm" onClick={() => navigate("/admin")}>
            Dashboard
          </button>
          <button className="app-btn app-btn-outline app-btn-sm" onClick={async () => { await logout(); navigate("/login"); }}>
            Sair
          </button>
        </div>
      </header>

      <main className="admin-body">
        <section className="app-card admin-filters">
          <div className="compare-header">Usuários cadastrados ({users.length})</div>
          <div className="filters-row">
            <span />
            <button className="app-btn app-btn-primary app-btn-sm" onClick={() => { setShowForm(value => !value); setError(""); }}>
              {showForm ? "Cancelar" : "Adicionar usuário"}
            </button>
          </div>
          {error && <div className="admin-error" role="alert">{error}</div>}
          {success && <div className="admin-success" role="status">{success}</div>}
          {showForm && (
            <form className="filters-row" onSubmit={createUser}>
              <div className="filter-group">
                <label htmlFor="new-username">Usuário</label>
                <input id="new-username" type="text" value={newUsername} onChange={event => setNewUsername(event.target.value)} autoComplete="off" disabled={creating} />
              </div>
              <div className="filter-group">
                <label htmlFor="new-password">Senha</label>
                <input id="new-password" type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" disabled={creating} />
              </div>
              <div className="filter-group">
                <label htmlFor="confirm-password">Confirmar senha</label>
                <input id="confirm-password" type="password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" disabled={creating} />
              </div>
              <div className="filter-group">
                <label htmlFor="new-role">Perfil</label>
                <select id="new-role" value={newRole} onChange={event => setNewRole(event.target.value as NewUserRole)} disabled={creating}>
                  <option value="user">Usuário</option>
                  <option value="admin">Administrador</option>
                </select>
              </div>
              <button className="app-btn app-btn-primary app-btn-sm" type="submit" disabled={creating}>
                {creating ? "Criando..." : "Criar usuário"}
              </button>
            </form>
          )}
          <div className="compare-body">
            {loading ? (
              <div className="admin-loading">Carregando usuários...</div>
            ) : (
              <table className="compare-table admin-sessions-table">
                <thead>
                  <tr><th>Usuário</th><th>Perfil</th><th className="text-right">Ações</th></tr>
                </thead>
                <tbody>
                  {users.length === 0 ? (
                    <tr><td colSpan={3} className="admin-empty">Nenhum usuário encontrado.</td></tr>
                  ) : users.map(item => (
                    <tr key={item.id}>
                      <td>{item.username}</td>
                      <td>{item.role === "admin" ? "Administrador" : "Usuário"}</td>
                      <td className="text-right">
                        <button
                          className="app-btn app-btn-outline app-btn-sm"
                          type="button"
                          disabled={item.id === user?.id}
                          title={item.id === user?.id ? "Sua própria conta não pode ser removida." : "Remover usuário"}
                          onClick={() => { setPendingRemoval(item); setRemoveError(""); }}
                        >
                          Remover usuário
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>

      <AlertDialog open={pendingRemoval !== null} onOpenChange={open => { if (!open && !removing) setPendingRemoval(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover usuário</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja remover este usuário? A conta {pendingRemoval?.username} será removida, as sessões ativas serão finalizadas e o histórico será preservado.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError && <div className="admin-error" role="alert">{removeError}</div>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={removing}
              onClick={event => { event.preventDefault(); void removeUser(); }}
            >
              {removing ? "Removendo..." : "Remover"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <footer className="app-footer">
        Lael Henrique Campos Dantas — LG Electronics Brasil Ltda · 2026
      </footer>
    </div>
  );
}