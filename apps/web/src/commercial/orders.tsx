import { DateInput } from "../formatted-inputs";
import { useState } from "react";
import { CatalogPicker, type CatalogOption } from "../invoices/catalog-picker";
import { useRegistrationRequest, useRegistrationResponse, type PageAccess } from "../registrations/api";
import { brl, Editor, field, jsonRequest, localToday, Notice, Pager, timeLabel, useAction, useResource, useSubmissionKey, type Listing, type Request } from "./shared";
import type { CommercialBrand } from "./branding";
import { OrderDocument } from "./order-document";
import { QuoteShareCard, quoteDecisionLabel, type QuoteShare } from "./quote-express";
import { QuoteNotes } from "./quote-notes";

export type CommercialKind = "QUOTE" | "SERVICE_ORDER" | "SALE";
type Status = "OPEN" | "CONFIRMED" | "CANCELLED";
type Item = { id: string; label: string; quantity: number; unitPrice: string; productId: string | null; serviceId: string | null };
type OrderRow = { id: string; status: Status; customerName: string | null; amount: string; createdAt: string; dueOn: string | null; quoteShare: QuoteShare | null };
type Order = OrderRow & {
  kind: CommercialKind; note: string; updatedAt: string; customerId: string | null; sellerName: string | null;
  commissionBps: number; installments: number; items: Item[]; convertedSale: { id: string } | null;
  invoice: { id: string; discardedAt: string | null; status: string } | null;
};
type ItemType = "PRODUCT" | "SERVICE";
type EditableItem = { key: string; id: string; type: ItemType; label: string; quantity: string; price: string };
const labels = { QUOTE: "Orçamento", SERVICE_ORDER: "Ordem de serviço", SALE: "Venda" };
const routes = { QUOTE: "orcamentos", SERVICE_ORDER: "ordens-servico", SALE: "vendas" };
const createLabels = { QUOTE: "Novo orçamento", SERVICE_ORDER: "Nova ordem de serviço", SALE: "Nova venda" };
const documentFields = { QUOTE: "Dados da proposta", SERVICE_ORDER: "Dados da ordem", SALE: "Dados da venda" };

function statusLabel(kind: CommercialKind, status: Status) {
  if (status === "OPEN") return kind === "SERVICE_ORDER" ? "Em execução" : "Em aberto";
  if (status === "CANCELLED") return "Cancelado";
  return { QUOTE: "Convertido em venda", SERVICE_ORDER: "Concluída", SALE: "Confirmada" }[kind];
}

