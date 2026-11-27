import { useEffect, useState, type FormEvent } from "react";
import { roleNames, type Role } from "../auth";
import { errorMessage, jsonMutation, RegistrationError, useRegistrationRequest, type PageAccess } from "../registrations/api";
import { CollectionHeading, EmptyCollection, StatusPill } from "../collection-ui";
import { dateLabel } from "../format";
import { Icon } from "../ui";

type Invitation = { id: string; name: string; email: string; role: Role; department: string | null; expiresAt: string };
export const employeeRoles = { ADMIN: "Administrador", OPERATOR: "Operador", ACCOUNTANT: "Contador", VIEWER: "Visualizador" } as const;
const descriptions = { ADMIN: "Gerencia cadastros e a rotina da empresa.", OPERATOR: "Trabalha com clientes, serviços e preparação de notas.", ACCOUNTANT: "Consulta relatórios e acompanha o financeiro.", VIEWER: "Acessa os dados disponíveis para consulta." };
function invitationError(failure: unknown) {
  if (failure instanceof RegistrationError) {
    if (failure.code === "already-team-member") return "Este e-mail já está na equipe. Use Alterar papel para ajustar o acesso.";
    if (failure.code === "team-invitation-pending") return "Já existe um convite pendente para este e-mail. Revogue o anterior se precisar gerar outro link.";
    if (failure.code === "invitation-unavailable") return "O convite já foi utilizado ou revogado. Atualize a equipe.";
  } return errorMessage(failure);
}

