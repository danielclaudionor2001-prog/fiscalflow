import { useState } from "react";
import { CatalogPicker, type CatalogOption } from "../invoices/catalog-picker";
import { useRegistrationRequest, type PageAccess } from "../registrations/api";
import { brl, Editor, field, jsonRequest, MoneyField, Notice, Pager, timeLabel, useAction, useResource, useSubmissionKey, type Listing, type Request } from "./shared";

type Supplier = { id: string; name: string; federalTaxId: string | null; email: string | null; phone: string | null; archivedAt?: string };
type Product = { id: string; name: string; sku: string; price: string; cost: string; stock: number; minimumStock: number; supplier: Supplier | null };
type Movement = { id: string; quantity: number; reason: string; createdAt: string };
type EditorMode<T> = { row?: T };

function SupplierEditor({ request, row, close, saved }: { request: Request; row?: Supplier; close: () => void; saved: () => void }) {
  const action = useAction();
  return <Editor title={row ? "Editar fornecedor" : "Novo fornecedor"} action={action} onClose={close} onSubmit={async (form) => {
    await request("commercial/suppliers" + (row ? "/" + row.id : ""), jsonRequest(row ? "PATCH" : "POST", {
      name: field(form, "name"),
      federalTaxId: field(form, "document") || null,
      email: field(form, "email") || null,
      phone: field(form, "phone") || null,
    }));
    saved();
  }}>
    <label>Nome<input name="name" required maxLength={160} defaultValue={row?.name} /></label>
    <label>CPF ou CNPJ<input name="document" maxLength={32} defaultValue={row?.federalTaxId ?? ""} /></label>
    <label>E-mail<input name="email" type="email" maxLength={254} defaultValue={row?.email ?? ""} /></label>
    <label>Telefone<input name="phone" type="tel" maxLength={32} defaultValue={row?.phone ?? ""} /></label>
  </Editor>;
}

export function SuppliersPage({ role, organizationId, endSession }: PageAccess) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<EditorMode<Supplier>>();
  const listing = useResource<Listing<Supplier>>(request, "commercial/suppliers?page=" + page);
  const action = useAction();
  const manage = role === "OWNER" || role === "ADMIN";
  const write = manage || role === "OPERATOR";
  function refresh() {
    setEditor(undefined);
    listing.reload();
  }
  return <div className="commercial-stack">
    {write && !editor && <div><button onClick={() => setEditor({})}>Novo fornecedor</button></div>}
    {write && editor && <SupplierEditor key={editor.row?.id ?? "new"} row={editor.row} request={request} close={() => setEditor(undefined)} saved={refresh} />}
    <Notice error={listing.error} pending={!listing.data} reload={listing.reload} />
    <Notice error={action.error} />
    {listing.data && <section className="panel commercial-panel">
      {listing.data.items.length === 0 && <p>Nenhum fornecedor nesta página.</p>}
      <div className="commercial-list">
        {listing.data.items.map((row) => <article key={row.id}>
          <div><strong>{row.name}</strong><p>{[row.federalTaxId, row.email, row.phone].filter(Boolean).join(" · ")}</p></div>
          <div className="commercial-actions">
            {write && <button className="secondary" onClick={() => setEditor({ row })}>Editar</button>}
            {manage && <button className="secondary" disabled={action.busy} onClick={() => {
              if (window.confirm("Arquivar " + row.name + "?")) void action.run(async () => {
                await request("commercial/suppliers/" + row.id, { method: "DELETE" });
                refresh();
              });
            }}>Arquivar</button>}
          </div>
        </article>)}
      </div>
      <Pager page={page} hasNext={listing.data.hasNext} onChange={setPage} />
    </section>}
  </div>;
}

function ProductEditor({ request, row, close, saved }: { request: Request; row?: Product; close: () => void; saved: () => void }) {
  const [supplier, setSupplier] = useState<CatalogOption | undefined>(row?.supplier && !row.supplier.archivedAt ? { id: row.supplier.id, name: row.supplier.name } : undefined);
  const action = useAction();
  return <Editor title={row ? "Editar produto" : "Novo produto"} action={action} onClose={close} onSubmit={async (form) => {
    await request("commercial/products" + (row ? "/" + row.id : ""), jsonRequest(row ? "PUT" : "POST", {
      name: field(form, "name"), sku: field(form, "sku"), price: field(form, "price"), cost: field(form, "cost"),
      minimumStock: Number(field(form, "minimum")), supplierId: supplier?.id ?? null,
    }));
    saved();
  }}>
    <label>Nome<input name="name" required maxLength={160} defaultValue={row?.name} /></label>
    <label>Código (SKU)<input name="sku" required maxLength={48} pattern="[A-Za-z0-9._\-]+" defaultValue={row?.sku} /></label>
    <MoneyField name="price" label="Preço de venda" value={row?.price} />
    <MoneyField name="cost" label="Custo unitário" value={row?.cost} />
    <label>Estoque mínimo<input name="minimum" type="number" min={0} max={1_000_000_000} required defaultValue={row?.minimumStock ?? 0} /></label>
    <CatalogPicker request={request} resource="commercial/suppliers" label="Fornecedor" value={supplier?.id ?? ""} initial={supplier} onChange={setSupplier} />
  </Editor>;
}

