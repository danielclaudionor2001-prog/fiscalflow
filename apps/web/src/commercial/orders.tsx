import { DateInput } from "../formatted-inputs";
import { useState } from "react";
import { CatalogPicker, type CatalogOption } from "../invoices/catalog-picker";
import { useRegistrationRequest, type PageAccess } from "../registrations/api";
import { brl, dateLabel, Editor, field, jsonRequest, localToday, Notice, Pager, timeLabel, useAction, useResource, useSubmissionKey, type Listing, type Request } from "./shared";

export type CommercialKind = "QUOTE" | "SERVICE_ORDER" | "SALE";
type Status = "OPEN" | "CONFIRMED" | "CANCELLED";
type Item = { id: string; label: string; quantity: number; unitPrice: string; productId: string | null; serviceId: string | null };
type OrderRow = { id: string; status: Status; customerName: string | null; amount: string; createdAt: string; dueOn: string | null };
type Order = OrderRow & {
  kind: CommercialKind; note: string; updatedAt: string; customerId: string | null; sellerName: string | null;
  commissionBps: number; installments: number; items: Item[]; convertedSale: { id: string } | null; invoice: { id: string; discardedAt: string | null } | null;
};
type ItemType = "PRODUCT" | "SERVICE";
type EditableItem = { key: string; id: string; type: ItemType; label: string; quantity: string; price: string };
const labels = { QUOTE: "Orçamento", SERVICE_ORDER: "Ordem de serviço", SALE: "Venda" };
const routes = { QUOTE: "orcamentos", SERVICE_ORDER: "ordens-servico", SALE: "vendas" };
const createLabels = { QUOTE: "Novo orçamento", SERVICE_ORDER: "Nova ordem de serviço", SALE: "Nova venda" };

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

  return <Editor title={order ? "Editar " + labels[kind].toLowerCase() : createLabels[kind]} action={action} onClose={close} onSubmit={async (form) => {
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
    <CatalogPicker request={request} resource="customers" label="Cliente" value={customer?.id ?? ""} initial={customer} onChange={setCustomer} required={kind !== "SALE"} />
    <DateInput label={kind === "SALE" ? "Vencimento do recebimento" : kind === "QUOTE" ? "Válido até" : "Prazo de entrega"} name="dueOn" required={kind === "SALE"} defaultValue={order?.dueOn?.slice(0, 10) ?? (kind === "SALE" ? localToday() : "")} />
    {kind === "SALE" && <label>Parcelas mensais<input name="installments" type="number" min={1} max={24} required defaultValue={order?.installments ?? 1} /></label>}
    <label>Responsável<input name="seller" maxLength={160} defaultValue={order?.sellerName ?? ""} /></label>
    {kind === "SALE" && <label>Comissão (%)<input name="commission" type="number" min={0} max={100} step={0.01} defaultValue={(order?.commissionBps ?? 0) / 100} /></label>}
    <label className="commercial-wide">Observações<textarea name="note" rows={3} maxLength={2000} defaultValue={order?.note} /></label>
    <div className="commercial-wide commercial-items">
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
        <button type="button" className="secondary" onClick={() => setItems((current) => current.filter(({ key }) => key !== item.key))}>Retirar</button>
      </div>)}
      <p className="commercial-total">Total <strong>{brl(total)}</strong></p>
    </div>
  </Editor>;
}

