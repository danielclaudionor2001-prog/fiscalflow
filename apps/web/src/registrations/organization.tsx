import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { errorMessage, jsonMutation, useRegistrationRequest, type PageAccess, type RecordData } from "./api";
import { ArchiveConfirmation, RecordForm, type Field } from "./form";
import { formatDocument } from "../format";
import { CpfLoginCard } from "./cpf-login";
import { CommercialBranding } from "../commercial/branding";
import { addressFields, organizationTaxFields } from "./profile-fields";
import { Icon, type IconName } from "../ui";
import "./organization.css";

const editableFields: Field[] = [
  { name: "legalName", label: "Nome ou razão social", required: true, maxLength: 160 },
  { name: "tradeName", label: "Nome fantasia", maxLength: 160 },
  { name: "municipalRegistration", label: "Inscrição municipal", maxLength: 40 },
  { name: "stateRegistration", label: "Inscrição estadual", maxLength: 40 },
  ...organizationTaxFields,
  ...addressFields,
  { name: "legalRepresentativeName", label: "Nome do representante legal", section: "Representante legal", maxLength: 160 },
  { name: "legalRepresentativeCpf", label: "CPF do representante legal", kind: "cpf" },
  { name: "legalRepresentativeEmail", label: "E-mail do representante legal", kind: "email", maxLength: 254 },
  { name: "legalRepresentativePhone", label: "Telefone do representante legal", maxLength: 32 },
];
const cnpjField: Field = { name: "cnpj", label: "CNPJ", kind: "cnpj", required: true };
type Organization = RecordData & { id: string; cnpj: string | null; cpfMasked: string | null; documentType: "CPF" | "CNPJ"; legalName: string };
type OrganizationTab = "profile" | "branding" | "access";