function OrderEditor({ kind, order, request, close, saved }: {
  kind: CommercialKind; order?: Order; request: Request; close: () => void; saved: (row: Order) => void;
}) {
  const action = useAction();
  const submissionKey = useSubmissionKey();
  const quote = kind === "QUOTE";
  const sale = kind === "SALE";
  const brand = useResource<CommercialBrand>(request, "organizations/current/branding");
  const [createdAt] = useState(() => order?.createdAt ?? new Date().toISOString());
  const [note, setNote] = useState(order?.note ?? "");
  const [dueOn, setDueOn] = useState(() => order?.dueOn?.slice(0, 10) ?? (sale ? localToday() : ""));
  const [sellerName, setSellerName] = useState(order?.sellerName ?? "");
  const [payments, setPayments] = useState(String(order?.installments ?? 1));
  const [customer, setCustomer] = useState<CatalogOption | undefined>(
    order?.customerId ? { id: order.customerId, name: order.customerName ?? "Cliente" } : undefined,
  );
  const [items, setItems] = useState<EditableItem[]>(() => order?.items.map((item) => ({
    key: item.id, id: item.productId ?? item.serviceId!, type: item.productId ? "PRODUCT" : "SERVICE",
    label: item.label, quantity: String(item.quantity), price: item.unitPrice,
  })) ?? []);
  const [itemType, setItemType] = useState<ItemType>("SERVICE");
  const [option, setOption] = useState<CatalogOption>();
  function changeItem(key: string, fields: Partial<EditableItem>) {
    setItems((current) => current.map((item) => item.key === key ? { ...item, ...fields } : item));
  }
  function addItem() {
    if (!option || items.length >= 30) return;
    setItems([...items, {
      key: crypto.randomUUID(), id: option.id, type: itemType, label: option.name, quantity: "1",
      price: option.price ?? option.defaultAmount ?? "",
    }]);
    setOption(undefined);
  }
  const total = items.reduce((sum, item) => sum + Number(item.quantity) * (Number(item.price.replace(",", ".")) || 0), 0);
  const customerField = <CatalogPicker request={request} resource="customers" label="Cliente" value={customer?.id ?? ""}
    initial={customer} onChange={setCustomer} required={kind !== "SALE"} />;
  const dueDateField = <DateInput label={quote ? "Válido até" : kind === "SALE" ? "Vencimento do recebimento" : "Prazo de entrega"}
    name="dueOn" required={sale} defaultValue={dueOn} onDateChange={setDueOn} />;
  const sellerField = <label>Responsável<input name="seller" maxLength={160} value={sellerName} onChange={(event) => setSellerName(event.target.value)} /></label>;
  const itemsEditor = <div className="commercial-wide commercial-items">
      <h3>Itens</h3>
      <div className="commercial-item-picker">
        <label>Tipo de item<select value={itemType} onChange={(event) => {
          setItemType(event.target.value === "PRODUCT" ? "PRODUCT" : "SERVICE");
          setOption(undefined);
        }}><option value="SERVICE">Serviço</option><option value="PRODUCT">Produto</option></select></label>
        <CatalogPicker key={itemType} request={request} resource={itemType === "PRODUCT" ? "commercial/products" : "services"}
          label={itemType === "PRODUCT" ? "Produto do catálogo" : "Serviço do catálogo"} value={option?.id ?? ""} onChange={setOption} required={false} />
        <button type="button" className="secondary" onClick={addItem} disabled={!option || items.length >= 30}>Adicionar item</button>
      </div>
      {items.length === 0 && <p>Adicione pelo menos um produto ou serviço.</p>}
      {items.map((item) => <div key={item.key} className="commercial-item">
        <strong>{item.label}</strong>
        <label>Quantidade<input type="number" min={1} max={100_000} value={item.quantity} required
          onChange={(event) => changeItem(item.key, { quantity: event.target.value })} /></label>
        <label>Preço unitário<input inputMode="decimal" pattern="[0-9]+([.,][0-9]{1,2})?" maxLength={15} value={item.price} required
          onChange={(event) => changeItem(item.key, { price: event.target.value })} /></label>
        <button type="button" className="secondary" aria-label={"Retirar " + item.label}
          onClick={() => setItems((current) => current.filter(({ key }) => key !== item.key))}>Retirar</button>
      </div>)}
      <p className="commercial-total">Total <strong>{brl(total)}</strong></p>
    </div>;

  return <Editor title={order ? "Editar " + labels[kind].toLowerCase() : createLabels[kind]} action={action} onClose={close}
    className="order-editor" saveLabel={sale ? "Salvar venda" : "Salvar " + labels[kind].toLowerCase()} onSubmit={async (form) => {
      const payload = {
        customerId: customer?.id ?? null,
        note: field(form, "note"),
        dueOn: field(form, "dueOn") || null,
        installments: Number(field(form, "installments") || 1),
        sellerName: field(form, "seller") || null,
        commissionBps: Math.round(Number(field(form, "commission").replace(",", ".")) * 100),
        items: items.map(({ id, type, quantity, price }) => ({ id, type, quantity: Number(quantity), price })),
      };
      const row = order
        ? await request<Order>("commercial/orders/" + order.id, jsonRequest("PUT", payload, { "If-Match": '"' + order.updatedAt + '"' }))
        : await request<Order>("commercial/orders", jsonRequest("POST", { kind, order: payload }, { "Idempotency-Key": submissionKey(payload) }));
      saved(row);
    }}>
    <div className="order-composer commercial-wide">
      <div className="order-inputs">
        <section className="order-section">
          <h3>{documentFields[kind]}</h3>
          <div className="order-fields">
            <div className="commercial-wide">{customerField}</div>
            {dueDateField}
            {sellerField}
            {sale && <>
              <label>Parcelas mensais<input name="installments" type="number" min={1} max={24} required
                value={payments} onChange={(event) => setPayments(event.target.value)} /></label>
              <label>Comissão (%)<input name="commission" type="number" min={0} max={100} step={0.01}
                defaultValue={(order?.commissionBps ?? 0) / 100} /></label>
            </>}
          </div>
        </section>
        <section className="order-section">{itemsEditor}</section>
        {quote ? <QuoteNotes note={note} onChange={setNote} /> : <section className="order-section">
          <label>Observações<textarea name="note" rows={5} maxLength={2000} value={note}
            onChange={(event) => setNote(event.target.value)} /></label>
        </section>}
      </div>
      <aside className="order-preview" aria-label={quote ? "Prévia do orçamento" : sale ? "Prévia da venda" : "Prévia da ordem de serviço"}>
        <h3>{quote ? "Prévia do orçamento" : sale ? "Prévia da venda" : "Prévia da ordem de serviço"}</h3>
        <Notice error={brand.error} reload={brand.reload} />
        <OrderDocument title={labels[kind]} brand={brand.data} quote={quote} preview installments={sale ? Number(payments) || 1 : undefined} order={{
          id: order?.id ?? "", createdAt, dueOn, sellerName,
          customerName: customer?.name ?? null, note, amount: String(total),
          items: items.map(({ key, label, quantity, price }) => ({
            id: key, label, quantity: Number(quantity), unitPrice: String(Number(price.replace(",", ".")) || 0),
          })),
        }} />
      </aside>
    </div>
  </Editor>;
}

