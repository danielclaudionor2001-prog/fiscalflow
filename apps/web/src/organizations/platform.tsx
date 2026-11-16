import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, jsonMutation, RegistrationError, useRegistrationRequest, type PageAccess } from "../registrations/api";

import { DocumentInput } from "../formatted-inputs";
import { formatDocument, normalizeDocument } from "../format";

type Company = {
  id: string;
  legalName: string;
  cnpj: string | null;
  cpfMasked: string | null;
  accessSuspendedAt: string | null;
  accessInvitation: { email: string; expiresAt: string } | null;
  issuance: { mode: "company" | "single-dps" | "disabled"; certificateValid: boolean; available: boolean };
};

type CompanyList = { items: Company[]; hasNext: boolean };

async function generateInvitation() {
  const code = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  const inviteHash = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const link = new URL(window.location.pathname, window.location.origin);
  link.hash = "ativar=" + code;
  return { inviteHash, link: link.href };
}

function platformError(error: unknown) {
  if (error instanceof RegistrationError) {
    if (error.code === "invitation-unavailable") {
      return "O convite não está mais disponível. Atualize a lista de empresas.";
    }
    if (error.code === "company-access-inactive") return "A empresa precisa estar com o acesso ativo e com um responsável cadastrado.";
    if (error.code === "valid-certificate-required") return "A empresa precisa cadastrar um certificado A1 válido em Certificados.";
    if (error.code === "issuer-cnpj-required") return "A emissão de NFS-e com A1 está disponível para empresas com CNPJ.";
    if (error.code === "certificate-unavailable") return "O cofre de certificados está indisponível.";
    if (error.status === 404 && !error.code) {
      return "O Fiscal Floow está indisponível neste endereço. Recarregue a página e tente novamente.";
    }
  }
  return errorMessage(error);
}

function issuanceStatus(company: Company) {
  if (!company.cnpj) return "Disponível para CNPJ";
  if (company.accessSuspendedAt) return "Acesso suspenso";
  if (company.accessInvitation) return "Aguardando ativação";
  if (!company.issuance.available) return "Indisponível";
  if (!company.issuance.certificateValid) return "Aguardando A1 válido";
  if (company.issuance.mode === "company") return "Liberada";
  if (company.issuance.mode === "single-dps") return "Aprovação por nota";
  return "Bloqueada";
}

