import { useEffect, useRef, useState } from "react";
import { errorMessage, jsonMutation, useRegistrationRequest, useRegistrationResponse, type PageAccess, type RecordData } from "./api";
import { contactNumberLabel, emailLink, whatsappLink } from "./contact";
import { CustomerContact, customerResponsibleFields } from "./customer-contact";
import { RecordForm } from "./form";
import { CollectionHeading, EmptyCollection, StatusPill } from "../collection-ui";
import { civilDateLabel, dateLabel } from "../format";
import { Icon } from "../ui";

const kinds = { INVOICE: "Notas fiscais", QUOTE: "Orçamentos", SERVICE_ORDER: "Ordens de serviço", BOLETO: "Boletos" };
type Kind = keyof typeof kinds;
type Document = { id: string; title: string; date: string; amount: string; status: string;
  pdfPath: string | null; filename: string | null; publicUrl: string | null };
const statusLabels: Record<string, string> = { AUTHORIZED: "NFS-e autorizada", CANCELLED: "Cancelado", CANCEL_REQUESTED: "Cancelamento solicitado",
  OPEN: "Em aberto", CONFIRMED: "Confirmado", PLANNED: "Planejado", REGISTERED: "Registrado", SETTLED: "Compensado" };
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function DocumentSend({ row, customer, request, editContact }: { row: Document; customer: RecordData; request: ReturnType<typeof useRegistrationResponse>; editContact?: () => void }) {
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const message = `Olá${customer.contactName ? ", " + customer.contactName : ""}! Segue ${row.title}, no valor de ${currency.format(Number(row.amount))}. Situação: ${statusLabels[row.status] ?? row.status}.` +
    (row.date.length === 10 ? "\nVencimento: " + civilDateLabel(row.date) + "." : "") +
    (row.publicUrl ? "\n" + row.publicUrl : "\nO PDF segue em anexo.");
  const whatsapp = whatsappLink(customer.contactWhatsapp, message);
  const email = emailLink(customer.contactEmail, row.title, message);
  const ready = Boolean(row.publicUrl || file);
  const nativeShare = file && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });

  async function prepare() {
    if (!row.pdfPath || !row.filename || busy) return;
    setBusy(true); setError("");
    try {
      const response = await request(row.pdfPath);
      if (!response.headers.get("Content-Type")?.includes("application/pdf")) throw new Error("invalid-pdf");
      const blob = await response.blob();
      if (mounted.current) setFile(new File([blob], row.filename, { type: "application/pdf" }));
    } catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { if (mounted.current) setBusy(false); }
  }

  function download() {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function share() {
    if (!file || busy) return;
    setBusy(true); setError("");
    try { await navigator.share({ files: [file], title: row.title, text: message.replace("\nO PDF segue em anexo.", "") }); }
    catch (failure) { if (mounted.current && !(failure instanceof DOMException && failure.name === "AbortError")) setError("Não foi possível abrir o compartilhamento. Baixe o PDF e anexe na conversa ou no e-mail."); }
    finally { if (mounted.current) setBusy(false); }
  }

  return <article className="customer-document">
    <h3>{row.title}</h3>
    <p>{row.date.length === 10 ? "Vencimento: " + civilDateLabel(row.date) : dateLabel(row.date)} · <strong>{currency.format(Number(row.amount))}</strong></p>
    <StatusPill tone={row.status === "CANCELLED" ? "negative" : "info"}>{statusLabels[row.status] ?? row.status}</StatusPill>
    {error && <p role="alert" className="registry-error">{error}</p>}
    <div className="record-actions">
      {row.pdfPath && !file && <button type="button" disabled={busy} onClick={() => void prepare()}><Icon name="document" />{busy ? "Preparando…" : "Preparar PDF para envio"}</button>}
      {file && <button type="button" className="button-secondary" onClick={download}><Icon name="download" />Baixar PDF</button>}
      {nativeShare && <button type="button" disabled={busy} onClick={() => void share()}><Icon name="external" />Compartilhar PDF</button>}
      {row.publicUrl && <a className="button button-secondary" href={row.publicUrl} target="_blank" rel="noopener noreferrer">Abrir boleto existente</a>}
    </div>
    {ready && <div className="document-prepared">
      {file && <p>Para enviar ao número ou e-mail cadastrado, baixe o PDF, abra a conversa ou o e-mail abaixo e anexe o arquivo.
        {nativeShare && " Você também pode usar Compartilhar PDF e escolher o aplicativo e o destinatário."}</p>}
      {row.publicUrl && <p>O link do boleto existente será incluído na mensagem.</p>}
      <div className="record-actions">
        {whatsapp ? <a className="button button-secondary" href={whatsapp} target="_blank" rel="noopener noreferrer"><Icon name="message" />Enviar por WhatsApp · {contactNumberLabel(customer.contactWhatsapp)}</a>
          : <button type="button" className="button-secondary" disabled={!editContact} onClick={editContact}><Icon name="message" />Cadastrar WhatsApp</button>}
        {email ? <a className="button button-secondary" href={email}><Icon name="email" />Enviar por e-mail</a>
          : <button type="button" className="button-secondary" disabled={!editContact} onClick={editContact}><Icon name="email" />Cadastrar e-mail</button>}
      </div>
      {(!whatsapp || !email) && <p className="record-hint">Os canais são independentes: use só WhatsApp, só e-mail ou ambos. Cada canal precisa do seu próprio contato cadastrado.</p>}
      <small className="record-hint">Confira o destinatário e confirme o envio no aplicativo. Abrir esta tela não envia mensagens.</small>
    </div>}
    {!row.pdfPath && !row.publicUrl && <p className="record-hint">Este boleto ainda não tem link disponível para envio. Planejamentos não geram boletos ao abrir esta tela.</p>}
  </article>;
}

