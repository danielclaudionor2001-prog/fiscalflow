import { useState } from "react";
import { CatalogPicker, type CatalogOption } from "../invoices/catalog-picker";
import { useRegistrationRequest, type PageAccess } from "../registrations/api";
import { brl, Editor, field, jsonRequest, MoneyField, Notice, Pager, timeLabel, useAction, useResource, useSubmissionKey, type Listing, type Request } from "./shared";

import { formatDocument } from "../format";
import { RecordFields, RecordForm, type Field } from "../registrations/form";
import { addressFields, contactFields, reformFields, registrationFields } from "../registrations/profile-fields";
import type { RecordData } from "../registrations/api";
import { CollectionHeading, EmptyCollection, EntityTitle, PageCount, StatusPill } from "../collection-ui";
import { Icon } from "../ui";

type Supplier = RecordData & { id: string; name: string; federalTaxId: string | null; email: string | null; phone: string | null; archivedAt?: string };
type Product = {
  id: string; name: string; sku: string; price: string; cost: string; stock: number; minimumStock: number; supplier: Supplier | null;
  description: string | null; unit: string | null; ncmCode: string | null; cfopCode: string | null; icmsCst: string | null;
  csosnCode: string | null; ibsCbsCst: string | null; ibsCbsClassCode: string | null;
  ibsStateRate: string | null; ibsMunicipalRate: string | null; cbsRate: string | null;
};
type Movement = { id: string; quantity: number; reason: string; createdAt: string };
type EditorMode<T> = { row?: T };
const supplierFields: Field[] = [
  { name: "name", label: "Nome ou razão social", maxLength: 160, required: true },
  { name: "tradeName", label: "Nome fantasia", maxLength: 160 },
  { name: "federalTaxId", label: "CPF ou CNPJ", kind: "document" },
  { name: "email", label: "E-mail", kind: "email", maxLength: 254 },
  { name: "phone", label: "Telefone", maxLength: 32 },
  ...registrationFields, ...addressFields, ...contactFields,
];
const productProfileFields: Field[] = [
  { name: "description", label: "Descrição do produto", kind: "multiline", section: "Identificação do produto", maxLength: 2000 },
  { name: "unit", label: "Unidade comercial", maxLength: 12, hint: "Exemplos: UN, PC, KG ou M." },
  { name: "ncmCode", label: "NCM", section: "Classificação fiscal do produto", maxLength: 10, pattern: "[0-9.]{8,10}" },
  { name: "cfopCode", label: "CFOP", maxLength: 5, pattern: "[0-9.]{4,5}" },
  { name: "icmsCst", label: "CST do ICMS", maxLength: 2, pattern: "[0-9]{2}" },
  { name: "csosnCode", label: "CSOSN (quando aplicável)", maxLength: 3, pattern: "[0-9]{3}" },
  ...reformFields,
  { name: "ibsStateRate", label: "Alíquota do IBS estadual (%)", kind: "decimal", maxLength: 8 },
  { name: "ibsMunicipalRate", label: "Alíquota do IBS municipal (%)", kind: "decimal", maxLength: 8 },
  { name: "cbsRate", label: "Alíquota da CBS (%)", kind: "decimal", maxLength: 8 },
];

function SupplierEditor({ request, row, close, saved }: { request: Request; row?: Supplier; close: () => void; saved: () => void }) {
  const action = useAction();
  return <section className="registry-card">
    <div className="registry-heading"><h2>{row ? "Editar fornecedor" : "Novo fornecedor"}</h2></div>
    <Notice error={action.error} />
    <RecordForm fields={supplierFields} values={row} busy={action.busy} onClose={close} onSave={(data) => {
      void action.run(async () => {
        await request("commercial/suppliers" + (row ? "/" + row.id : ""), jsonRequest(row ? "PATCH" : "POST", data));
        saved();
      });
    }} />
  </section>;
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
    <section className="registry-card"><CollectionHeading icon="building" title="Fornecedores da empresa" description="Contatos de compra, dados cadastrais e responsáveis financeiros.">
      {listing.data && <PageCount count={listing.data.items.length} page={page} />}
      {write && !editor && <button onClick={() => setEditor({})}><Icon name="plus" />Novo fornecedor</button>}
    </CollectionHeading></section>
    {write && editor && <SupplierEditor key={editor.row?.id ?? "new"} row={editor.row} request={request} close={() => setEditor(undefined)} saved={refresh} />}
    <Notice error={listing.error} pending={!listing.data} reload={listing.reload} />
    <Notice error={action.error} />
    {listing.data && <section className="panel commercial-panel">
      {listing.data.items.length === 0 && <EmptyCollection icon="building" title="Nenhum fornecedor nesta página" description="Cadastre seus parceiros para reunir os contatos comerciais e financeiros em um só lugar." />}
      <div className="commercial-list">
        {listing.data.items.map((row) => <article key={row.id}>
          <EntityTitle name={row.name} detail={[row.federalTaxId && formatDocument(row.federalTaxId), row.email, row.phone].filter(Boolean).join(" · ")} />
          {row.financialContactName && <p>Financeiro · {[row.financialContactName, row.financialContactEmail, row.financialContactPhone].filter(Boolean).join(" · ")}</p>}
          <div className="commercial-actions">
            {write && <button className="secondary" onClick={() => setEditor({ row })}>Editar</button>}
            {manage && <button className="secondary" disabled={action.busy} onClick={() => {
              if (window.confirm("Arquivar " + row.name + "?")) void action.run(async () => {
                await request("commercial/suppliers/" + row.id, { method: "DELETE" });
                refresh();
              });
            }}>Arquivar</button>}
          </div>
          <details className="commercial-wide">
            <summary>Endereço e contatos do fornecedor</summary>
            <RecordForm fields={supplierFields} values={row} />
          </details>
        </article>)}
      </div>
      <Pager page={page} hasNext={listing.data.hasNext} onChange={setPage} />
    </section>}
  </div>;
}

