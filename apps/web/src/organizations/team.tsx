import { useEffect, useState, type FormEvent } from "react";
import { roleNames, type Role } from "../auth";
import { errorMessage, jsonMutation, RegistrationError, useRegistrationRequest, type PageAccess } from "../registrations/api";
import { TeamInvitations } from "./team-invitations";
import { CollectionHeading } from "../collection-ui";

type Member = { id: string; name: string; email: string; role: Role; department: string | null; isSelf: boolean };
type Listing = { items: Member[]; hasNext: boolean };
type Action = { mode: "edit" | "revoke"; member: Member };

function teamError(error: unknown) {
  if (error instanceof RegistrationError) {
    if (error.code === "own-membership") return "Seu próprio vínculo não pode ser alterado aqui.";
    if (error.code === "member-unavailable") return "Esse vínculo saiu da equipe. Atualize a lista.";
  }
  return errorMessage(error);
}

export function TeamPage({ role, organizationId, endSession }: PageAccess) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [listing, setListing] = useState<Listing>();
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [action, setAction] = useState<Action>();
  const [nextRole, setNextRole] = useState<Role>("VIEWER");
  const [nextDepartment, setNextDepartment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setListing(undefined);
    setError("");
    request<Listing>(`team?page=${page}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setListing(data); })
      .catch((failure) => { if (!controller.signal.aborted) setError(teamError(failure)); });
    return () => controller.abort();
  }, [request, page, version]);

  function selectAction(mode: Action["mode"], member: Member) {
    setNextRole(member.role);
    setNextDepartment(member.department ?? "");
    setAction({ mode, member });
    setError("");
    setNotice("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || busy) return;
    setBusy(true);
    setError("");
    const revoking = action.mode === "revoke";
    try {
      await request(`team/${encodeURIComponent(action.member.id)}`, revoking ? { method: "DELETE" } : jsonMutation("PATCH", { role: nextRole, department: nextDepartment.trim() || null }));
      setAction(undefined);
      setNotice(revoking ? "Acesso revogado." : "Acesso atualizado. Se o papel mudou, o membro deve entrar novamente.");
      if (revoking && listing?.items.length === 1 && page > 1) setPage(page - 1);
      setVersion((current) => current + 1);
    } catch (failure) {
      setError(teamError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="registry">
      {error && <p className="registry-error" role="alert">{error}</p>}
      {notice && <p className="registry-notice" role="status">{notice}</p>}
      <TeamInvitations role={role} organizationId={organizationId} endSession={endSession} revision={version} />
      {action && (
        <form className="record-form registry-card" onSubmit={submit}>
          <h2>{action.mode === "edit" ? "Alterar acesso e setor" : "Revogar acesso"} de {action.member.name}</h2>
          {action.mode === "edit" ? (
            <label>Novo papel
              <select disabled={busy} value={nextRole} onChange={(event) => setNextRole(event.target.value as Role)}>
                {Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
          ) : <p>O membro perderá o acesso a esta empresa.</p>}
          {action.mode === "edit" && <label>Setor (opcional)<input value={nextDepartment} maxLength={80} disabled={busy} onChange={event => setNextDepartment(event.target.value)} /></label>}
          <div className="record-actions">
            <button className={action.mode === "revoke" ? "button-danger" : undefined}
              disabled={busy || (action.mode === "edit" && nextRole === action.member.role && nextDepartment.trim() === (action.member.department ?? ""))}>
              {action.mode === "revoke" ? "Confirmar revogação" : "Salvar papel"}
            </button>
            <button type="button" className="button-secondary" disabled={busy} onClick={() => { setAction(undefined); setError(""); }}>Cancelar</button>
          </div>
        </form>
      )}
      <div className="registry-card">
        <CollectionHeading icon="clients" title="Membros da empresa" description="Gerencie os acessos já ativados."><button className="button-secondary" disabled={busy} onClick={() => setVersion(v => v + 1)}>Atualizar equipe</button></CollectionHeading>
        {!listing && (error
          ? <button className="button-secondary" onClick={() => setVersion((current) => current + 1)}>Tentar novamente</button>
          : <p role="status">Carregando membros…</p>)}
        {listing && (listing.items.length ? (
          <div className="registry-table compact-table collection-table">
            <table aria-label="Membros da empresa">
              <thead><tr><th scope="col">Nome</th><th scope="col">E-mail</th><th scope="col">Setor</th><th scope="col">Papel</th>{role === "OWNER" && <th scope="col">Ações</th>}</tr></thead>
              <tbody>{listing.items.map((member) => (
                <tr key={member.id}>
                  <td className="cell-wide" data-label="Nome">{member.name}{member.isSelf ? " (você)" : ""}</td><td data-label="E-mail">{member.email}</td><td data-label="Setor">{member.department ?? "—"}</td><td data-label="Papel">{roleNames[member.role]}</td>
                  {role === "OWNER" && <td>{!member.isSelf && <div className="record-actions">
                    <button className="button-secondary" disabled={Boolean(action)} onClick={() => selectAction("edit", member)}>Alterar papel</button>
                    <button className="button-secondary" disabled={Boolean(action)} onClick={() => selectAction("revoke", member)}>Revogar acesso</button>
                  </div>}</td>}
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p>Nenhum membro nesta página.</p>)}
        {listing && (page > 1 || listing.hasNext) && (
          <div className="record-actions registry-pagination">
            <button className="button-secondary" disabled={page <= 1 || Boolean(action)} onClick={() => setPage(page - 1)}>Anterior</button>
            <span>Página {page}</span>
            <button className="button-secondary" disabled={!listing.hasNext || page >= 10000 || Boolean(action)} onClick={() => setPage(page + 1)}>Próxima</button>
          </div>
        )}
      </div>
    </div>
  );
}