export function PlatformPage({ organizationId, endSession }: PageAccess) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [listing, setListing] = useState<CompanyList>();
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<Company>();
  const [issuanceChange, setIssuanceChange] = useState<{ company: Company; enabled: boolean }>();
  const [invitation, setInvitation] = useState<{ link: string; email: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const abort = new AbortController();
    setListing(undefined);
    request<CompanyList>("platform/companies?page=" + page, { signal: abort.signal })
      .then((data) => { if (!abort.signal.aborted) setListing(data); })
      .catch((failure) => { if (!abort.signal.aborted) setError(platformError(failure)); });
    return () => abort.abort();
  }, [page, revision, request]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const { document, ...form } = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const documentField = /^\d{11}$/.test(normalizeDocument(document)) ? "cpf" : "cnpj";
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { inviteHash, link } = await generateInvitation();
      const company = await request<Company>("platform/companies", jsonMutation("POST", {
        ...form, [documentField]: document, inviteHash,
      }));
      setInvitation({ link, email: company.accessInvitation!.email });
      setCreating(false);
      setPage(1);
      setRevision((value) => value + 1);
    } catch (failure) {
      setError(platformError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function renew(company: Company) {
    if (!company.accessInvitation || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { inviteHash, link } = await generateInvitation();
      await request("platform/companies/" + encodeURIComponent(company.id) + "/invitation", jsonMutation("POST", { inviteHash }));
      setInvitation({ link, email: company.accessInvitation.email });
      setRevision((value) => value + 1);
    } catch (failure) {
      setError(platformError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function changeAccess(company: Company) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const suspended = !company.accessSuspendedAt;
    try {
      await request("platform/companies/" + encodeURIComponent(company.id) + "/access", jsonMutation("PATCH", { suspended }));
      setConfirming(undefined);
      setNotice(suspended ? "Acesso suspenso e sessões encerradas." : "Acesso reativado. A equipe já pode entrar novamente.");
      setRevision((value) => value + 1);
    } catch (failure) {
      setError(platformError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function changeIssuance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!issuanceChange || busy) return;
    const { company, enabled } = issuanceChange;
    if (enabled && !new FormData(event.currentTarget).has("accredited")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await request<Company>("platform/companies/" + encodeURIComponent(company.id) + "/issuance",
        jsonMutation("PATCH", enabled ? { enabled, accredited: true } : { enabled }));
      setListing((current) => current && { ...current, items: current.items.map((item) => item.id === updated.id ? updated : item) });
      setIssuanceChange(undefined);
      setNotice(enabled ? "Emissão de NFS-e liberada para " + company.legalName + "." : "Novas emissões bloqueadas para " + company.legalName + ".");
    } catch (failure) {
      setError(platformError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="registry">
      {error && <p className="registry-error" role="alert">{error}</p>}
      {notice && <p className="registry-notice" role="status">{notice}</p>}
      {invitation && <div className="registry-card record-form">
        <h2>Link de primeiro acesso</h2>
        <p>Envie o link diretamente para {invitation.email}. Ele é de uso único e vence em 48 horas.</p>
        <label>Link de convite<input readOnly value={invitation.link} onFocus={(event) => event.currentTarget.select()} /></label>
        <div className="record-actions">
          <button type="button" onClick={async () => {
            try { await navigator.clipboard.writeText(invitation.link); setNotice("Link copiado."); }
            catch { setError("Selecione o link e copie manualmente."); }
          }}>Copiar link</button>
          <button type="button" className="button-secondary" onClick={() => setInvitation(undefined)}>Fechar</button>
        </div>
      </div>}
      {creating && <form className="registry-card record-form" onSubmit={create}>
        <h2>Cadastrar empresa assinante</h2>
        <fieldset disabled={busy}>
          <label>Nome ou razão social<input name="legalName" required maxLength={160} /></label>
          <label>CPF ou CNPJ<DocumentInput name="document" required /></label>
          <label>Nome do responsável<input name="ownerName" required maxLength={120} /></label>
          <label>E-mail do responsável<input type="email" name="ownerEmail" required maxLength={254} /></label>
        </fieldset>
        <div className="record-actions">
          <button disabled={busy}>{busy ? "Cadastrando…" : "Cadastrar e gerar convite"}</button>
          <button type="button" className="button-secondary" disabled={busy} onClick={() => setCreating(false)}>Cancelar</button>
        </div>
      </form>}
      {confirming && <div className="registry-card">
        <h2>{confirming.accessSuspendedAt ? "Reativar acesso" : "Suspender acesso"}</h2>
        <p><strong>{confirming.legalName}.</strong> {confirming.accessSuspendedAt
          ? "A equipe poderá entrar novamente."
          : "As sessões da equipe serão encerradas. Os cadastros e documentos ficarão guardados."}</p>
        <div className="record-actions">
          <button className={confirming.accessSuspendedAt ? "" : "button-danger"} disabled={busy}
            onClick={() => void changeAccess(confirming)}>Confirmar</button>
          <button className="button-secondary" disabled={busy} onClick={() => setConfirming(undefined)}>Cancelar</button>
        </div>
      </div>}
      {issuanceChange && <form className="registry-card record-form" onSubmit={changeIssuance}>
        <h2>{issuanceChange.enabled ? "Liberar emissão de NFS-e" : "Bloquear novas emissões"}</h2>
        <p><strong>{issuanceChange.company.legalName}</strong> · {formatDocument(issuanceChange.company.cnpj ?? "")}</p>
        {issuanceChange.enabled ? <>
          <p>O responsável pela empresa poderá confirmar e emitir suas próprias notas de serviço.</p>
          <label className="record-checkbox">
            <input name="accredited" type="checkbox" required disabled={busy} autoFocus />
            Confirmo que a empresa está credenciada no Portal Nacional para emitir via API.
          </label>
        </> : <p>A empresa ainda poderá consultar notas já emitidas e acompanhar envios pendentes.</p>}
        <div className="record-actions">
          <button type="submit" className={issuanceChange.enabled ? undefined : "button-danger"} disabled={busy} autoFocus={!issuanceChange.enabled}>
            {issuanceChange.enabled ? "Confirmar liberação" : "Confirmar bloqueio"}
          </button>
          <button className="button-secondary" type="button" disabled={busy} onClick={() => setIssuanceChange(undefined)}>Cancelar</button>
        </div>
      </form>}
      <div className="registry-card">
        <div className="registry-heading">
          <h2>Empresas assinantes</h2>
          <button disabled={creating || busy || Boolean(issuanceChange)} onClick={() => { setCreating(true); setError(""); }}>Nova empresa</button>
        </div>
        {!listing && !error && <p role="status">Carregando empresas…</p>}
        {!listing && error && <button className="button-secondary" onClick={() => {
          setError(""); setRevision((value) => value + 1);
        }}>Tentar novamente</button>}
        {listing?.items.length === 0 && <p>Nenhuma empresa nesta página.</p>}
        {!!listing?.items.length && <div className="registry-table compact-table">
          <table role="table" aria-label="Empresas assinantes">
            <thead><tr><th scope="col">Conta</th><th scope="col">Documento</th><th scope="col">Acesso</th><th scope="col">Emissão de NFS-e</th><th scope="col">Ações</th></tr></thead>
            <tbody role="rowgroup">
              {listing.items.map((company) => <tr role="row" key={company.id}>
                <td role="cell" className="cell-wide"><strong>{company.legalName}</strong></td>
                <td role="cell" data-label="Documento">{company.cnpj ? formatDocument(company.cnpj) : company.cpfMasked}</td>
                <td role="cell" data-label="Acesso">{company.accessSuspendedAt ? "Suspenso" : company.accessInvitation
                  ? "Aguardando ativação" : "Ativo"}</td>
                <td role="cell" data-label="Emissão de NFS-e">{issuanceStatus(company)}</td>
                <td role="cell" className="cell-wide"><div className="record-actions">
                  <a href={"#assinaturas?empresa=" + encodeURIComponent(company.id)}>Cobranças</a>
                  {company.cnpj && company.issuance.mode !== "company" && <button type="button" className="button-secondary"
                    disabled={busy || Boolean(issuanceChange || confirming || creating || company.accessSuspendedAt || company.accessInvitation) ||
                      !company.issuance.certificateValid || !company.issuance.available}
                    onClick={() => { setError(""); setNotice(""); setIssuanceChange({ company, enabled: true }); }}>
                    Liberar emissão
                  </button>}
                  {company.cnpj && company.issuance.mode !== "disabled" && <button type="button" className="button-secondary"
                    disabled={busy || Boolean(issuanceChange || confirming || creating)}
                    onClick={() => { setError(""); setNotice(""); setIssuanceChange({ company, enabled: false }); }}>
                    Bloquear emissão
                  </button>}
                  {!company.accessSuspendedAt && company.accessInvitation && <button className="button-secondary" disabled={busy}
                    onClick={() => void renew(company)}>Gerar novo link</button>}
                  <button className="button-secondary" disabled={busy || Boolean(issuanceChange)} onClick={() => setConfirming(company)}>
                    {company.accessSuspendedAt ? "Reativar acesso" : "Suspender acesso"}
                  </button>
                </div></td>
              </tr>)}
            </tbody>
          </table>
        </div>}
        {listing && (page > 1 || listing.hasNext) && <div className="record-actions registry-pagination">
          <button className="button-secondary" disabled={page === 1 || busy} onClick={() => setPage(page - 1)}>Anterior</button>
          <span>Página {page}</span>
          <button className="button-secondary" disabled={!listing.hasNext || busy || page >= 10000} onClick={() => setPage(page + 1)}>Próxima</button>
        </div>}
      </div>
    </div>
  );
}
