import { CommercialBrandHeader, type CommercialBrand } from "./branding";
import { brl, dateLabel, timeLabel } from "./shared";

export type CommercialDocumentData = {
  id: string; customerName: string | null; createdAt: string; dueOn: string | null; sellerName: string | null;
  items: { id: string; label: string; quantity: number; unitPrice: string }[];
  note: string; amount: string;
};

export function OrderDocument({ order, title, status, brand, quote, installments }: {
  order: CommercialDocumentData; title: string; status?: string; brand?: CommercialBrand; quote?: boolean; installments?: number;
}) {
  return <section className={"panel commercial-panel commercial-print commercial-document" + (quote ? " quote-document" : "")}>
    {quote && brand?.quoteWatermark && brand.logo &&
      <img className="commercial-watermark" src={brand.logo} alt="" aria-hidden="true" />}
    <div className="commercial-document-content">
      <CommercialBrandHeader brand={brand} />
      <div className="commercial-toolbar">
        <h2>{title} · {order.id.slice(-8).toUpperCase()}</h2>
        {status && <span className="commercial-badge">{status}</span>}
      </div>
      <dl className="commercial-facts">
        <div><dt>Cliente</dt><dd>{order.customerName ?? "Cliente avulso"}</dd></div>
        <div><dt>Registro</dt><dd>{timeLabel(order.createdAt)}</dd></div>
        <div><dt>{quote ? "Validade" : "Prazo"}</dt><dd>{order.dueOn ? dateLabel(order.dueOn) : "—"}</dd></div>
        {installments !== undefined && <div><dt>Parcelas</dt><dd>{installments}</dd></div>}
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
    </div>
  </section>;
}