function OrderDetail({ request, requestFile, id, kind, write, manage, billingRead }: {
  request: Request; requestFile: ReturnType<typeof useRegistrationResponse>; id: string; kind: CommercialKind;
  write: boolean; manage: boolean; billingRead: boolean;
}) {
  const route = "commercial/orders/" + encodeURIComponent(id);
  const detail = useResource<Order>(request, route);
  const organization = useResource<CommercialBrand>(request, "organizations/current/branding");
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const action = useAction();
  const download = useAction();
  const order = detail.data;
  if (!order) return <Notice error={detail.error} pending reload={detail.reload} />;
  if (order.kind !== kind) return <p role="alert">O registro pertence a outra seção comercial.</p>;

  function downloadQuote(format: "pdf" | "docx") {
    if (!order) return;
    void download.run(async () => {
      let file: Blob;
      if (format === "docx") {
        if (!organization.data) return;
        const { createQuoteWord, wordMime } = await import("./quote-word");
        file = new Blob([Uint8Array.from(createQuoteWord(order, organization.data))], { type: wordMime });
      } else {
        file = await (await requestFile(route + "/pdf")).blob();
      }
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = "orcamento-" + id.slice(-8).toUpperCase() + "." + format;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  function act(name: string, confirm: string, success: string) {
    if (!order || !window.confirm(confirm)) return;
    void action.run(async () => {
      const result = await request<{ id?: string; invoiceId?: string }>(route + "/" + name,
        jsonRequest("POST", undefined, { "If-Match": '"' + order.updatedAt + '"' }));
      if (name === "convert" && result.id) {
        window.location.hash = "vendas?id=" + encodeURIComponent(result.id);
        return;
      }
      if (kind === "QUOTE" && name === "invoice-draft" && result.invoiceId) {
        window.location.hash = "notas-fiscais?nova=avulsa&nota=" + encodeURIComponent(result.invoiceId);
        return;
      }
      setNotice(success);
      detail.reload();
    });
  }

  if (editing) return <OrderEditor kind={kind} order={order} request={request} close={() => setEditing(false)} saved={() => {
    setEditing(false);
    detail.reload();
    setNotice("Registro atualizado.");
  }} />;

  const confirmed = order.status === "CONFIRMED";
  const activeInvoice = order.invoice && !order.invoice.discardedAt ? order.invoice : undefined;
  const singleService = new Set(order.items.flatMap((item) => item.serviceId ?? [])).size === 1;
  const approvedQuote = kind === "QUOTE" && order.status !== "CANCELLED" && order.quoteShare?.decision === "APPROVED";
  const fiscalAmount = order.items.reduce((sum, item) => sum + (item.serviceId ? Number(item.unitPrice) * item.quantity : 0), 0);
  const pendingQuote = order.quoteShare && !order.quoteShare.revokedAt && !order.quoteShare.decision &&
    Date.parse(order.quoteShare.expiresAt) > Date.now() && (!order.dueOn || order.dueOn.slice(0, 10) >= localToday());
  const canConvert = !order.convertedSale && ((kind === "QUOTE" && order.status === "OPEN" &&
    !pendingQuote && order.quoteShare?.decision !== "DECLINED") || (kind === "SERVICE_ORDER" && confirmed));
  return <div className="commercial-stack">
    <div className="commercial-toolbar">
      <a href={"#" + routes[kind]}>← Voltar para a lista</a>
      {kind === "QUOTE"
        ? <div className="commercial-actions quote-downloads">
          <button type="button" className="secondary" disabled={download.busy || !organization.data}
            onClick={() => downloadQuote("docx")}>Baixar Word</button>
          <button type="button" disabled={download.busy} onClick={() => downloadQuote("pdf")}>Baixar PDF</button>
          {download.busy && <span role="status">Preparando arquivo…</span>}
        </div>
        : <button type="button" className="secondary" disabled={!organization.data} onClick={() => window.print()}>Imprimir / salvar PDF</button>}
    </div>
    <Notice error={detail.error} reload={detail.reload} />
    <Notice error={action.error} reload={detail.reload} />
    <Notice error={download.error} />
    {notice && <p role="status" className="registry-notice">{notice}</p>}
    <Notice error={organization.error} reload={organization.reload} />
    <OrderDocument order={order} title={labels[kind]}
      status={order.status === "OPEN" ? quoteDecisionLabel(order.quoteShare) ?? statusLabel(kind, order.status) : statusLabel(kind, order.status)}
      brand={organization.data}
      quote={kind === "QUOTE"} installments={kind === "SALE" ? order.installments : undefined} />
    {kind === "QUOTE" && <QuoteShareCard request={request} id={order.id} updatedAt={order.updatedAt}
      status={order.status} dueOn={order.dueOn} share={order.quoteShare} write={write} reload={detail.reload} />}
    {approvedQuote && (write || billingRead) && <section className="commercial-panel approved-quote">
      <h2>Faturar orçamento aprovado</h2>
      <div className="approved-quote-actions">
        {write && <div>
          <h3>Nota fiscal de serviço</h3>
          {singleService && <p>Valor dos serviços · <strong>{brl(fiscalAmount)}</strong></p>}
          {activeInvoice ? <a className="button secondary" href={activeInvoice.status === "DRAFT"
            ? "#notas-fiscais?nova=avulsa&nota=" + encodeURIComponent(activeInvoice.id) : "#notas-fiscais"}>
            {activeInvoice.status === "DRAFT" ? "Retomar preparação da NFS-e" : "Consultar notas fiscais"}
          </a> : singleService
            ? <button type="button" disabled={action.busy} onClick={() => act("invoice-draft",
              "Preparar uma NFS-e com os serviços deste orçamento aprovado?", "")}>Preparar NFS-e</button>
            : <p>Para preparar uma única NFS-e aqui, o orçamento precisa ter itens de um único serviço cadastrado.</p>}
        </div>}
        {billingRead && <div>
          <h3>Boletos bancários</h3>
          <p>Total do orçamento · <strong>{brl(order.amount)}</strong>. Pagamento à vista ou parcelado.</p>
          <a className="button secondary" href={"#boletos?orcamento=" + encodeURIComponent(order.id)}>Abrir cobrança do orçamento</a>
        </div>}
      </div>
    </section>}
    <div className="commercial-actions">
      {write && order.status === "OPEN" && !order.quoteShare?.decision && <button type="button" className="secondary" disabled={action.busy} onClick={() => {
        if (!pendingQuote || window.confirm("As alterações vão desativar o link atual. Continuar?")) setEditing(true);
      }}>Editar</button>}
      {write && kind !== "QUOTE" && order.status === "OPEN" && <button disabled={action.busy} onClick={() => act("confirm",
        kind === "SALE" ? "Confirmar venda e lançar as parcelas no financeiro?" : "Marcar a ordem de serviço como concluída?",
        kind === "SALE" ? "Venda confirmada. Confira os recebíveis em Contas." : "Ordem de serviço concluída.")}>
        {kind === "SALE" ? "Confirmar venda" : "Concluir ordem"}
      </button>}
      {write && canConvert && <button disabled={action.busy} onClick={() => act("convert", "Criar uma venda a partir deste registro?", "")}>Converter em venda</button>}
      {order.convertedSale && <a href={"#vendas?id=" + encodeURIComponent(order.convertedSale.id)}>Abrir venda vinculada</a>}
      {write && kind === "SALE" && confirmed && !activeInvoice && order.customerId && singleService &&
        <button className="secondary" disabled={action.busy} onClick={() => act("invoice-draft",
          "Criar um rascunho de NFS-e com o valor dos serviços desta venda?", "Rascunho de NFS-e criado.")}>Criar rascunho de NFS-e</button>}
      {activeInvoice && kind !== "QUOTE" && <a href="#rascunhos">Ver rascunhos de NFS-e</a>}
      {manage && order.status !== "CANCELLED" && !order.convertedSale && !activeInvoice && <button className="secondary" disabled={action.busy}
        onClick={() => act("cancel", "Cancelar este registro comercial?", "Registro cancelado.")}>Cancelar registro</button>}
    </div>
  </div>;
}

export function OrdersPage({ kind, id, role, organizationId, endSession }: PageAccess & { kind: CommercialKind; id: string | null }) {
  const request = useRegistrationRequest(organizationId, endSession);
  const requestFile = useRegistrationResponse(organizationId, endSession);
  const manage = role === "OWNER" || role === "ADMIN";
  const write = manage || role === "OPERATOR";
  if (id) return <OrderDetail key={id} request={request} requestFile={requestFile} id={id} kind={kind} write={write} manage={manage}
    billingRead={manage || role === "ACCOUNTANT"} />;
  return <OrderList request={request} kind={kind} write={write} />;
}

function OrderList({ request, kind, write }: { request: Request; kind: CommercialKind; write: boolean }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const query = new URLSearchParams({ kind, page: String(page) });
  if (status) query.set("status", status);
  const listing = useResource<Listing<OrderRow>>(request, "commercial/orders?" + query);
  const href = "#" + routes[kind];
  if (creating) return <OrderEditor request={request} kind={kind} close={() => setCreating(false)} saved={(row) => {
    setCreating(false);
    window.location.hash = href + "?id=" + encodeURIComponent(row.id);
  }} />;
  return <div className="commercial-stack">
    <div className="commercial-toolbar order-list-toolbar">
      <label className="commercial-filter">Situação<select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
        <option value="">Todas</option>
        {(["OPEN", "CONFIRMED", "CANCELLED"] as const).map((value) => <option key={value} value={value}>{statusLabel(kind, value)}</option>)}
      </select></label>
      {write && <button type="button" onClick={() => setCreating(true)}>{createLabels[kind]}</button>}
    </div>
    <Notice error={listing.error} pending={!listing.data} reload={listing.reload} />
    {listing.data && <section className={listing.data.items.length ? "order-results" : "panel commercial-panel"}>
      {listing.data.items.length === 0 && <p>{kind === "QUOTE" ? "Nenhum orçamento nesta página." : "Nenhum registro nesta página."}</p>}
      <div className="order-list">{listing.data.items.map((row) => <article key={row.id}>
        <div><strong>{row.customerName ?? "Cliente avulso"}</strong>
          <p>{timeLabel(row.createdAt)}</p>
          <span className="commercial-badge">{row.status === "OPEN" ? quoteDecisionLabel(row.quoteShare) ?? statusLabel(kind, row.status) : statusLabel(kind, row.status)}</span>
        </div>
        <div className="order-card-total">
          <strong>{brl(row.amount)}</strong>
          <a className="button secondary" href={href + "?id=" + encodeURIComponent(row.id)}>Ver detalhes</a>
        </div>
      </article>)}</div>
      <Pager page={page} hasNext={listing.data.hasNext} onChange={setPage} />
    </section>}
  </div>;
}