function ProductEditor({ request, row, close, saved }: { request: Request; row?: Product; close: () => void; saved: () => void }) {
  const [supplier, setSupplier] = useState<CatalogOption | undefined>(row?.supplier && !row.supplier.archivedAt ? { id: row.supplier.id, name: row.supplier.name } : undefined);
  const action = useAction();
  const { supplier: _supplier, stock: _stock, minimumStock: _minimum, ...profile } = row ?? {};
  return <Editor title={row ? "Editar produto" : "Novo produto"} className="record-form" action={action} onClose={close} onSubmit={async (form) => {
    await request("commercial/products" + (row ? "/" + row.id : ""), jsonRequest(row ? "PUT" : "POST", {
      name: field(form, "name"), sku: field(form, "sku"), price: field(form, "price"), cost: field(form, "cost"),
      minimumStock: Number(field(form, "minimum")), supplierId: supplier?.id ?? null,
      ...Object.fromEntries(productProfileFields.map(({ name }) => [name, field(form, name) || null])),
    }));
    saved();
  }}>
    <label>Nome<input name="name" required maxLength={160} defaultValue={row?.name} /></label>
    <label>Código (SKU)<input name="sku" required maxLength={48} pattern="[A-Za-z0-9._\-]+" defaultValue={row?.sku} /></label>
    <MoneyField name="price" label="Preço de venda" value={row?.price} />
    <MoneyField name="cost" label="Custo unitário" value={row?.cost} />
    <label>Estoque mínimo<input name="minimum" type="number" min={0} max={1_000_000_000} required defaultValue={row?.minimumStock ?? 0} /></label>
    <CatalogPicker request={request} resource="commercial/suppliers" label="Fornecedor" value={supplier?.id ?? ""} initial={supplier} onChange={setSupplier} />
    <RecordFields fields={productProfileFields} values={profile} />
    <p className="commercial-wide record-hint">Os códigos e alíquotas são parâmetros cadastrais para conferência fiscal. A emissão disponível no painel utiliza NFS-e de serviços.</p>
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
    <div><h2>Estoque • {product.name}</h2><p>Saldo atual: {product.stock} {product.unit ?? "un."}</p></div>
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
        <div><strong>{row.quantity > 0 ? "+" : ""}{row.quantity} {product.unit ?? "un."} · {row.reason}</strong><p>{timeLabel(row.createdAt)}</p></div>
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
    <section className="registry-card">
      <CollectionHeading icon="services" title="Produtos da empresa" description="Catálogo, preços e movimentações de estoque organizados.">
        {listing.data && <PageCount count={listing.data.items.length} page={page} />}
        {write && !editor && <button onClick={() => { setEditor({}); setStock(undefined); }}><Icon name="plus" />Novo produto</button>}
      </CollectionHeading>
      <form className="collection-filter commercial-fields" style={{ marginBottom: 0 }} onSubmit={(event) => {
        event.preventDefault();
        setQuery(field(new FormData(event.currentTarget), "search"));
        setPage(1);
        setStock(undefined);
      }}>
        <input name="search" aria-label="Buscar por nome ou SKU" maxLength={160} placeholder="Buscar por nome ou SKU" />
        <button className="secondary"><Icon name="search" />Buscar</button>
      </form>
    </section>
    {write && editor && <ProductEditor key={editor.row?.id ?? "new"} row={editor.row} request={request} close={() => setEditor(undefined)} saved={refresh} />}
    {product && <StockPanel key={product.id} product={product} manage={manage} request={request} close={() => setStock(undefined)} saved={listing.reload} />}
    <Notice error={listing.error} pending={!listing.data} reload={listing.reload} />
    <Notice error={action.error} />
    {listing.data && <section className="panel commercial-panel">
      {listing.data.items.length === 0 && <EmptyCollection icon="services" title="Nenhum produto encontrado" description="Busque por outro nome ou SKU, ou cadastre um produto para iniciar o seu catálogo." />}
      <div className="commercial-list">
        {listing.data.items.map((row) => {
          const { supplier: _supplier, stock: _stock, minimumStock: _minimum, ...profile } = row;
          return <article key={row.id}>
            <div><EntityTitle name={row.name} icon="services" detail={row.sku + " · " + brl(row.price) + " por " + (row.unit ?? "un.")} />
              <p><StatusPill tone={row.stock <= row.minimumStock ? "warning" : "positive"}>{row.stock} em estoque{row.stock <= row.minimumStock && " · no mínimo"}</StatusPill></p>
              {(row.ncmCode || row.ibsCbsCst || row.supplier) && <p>{[
                row.ncmCode && "NCM " + row.ncmCode, row.ibsCbsCst && "CST IBS/CBS " + row.ibsCbsCst,
                row.supplier && "Fornecedor " + row.supplier.name,
              ].filter(Boolean).join(" · ")}</p>}
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
            <details className="commercial-wide">
              <summary>Ficha fiscal do produto</summary>
              <RecordForm fields={productProfileFields} values={profile} />
            </details>
          </article>;
        })}
      </div>
      <Pager page={page} hasNext={listing.data.hasNext} onChange={(value) => { setPage(value); setStock(undefined); }} />
    </section>}
  </div>;
}
