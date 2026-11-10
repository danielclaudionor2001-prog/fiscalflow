import { useEffect, useState } from "react";
import { errorMessage, jsonMutation, useRegistrationRequest, type PageAccess, type RecordData } from "./api";
import { ArchiveConfirmation, RecordForm, type Field } from "./form";
import { formatDocument } from "../format";
import { CpfLoginCard } from "./cpf-login";

const editableFields: Field[] = [
  { name: "legalName", label: "Nome ou razão social", required: true, maxLength: 160 },
  { name: "tradeName", label: "Nome fantasia", maxLength: 160 },
  { name: "municipalRegistration", label: "Inscrição municipal", maxLength: 40 },
  { name: "cityIbgeCode", label: "Código IBGE do município", maxLength: 7 },
];
const cnpjField: Field = { name: "cnpj", label: "CNPJ", kind: "cnpj", required: true };
type Organization = RecordData & { id: string; cnpj: string | null; cpfMasked: string | null; documentType: "CPF" | "CNPJ"; legalName: string };

export function OrganizationPage({ role, organizationId, endSession, renameOrganization }: PageAccess & {
  renameOrganization: (name: string) => void;
}) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [organization, setOrganization] = useState<Organization>();
  const [retry, setRetry] = useState(0);
  const [mode, setMode] = useState<"view" | "edit" | "create" | "archive">("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isOwner = role === "OWNER";

  useEffect(() => {
    const controller = new AbortController();
    request<Organization>("organizations/current", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setOrganization(data); })
      .catch((error) => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [request, retry]);

  function show(nextMode: typeof mode) {
    setMode(nextMode);
    setError("");
    setNotice("");
  }

  async function save(data: RecordData) {
    setBusy(true);
    setError("");
    try {
      if (mode === "create") {
        const created = await request<Organization>("organizations", jsonMutation("POST", data));
        setNotice(`Organização criada. Para administrá-la, saia e entre com o CNPJ ${formatDocument(created.cnpj ?? "")} e suas credenciais atuais.`);
      } else {
        const updated = await request<Organization>("organizations/current", jsonMutation("PATCH", data));
        setOrganization(updated);
        renameOrganization(updated.legalName);
        setNotice("Dados da organização atualizados.");
      }
      setMode("view");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    setBusy(true);
    setError("");
    try {
      await request("organizations/current", { method: "DELETE" });
      endSession();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="registry">
      {error && <p className="registry-error" role="alert">{error}</p>}
      {notice && <p className="registry-notice" role="status">{notice}</p>}
      <div className="registry-card">
        <div className="registry-heading">
          <h2>{mode === "create" ? "Nova organização" : "Organização da sessão"}</h2>
          {mode === "view" && isOwner && <button onClick={() => show("create")}>Nova organização</button>}
        </div>
        {mode === "create" && <RecordForm fields={[cnpjField, ...editableFields]} busy={busy} onSave={save} onClose={() => show("view")} />}
        {!organization && mode !== "create" && (error
          ? <button className="button-secondary" onClick={() => { setError(""); setRetry((current) => current + 1); }}>Tentar novamente</button>
          : <p role="status">Carregando organização…</p>)}
        {organization && mode === "edit" && (
          <>
            <p>{organization.documentType} {organization.cnpj ? formatDocument(organization.cnpj) : organization.cpfMasked}</p>
            <RecordForm fields={editableFields} values={organization} busy={busy} onSave={save} onClose={() => show("view")} />
          </>
        )}
        {organization && (mode === "view" || mode === "archive") && (
          <>
            <RecordForm fields={[organization.cnpj ? cnpjField : { name: "cpfMasked", label: organization.documentType },
              ...editableFields]} values={organization} />
            {mode === "view" && (
              <div className="record-actions">
                {(isOwner || role === "ADMIN") && <button className="button-secondary" onClick={() => show("edit")}>Editar organização</button>}
                {isOwner && <button className="button-secondary" onClick={() => show("archive")}>Arquivar organização</button>}
              </div>
            )}
            {mode === "archive" && (
              <>
                <p>O arquivamento encerra as sessões desta organização.</p>
                <ArchiveConfirmation name={organization.legalName} busy={busy} onArchive={archive} onCancel={() => show("view")} />
              </>
            )}
          </>
        )}
      </div>
      {mode === "view" && isOwner && organization?.cnpj && <CpfLoginCard organizationId={organizationId} endSession={endSession} />}
    </div>
  );
}