export function TeamInvitations({ role, organizationId, endSession, revision }: PageAccess & { revision: number }) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [data, setData] = useState<{ items: Invitation[]; hasNext: boolean }>();
  const [page, setPage] = useState(1); const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false); const [nextRole, setNextRole] = useState<keyof typeof employeeRoles>("OPERATOR");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [generated, setGenerated] = useState<{ invitation: Invitation; url: string }>();
  const [revoking, setRevoking] = useState<Invitation>();
  useEffect(() => {
    const controller = new AbortController(); setData(undefined); setError("");
    request<{ items: Invitation[]; hasNext: boolean }>("team/invitations?page=" + page, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(failure => { if (!controller.signal.aborted) setError(invitationError(failure)); });
    return () => controller.abort();
  }, [request, page, version, revision]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; const values = new FormData(event.currentTarget);
    setBusy(true); setError(""); setNotice(""); setGenerated(undefined);
    try {
      const saved = await request<Invitation & { code: string }>("team/invitations", jsonMutation("POST", {
        name: String(values.get("name") ?? ""), email: String(values.get("email") ?? ""), role: nextRole,
        department: String(values.get("department") ?? "").trim() || null,
      }));
      setGenerated({ invitation: saved, url: window.location.origin + "/#equipe=" + saved.code });
      setCreating(false); setPage(1); setVersion(v => v + 1);
    } catch (failure) { setError(invitationError(failure)); } finally { setBusy(false); }
  }
  async function revoke() {
    if (!revoking || busy) return; setBusy(true); setError("");
    try {
      await request("team/invitations/" + encodeURIComponent(revoking.id), { method: "DELETE" });
      if (generated?.invitation.id === revoking.id) setGenerated(undefined);
      setRevoking(undefined); setNotice("Convite revogado. O link anterior não pode mais ser utilizado."); setVersion(v => v + 1);
    } catch (failure) { setError(invitationError(failure)); } finally { setBusy(false); }
  }
  return <section className="registry-card">
    <CollectionHeading icon="clients" title="Funcionários e setores" description="Cada pessoa tem seu login e senha. A equipe pode trabalhar ao mesmo tempo.">
      {role === "OWNER" && <button type="button" disabled={busy} onClick={() => { setCreating(true); setError(""); setNotice(""); }}><Icon name="plus" />Convidar funcionário ou setor</button>}
    </CollectionHeading>
    <p>Informe um nome, o e-mail de acesso e, se desejar, o setor. Escolha as permissões e compartilhe o convite com a pessoa responsável.</p>
    {error && <p role="alert" className="registry-error">{error}</p>}
    {notice && <p role="status" className="registry-notice">{notice}</p>}
    {creating && role === "OWNER" && <form className="record-form" onSubmit={create}>
      <fieldset disabled={busy}>
        <label>Nome do funcionário ou setor<input name="name" maxLength={160} required autoComplete="name" /></label>
        <label>E-mail de acesso<input name="email" type="email" maxLength={254} required autoComplete="email" /></label>
        <label>Setor (opcional)<input name="department" maxLength={80} placeholder="Ex.: Financeiro, Comercial, Operações" /></label>
        <label>Nível de acesso<select value={nextRole} onChange={event => setNextRole(event.target.value as keyof typeof employeeRoles)}>
          {Object.entries(employeeRoles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select><small className="record-hint">{descriptions[nextRole]}</small></label>
      </fieldset>
      <p className="record-hint">O convite vale por 7 dias. O destinatário define a senha no primeiro acesso. Quem já usa o Fiscal Floow mantém a senha atual.</p>
      <div className="record-actions"><button disabled={busy}>{busy ? "Preparando…" : "Gerar convite"}</button><button type="button" className="button-secondary" disabled={busy} onClick={() => setCreating(false)}>Cancelar</button></div>
    </form>}
    {generated && <div className="customer-contact-form">
      <h3>Convite pronto · {generated.invitation.name}</h3>
      <p>{generated.invitation.email} · {roleNames[generated.invitation.role]}{generated.invitation.department ? " · " + generated.invitation.department : ""} · Válido até {dateLabel(generated.invitation.expiresAt)}</p>
      <label>Link de primeiro acesso<input className="team-invite-link" value={generated.url} readOnly onFocus={event => event.currentTarget.select()} /></label>
      <div className="record-actions"><button type="button" className="button-secondary" onClick={() => {
        void navigator.clipboard.writeText(generated.url).then(() => setNotice("Link copiado. Compartilhe com o destinatário."), () => setNotice("Selecione o link e copie manualmente."));
      }}>Copiar convite</button></div>
      <p className="record-hint">Guarde o link agora. Ele não fica disponível novamente nesta tela e só pode ser usado uma vez. Nenhum e-mail é enviado automaticamente.</p>
    </div>}
    <h3>Convites pendentes</h3>
    {!data && !error && <p role="status">Carregando convites…</p>}
    {!data && error && <button className="button-secondary" onClick={() => setVersion(v => v + 1)}>Tentar novamente</button>}
    {data && !data.items.length && <EmptyCollection icon="clients" title="Nenhum convite pendente" description="Os acessos ativados aparecem na lista de membros abaixo." />}
    {data?.items.map(item => <article className="customer-document" key={item.id}>
      <h3>{item.name}</h3><p>{item.email}{item.department ? " · " + item.department : ""}</p><StatusPill tone="info">{roleNames[item.role]}</StatusPill><p>Válido até {dateLabel(item.expiresAt)}</p>
      {role === "OWNER" && <button className="button-secondary" disabled={busy} onClick={() => { setRevoking(item); setError(""); }}>Revogar convite</button>}
      {revoking?.id === item.id && <div className="archive-confirmation"><p>Revogar este convite? O link deixará de funcionar.</p><div className="record-actions"><button className="button-danger" disabled={busy} onClick={() => void revoke()}>Confirmar revogação do convite</button><button className="button-secondary" disabled={busy} onClick={() => setRevoking(undefined)}>Manter convite</button></div></div>}
    </article>)}
    {data && (page > 1 || data.hasNext) && <div className="record-actions registry-pagination"><button className="button-secondary" disabled={page <= 1 || busy} onClick={() => setPage(page - 1)}>Anterior</button><span>Página {page}</span><button className="button-secondary" disabled={!data.hasNext || busy || page >= 10000} onClick={() => setPage(page + 1)}>Próxima</button></div>}
  </section>;
}