function OrganizationDetails({ title, description, icon, fields, organization }: {
  title: string; description: string; icon: IconName; fields: Field[]; organization: Organization;
}) {
  return <section className="registry-card organization-data-card"><div className="organization-section-heading"><span><Icon name={icon} /></span><div><h3>{title}</h3><p>{description}</p></div></div>
    <RecordForm fields={fields.map(({ section: _section, ...field }) => field)} values={organization} />
  </section>;
}

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
  const canEdit = isOwner || role === "ADMIN";
  const [tab, setTab] = useState<OrganizationTab>("profile");
  const tabRefs = useRef<Partial<Record<OrganizationTab, HTMLButtonElement | null>>>({});
  const editorRef = useRef<HTMLElement>(null);
  const archiveRef = useRef<HTMLElement>(null);
  useEffect(() => { if (mode !== "view") (mode === "archive" ? archiveRef : editorRef).current?.scrollIntoView({ block: "start" }); }, [mode]);
  const tabs: { key: OrganizationTab; label: string; icon: IconName }[] = [
    { key: "profile", label: "Dados da empresa", icon: "building" },
    ...(canEdit ? [{ key: "branding" as const, label: "Logo e identidade visual", icon: "document" as const }] : []),
    ...(isOwner ? [{ key: "access" as const, label: "Acesso e configurações", icon: "shield" as const }] : []),
  ];

  function tabKey(event: KeyboardEvent<HTMLButtonElement>, key: OrganizationTab) {
    if (busy || mode !== "view") return;
    const index = tabs.findIndex((item) => item.key === key);
    const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % tabs.length : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); setTab(tabs[next].key); tabRefs.current[tabs[next].key]?.focus();
  }

  useEffect(() => {
    const controller = new AbortController();
    request<Organization>("organizations/current", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setOrganization(data); })
      .catch((error) => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [request, retry]);

  function show(nextMode: typeof mode) {
    if (nextMode === "create" || nextMode === "edit") setTab("profile");
    if (nextMode === "archive") setTab("access");
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
    <div className="registry organization-page">
      {error && <p className="registry-error" role="alert">{error}</p>}
      {notice && <p className="registry-notice" role="status">{notice}</p>}
      {!organization && <section className="registry-card">{error
        ? <button className="button-secondary" onClick={() => { setError(""); setRetry((current) => current + 1); }}>Tentar novamente</button>
        : <p role="status">Carregando organização…</p>}</section>}
      {organization && <>
        <section className="organization-profile">
          <div className="organization-profile-main"><span className="organization-avatar"><Icon name="building" /></span><div><span className="organization-eyebrow">PERFIL DA EMPRESA</span>
            <h2>{organization.tradeName || organization.legalName}</h2>
            {organization.tradeName && organization.tradeName !== organization.legalName && <p className="organization-legal-name">{organization.legalName}</p>}
            <div className="organization-profile-tags"><span>{organization.documentType} {organization.cnpj ? formatDocument(organization.cnpj) : organization.cpfMasked}</span><span className="organization-session"><i aria-hidden="true" />Empresa em uso</span></div>
          </div></div>
          {mode === "view" && <div className="organization-profile-actions">
            {canEdit && <button onClick={() => show("edit")}><Icon name="services" />Editar dados</button>}
            {isOwner && <button className="button-secondary" onClick={() => show("create")}><Icon name="plus" />Nova organização</button>}
          </div>}
        </section>
        <div className="organization-tabs" role="tablist" aria-label="Configurações da organização">{tabs.map((item) => <button key={item.key} ref={(element) => { tabRefs.current[item.key] = element; }} id={"organization-tab-" + item.key} role="tab" aria-selected={tab === item.key} aria-controls={"organization-panel-" + item.key}
          tabIndex={tab === item.key ? 0 : -1} disabled={busy || mode !== "view"} onKeyDown={(event) => tabKey(event, item.key)} onClick={() => setTab(item.key)}><Icon name={item.icon} />{item.label}</button>)}</div>
        <div id="organization-panel-profile" role="tabpanel" aria-labelledby="organization-tab-profile" className="organization-panel" hidden={tab !== "profile"}>
          {(mode === "create" || mode === "edit") ? <section ref={editorRef} className="registry-card organization-editor"><div className="organization-section-heading"><span><Icon name="building" /></span><div><h3>{mode === "create" ? "Cadastrar nova organização" : "Editar dados da empresa"}</h3><p>{mode === "create" ? "Informe a identificação e os dados da nova empresa." : "Atualize o cadastro, o endereço e o representante legal."}</p></div></div>
            {mode === "edit" && <p className="organization-fixed-document">{organization.documentType} {organization.cnpj ? formatDocument(organization.cnpj) : organization.cpfMasked}</p>}
            <RecordForm key={mode} fields={mode === "create" ? [cnpjField, ...editableFields] : editableFields} values={mode === "edit" ? organization : undefined} busy={busy} onSave={save} onClose={() => show("view")} />
          </section> : <div className="organization-data-grid">
            <OrganizationDetails title="Identificação e inscrições" description="Dados que identificam sua empresa." icon="building" organization={organization} fields={[organization.cnpj ? cnpjField : { name: "cpfMasked", label: "CPF" }, ...editableFields.slice(0, 4)]} />
            <OrganizationDetails title="Enquadramento tributário" description="Regime e forma de apuração dos tributos." icon="report" organization={organization} fields={organizationTaxFields} />
            <OrganizationDetails title="Endereço da empresa" description="Localização e dados para seus documentos." icon="home" organization={organization} fields={addressFields} />
            <OrganizationDetails title="Representante legal" description="Pessoa responsável e canais de contato." icon="clients" organization={organization} fields={editableFields.slice(-4)} />
          </div>}
        </div>
        {canEdit && <div id="organization-panel-branding" role="tabpanel" aria-labelledby="organization-tab-branding" className="organization-panel" hidden={tab !== "branding"}><CommercialBranding request={request} /></div>}
        {isOwner && <div id="organization-panel-access" role="tabpanel" aria-labelledby="organization-tab-access" className="organization-panel" hidden={tab !== "access"}>
          {organization.cnpj && <CpfLoginCard organizationId={organizationId} endSession={endSession} />}
          <section ref={archiveRef} className="registry-card organization-danger-zone"><div className="organization-section-heading"><span><Icon name="shield" /></span><div><h3>Arquivamento da organização</h3><p>O histórico é preservado. Arquivar encerra as sessões da empresa.</p></div></div>
            {mode === "archive" ? <ArchiveConfirmation name={organization.legalName} busy={busy} onArchive={archive} onCancel={() => show("view")} /> : <button type="button" className="button-secondary" onClick={() => show("archive")}>Arquivar organização</button>}
          </section>
        </div>}
      </>}
    </div>
  );
}