export function CustomerDocuments({ customer, organizationId, role, endSession, onClose, initialKind = "INVOICE", initialDocumentId }: PageAccess & {
  customer: RecordData & { id: string; name: string }; onClose: () => void;
  initialKind?: Kind; initialDocumentId?: string;
}) {
  const request = useRegistrationRequest(organizationId, endSession);
  const requestFile = useRegistrationResponse(organizationId, endSession);
  const [kind, setKind] = useState<Kind>(initialKind === "BOLETO" && !["OWNER", "ADMIN", "ACCOUNTANT"].includes(role) ? "INVOICE" : initialKind);
  const [documentId, setDocumentId] = useState(initialDocumentId);
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [data, setData] = useState<{ items: Document[]; hasNext: boolean }>();
  const [error, setError] = useState("");
  const [contact, setContact] = useState(customer);
  const [editingContact, setEditingContact] = useState(false);
  const [contactBusy, setContactBusy] = useState(false);
  const [contactError, setContactError] = useState("");
  const [contactNotice, setContactNotice] = useState("");
  const canEditContact = ["OWNER", "ADMIN", "OPERATOR"].includes(role);
  const contactForm = useRef<HTMLDivElement>(null);
  const canViewBilling = ["OWNER", "ADMIN", "ACCOUNTANT"].includes(role);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (editingContact) contactForm.current?.scrollIntoView({ block: "center", behavior: "instant" }); }, [editingContact]);
  async function saveContact(data: RecordData) {
    setContactBusy(true); setContactError(""); setContactNotice("");
    try {
      const saved = await request<typeof customer>("customers/" + encodeURIComponent(customer.id), jsonMutation("PATCH", data));
      setContact(saved); setEditingContact(false); setContactNotice("Contato salvo. Os canais cadastrados já podem ser usados nesta tela.");
    } catch (failure) { setContactError(errorMessage(failure)); }
    finally { setContactBusy(false); }
  }
  useEffect(() => { heading.current?.focus(); heading.current?.scrollIntoView({ block: "start", behavior: "instant" }); }, []);
  useEffect(() => {
    const controller = new AbortController(); setData(undefined); setError("");
    request<{ items: Document[]; hasNext: boolean }>(`customers/${encodeURIComponent(customer.id)}/documents?kind=${kind}&page=${page}` + (documentId ? "&documentId=" + encodeURIComponent(documentId) : ""), { signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setData(response); })
      .catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [customer.id, kind, documentId, page, retry, request]);
  return <section className="registry-card customer-documents" aria-label="Enviar documentos do cliente">
    <h2 ref={heading} tabIndex={-1}>Enviar documentos · {customer.name}</h2>
    <CollectionHeading icon="message" title="Contato do responsável" description="Escolha um documento já existente e confira o destinatário.">
      <button type="button" className="button-secondary" onClick={onClose}>Fechar envio</button>
    </CollectionHeading>
    <CustomerContact customer={contact} />
    <p className="record-hint">WhatsApp e e-mail são opcionais e independentes. Cadastre um deles ou ambos.</p>
    {canEditContact && !editingContact && <button type="button" className="button-secondary" onClick={() => { setEditingContact(true); setContactNotice(""); }}>Cadastrar ou editar WhatsApp / e-mail</button>}
    {contactNotice && <p role="status" className="registry-notice">{contactNotice}</p>}
    {editingContact && canEditContact && <div ref={contactForm} className="customer-contact-form">
      {contactError && <p role="alert" className="registry-error">{contactError}</p>}
      <RecordForm fields={customerResponsibleFields} values={contact} busy={contactBusy} onSave={(data) => void saveContact(data)} onClose={() => { setEditingContact(false); setContactError(""); }} />
    </div>}
    <div className="collection-filter record-form"><label>Tipo de documento<select value={kind} onChange={(event) => { setKind(event.target.value as Kind); setDocumentId(undefined); setPage(1); }}>
      {Object.entries(kinds).filter(([value]) => value !== "BOLETO" || canViewBilling).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label><span className="record-hint">Nenhuma nota ou cobrança é criada nesta tela.</span></div>
    {documentId && <button type="button" className="button-secondary" onClick={() => { setDocumentId(undefined); setPage(1); }}>Mostrar todos os documentos deste tipo</button>}
    {error && <><p role="alert" className="registry-error">{error}</p><button onClick={() => setRetry(retry + 1)}>Tentar novamente</button></>}
    {!data && !error && <p role="status">Consultando documentos…</p>}
    {data?.items.map((row) => <DocumentSend key={kind + row.id} row={row} customer={contact} request={requestFile}
      editContact={canEditContact ? () => setEditingContact(true) : undefined} />)}
    {data && !data.items.length && <EmptyCollection icon="document" title="Nenhum documento nesta página" description="Somente documentos já salvos para este cliente aparecem aqui. Notas fiscais precisam estar autorizadas e ter XML disponível." />}
    {data && (page > 1 || data.hasNext) && <div className="record-actions registry-pagination">
      <button className="button-secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Anterior</button><span>Página {page}</span>
      <button className="button-secondary" disabled={!data.hasNext || page >= 10000} onClick={() => setPage(page + 1)}>Próxima</button>
    </div>}
  </section>;
}

export function CustomerDocumentsPage({ customerId, kind, documentId, ...access }: PageAccess & {
  customerId: string; kind: string | null; documentId: string | null;
}) {
  const request = useRegistrationRequest(access.organizationId, access.endSession);
  const [customer, setCustomer] = useState<RecordData & { id: string; name: string }>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setCustomer(undefined); setError("");
    request<RecordData & { id: string; name: string }>("customers/" + encodeURIComponent(customerId), { signal: controller.signal })
      .then((row) => { if (!controller.signal.aborted) setCustomer(row); })
      .catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [customerId, request, retry]);
  return <>{error && <div className="registry-card"><p role="alert" className="registry-error">{error}</p><button type="button" onClick={() => setRetry(retry + 1)}>Tentar novamente</button></div>}
    {!customer && !error && <p role="status">Consultando responsável do cliente…</p>}
    {customer && <CustomerDocuments key={customerId + ":" + kind + ":" + documentId} {...access} customer={customer}
      initialKind={kind && Object.hasOwn(kinds, kind) ? kind as Kind : "INVOICE"} initialDocumentId={documentId ?? undefined}
      onClose={() => { window.location.hash = "clientes"; }} />}</>;
}