function OrderDetail({ request, id, kind, write, manage }: {
  request: Request; id: string; kind: CommercialKind; write: boolean; manage: boolean;
}) {
  const route = "commercial/orders/" + encodeURIComponent(id);
  const detail = useResource<Order>(request, route);
  const organization = useResource<{ legalName: string; tradeName: string | null }>(request, "organizations/current");
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const action = useAction();
  const order = detail.data;
  if (!order) return <Notice error={detail.error} pending reload={detail.reload} />;
  if (order.kind !== kind) return <p role="alert">O registro pertence a outra seção comercial.</p>;

  function act(name: string, confirm: string, success: string) {
    if (!order || !window.confirm(confirm)) return;
    void action.run(async () => {
      const result = await request<{ id?: string; invoiceId?: string }>(route + "/" + name,
        jsonRequest("POST", undefined, { "If-Match": '"' + order.updatedAt + '"' }));
      if (name === "convert" && result.id) {
        window.location.hash = "vendas?id=" + encodeURIComponent(result.id);
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
  const activeInvoice = order.invoice && !order.invoice.discardedAt;
  const singleService = new Set(order.items.flatMap((item) => item.serviceId ?? [])).size === 1;
  const canConvert = !order.convertedSale && ((kind === "QUOTE" && order.status === "OPEN") || (kind === "SERVICE_ORDER" && confirmed));
  return <div className="commercial-stack">
    <div className="commercial-toolbar">
      <a href={"#" + routes[kind]}>← Voltar para a lista</a>
      <button type="button" className="secondary" onClick={() => window.print()}>Imprimir / salvar PDF</button>
    </div>
    <Notice error={detail.error} reload={detail.reload} />
    <Notice error={action.error} reload={detail.reload} />
    {notice && <p role="status" className="registry-notice">{notice}</p>}
    <section className="panel commercial-panel commercial-print">
      <div className="commercial-toolbar">
        <div><p>{organization.data?.tradeName ?? organization.data?.legalName ?? "Fiscal Floow"}</p>
          <h2>{labels[kind]} · {order.id.slice(-8).toUpperCase()}</h2>
        </div>
        <span className="commercial-badge">{statusLabel(kind, order.status)}</span>
      </div>
      <dl className="commercial-facts">
        <div><dt>Cliente</dt><dd>{order.customerName ?? "Cliente avulso"}</dd></div>
        <div><dt>Registro</dt><dd>{timeLabel(order.createdAt)}</dd></div>
        <div><dt>{kind === "QUOTE" ? "Validade" : "Prazo"}</dt><dd>{order.dueOn ? dateLabel(order.dueOn) : "—"}</dd></div>
        {kind === "SALE" && <div><dt>Parcelas</dt><dd>{order.installments}</dd></div>}
        {order.sellerName && <div><dt>Responsável</dt><dd>{order.sellerName}</dd></div>}
      </dl>
      <div className="registry-table"><table>
        <thead><tr><th scope="col">Item</th><th scope="col">Qtd.</th><th scope="col">Unitário</th><th scope="col">Subtotal</th></tr></thead>
        <tbody>{order.items.map((item) => <tr key={item.id}><td>{item.label}</td><td>{item.quantity}</td>
          <td>{brl(item.unitPrice)}</td><td>{brl(Number(item.unitPrice) * item.quantity)}</td></tr>)}</tbody>
      </table></div>
      {order.note && <p className="commercial-note">{order.note}</p>}
      <p className="commercial-total">Total <strong>{brl(order.amount)}</strong></p>
      <small>Documento comercial · Sem valor fiscal</small>
    </section>
    <div className="commercial-actions">
      {write && order.status === "OPEN" && <button type="button" className="secondary" disabled={action.busy} onClick={() => setEditing(true)}>Editar</button>}
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
      {activeInvoice && <a href="#rascunhos">Ver rascunhos de NFS-e</a>}
      {manage && order.status !== "CANCELLED" && !order.convertedSale && !activeInvoice && <button className="secondary" disabled={action.busy}
        onClick={() => act("cancel", "Cancelar este registro comercial?", "Registro cancelado.")}>Cancelar registro</button>}
    </div>
  </div>;
}

export function OrdersPage({ kind, id, role, organizationId, endSession }: PageAccess & { kind: CommercialKind; id: string | null }) {
  const request = useRegistrationRequest(organizationId, endSession);
  const manage = role === "OWNER" || role === "ADMIN";
  const write = manage || role === "OPERATOR";
  if (id) return <OrderDetail key={id} request={request} id={id} kind={kind} write={write} manage={manage} />;
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
    <div className="commercial-toolbar">
      <label className="commercial-filter">Situação<select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
        <option value="">Todas</option>
        {(["OPEN", "CONFIRMED", "CANCELLED"] as const).map((value) => <option key={value} value={value}>{statusLabel(kind, value)}</option>)}
      </select></label>
      {write && <button type="button" onClick={() => setCreating(true)}>{createLabels[kind]}</button>}
    </div>
    <Notice error={listing.error} pending={!listing.data} reload={listing.reload} />
    {listing.data && <section className="panel commercial-panel">
      {listing.data.items.length === 0 && <p>Nenhum registro nesta página.</p>}
      <div className="commercial-list">{listing.data.items.map((row) => <article key={row.id}>
        <div><strong>{row.customerName ?? "Cliente avulso"}</strong>
          <p>{timeLabel(row.createdAt)} · {brl(row.amount)}</p>
          <span className="commercial-badge">{statusLabel(kind, row.status)}</span>
        </div>
        <a className="button secondary" href={href + "?id=" + encodeURIComponent(row.id)}>Ver detalhes</a>
      </article>)}</div>
      <Pager page={page} hasNext={listing.data.hasNext} onChange={setPage} />
    </section>}
  </div>;
}