function StockPanel({ product, manage, request, close, saved }: { product: Product; manage: boolean; request: Request; close: () => void; saved: () => void }) {
  const [page, setPage] = useState(1);
  const [direction, setDirection] = useState("in");
  const [notice, setNotice] = useState("");
  const [formVersion, setFormVersion] = useState(0);
  const route = "commercial/products/" + product.id + "/movements";
  const listing = useResource<Listing<Movement>>(request, route + "?page=" + page);
  const action = useAction();
  const submissionKey = useSubmissionKey();
  return <section className="panel commercial-panel">
    <div className="commercial-toolbar">
      <div><h2>Estoque • {product.name}</h2><p>Saldo atual: {product.stock} un.</p></div>
      <button className="secondary" onClick={close}>Fechar movimentações</button>
    </div>
    {manage && <form key={formVersion} onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const payload = { quantity: Number(field(form, "quantity")) * (direction === "in" ? 1 : -1), reason: field(form, "reason") };
      void action.run(async () => {
        await request(route, jsonRequest("POST", payload, { "Idempotency-Key": submissionKey({ ...payload, formVersion }) }));
        setNotice("Movimentação registrada.");
        setFormVersion((value) => value + 1);
        setPage(1);
        listing.reload();
        saved();
      });
    }}>
      <fieldset className="commercial-fields" disabled={action.busy}>
        <label>Movimento<select value={direction} onChange={(event) => setDirection(event.target.value)}><option value="in">Entrada</option><option value="out">Saída</option></select></label>
        <label>Quantidade<input name="quantity" type="number" min={1} max={100_000} required /></label>
        <label>Motivo<input name="reason" required maxLength={160} placeholder="Compra, devolução ou ajuste" /></label>
      </fieldset>
      <button disabled={action.busy}>Registrar movimento</button>
    </form>}
    <Notice error={action.error} />
    {notice && <p role="status">{notice}</p>}
    <Notice error={listing.error} pending={!listing.data} reload={listing.reload} />
    {listing.data && <div className="commercial-list">
      {listing.data.items.length === 0 && <p>O produto ainda não tem movimentações.</p>}
      {listing.data.items.map((row) => <article key={row.id}>
        <div><strong>{row.quantity > 0 ? "+" : ""}{row.quantity} un. · {row.reason}</strong><p>{timeLabel(row.createdAt)}</p></div>
      </article>)}
    </div>}
    <Pager page={page} hasNext={listing.data?.hasNext} onChange={setPage} />
  </section>;
}

export function ProductsPage({ role, organizationId, endSession }: PageAccess) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorMode<Product>>();
  const [stock, setStock] = useState<string>();
  const listing = useResource<Listing<Product>>(request, "commercial/products?" + new URLSearchParams({ page: String(page), q: query }));
  const action = useAction();
  const manage = role === "OWNER" || role === "ADMIN";
  const write = manage || role === "OPERATOR";
  const product = listing.data?.items.find((row) => row.id === stock);
  function refresh() {
    setEditor(undefined);
    listing.reload();
  }
  return <div className="commercial-stack">
    <div className="commercial-toolbar">
      <form className="commercial-actions" onSubmit={(event) => {
        event.preventDefault();
        setQuery(field(new FormData(event.currentTarget), "search"));
        setPage(1);
        setStock(undefined);
      }}>
        <input name="search" aria-label="Buscar por nome ou SKU" maxLength={160} placeholder="Buscar por nome ou SKU" />
        <button className="secondary">Buscar</button>
      </form>
      {write && !editor && <button onClick={() => { setEditor({}); setStock(undefined); }}>Novo produto</button>}
    </div>
    {write && editor && <ProductEditor key={editor.row?.id ?? "new"} row={editor.row} request={request} close={() => setEditor(undefined)} saved={refresh} />}
    {product && <StockPanel key={product.id} product={product} manage={manage} request={request} close={() => setStock(undefined)} saved={listing.reload} />}
    <Notice error={listing.error} pending={!listing.data} reload={listing.reload} />
    <Notice error={action.error} />
    {listing.data && <section className="panel commercial-panel">
      {listing.data.items.length === 0 && <p>Nenhum produto encontrado.</p>}
      <div className="commercial-list">
        {listing.data.items.map((row) => <article key={row.id}>
          <div><strong>{row.name}</strong><p>{row.sku} · {brl(row.price)} por un. · {row.stock} em estoque</p>
            {row.stock <= row.minimumStock && <span className="commercial-badge attention">Estoque no mínimo</span>}
          </div>
          <div className="commercial-actions">
            <button className="secondary" onClick={() => { setStock(row.id); setEditor(undefined); }}>Estoque</button>
            {write && <button className="secondary" onClick={() => { setEditor({ row }); setStock(undefined); }}>Editar</button>}
            {manage && <button className="secondary" disabled={action.busy} onClick={() => {
              if (window.confirm("Arquivar " + row.name + "?")) void action.run(async () => {
                await request("commercial/products/" + row.id, { method: "DELETE" });
                refresh();
              });
            }}>Arquivar</button>}
          </div>
        </article>)}
      </div>
      <Pager page={page} hasNext={listing.data.hasNext} onChange={(value) => { setPage(value); setStock(undefined); }} />
    </section>}
  </div>;
}
