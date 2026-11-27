import { useEffect, useState } from "react";
import { errorMessage, jsonMutation, useRegistrationRequest, type PageAccess, type RecordData } from "./api";
import { formatDocument } from "../format";
import { ArchiveConfirmation, RecordForm, type Field } from "./form";
import { addressFields, contactFields, reformFields, registrationFields } from "./profile-fields";
import { CustomerOrderSelect, type CustomerOrder } from "./customer-order";
import { CollectionHeading, EmptyCollection, PageCount, StatusPill } from "../collection-ui";
import { Icon } from "../ui";

const catalog = {
  customers: {
    label: "cliente",
    title: "Clientes",
    fields: [
      { name: "name", label: "Nome ou razão social", required: true, maxLength: 160 },
      { name: "federalTaxId", label: "CPF ou CNPJ", kind: "document", required: true },
      { name: "email", label: "E-mail", kind: "email", maxLength: 254 },
      { name: "phone", label: "Telefone", maxLength: 32 },
      ...registrationFields,
      ...addressFields,
      ...contactFields,
    ] satisfies Field[],
    columns: [{ name: "federalTaxId", label: "CPF ou CNPJ" }, { name: "email", label: "E-mail" }],
  },
  services: {
    label: "serviço",
    title: "Serviços",
    fields: [
      { name: "name", label: "Nome", required: true, maxLength: 160 },
      { name: "description", label: "Descrição", kind: "multiline", required: true, maxLength: 2000 },
      { name: "defaultAmount", label: "Valor padrão (R$)", kind: "decimal", required: true, maxLength: 15 },
      { name: "active", label: "Ativo", kind: "checkbox" },
      { name: "nationalServiceCode", label: "Código de tributação nacional (cTribNac)", section: "Classificação do serviço", maxLength: 40,
        hint: "Use o código completo de 6 dígitos da NFS-e Nacional, como 14.01.01." },
      { name: "municipalServiceCode", label: "Código complementar municipal (cTribMun)", maxLength: 40,
        hint: "Complemento de 3 dígitos definido pelo município para este serviço." },
      { name: "nbsCode", label: "NBS - Nomenclatura Brasileira de Serviços", maxLength: 13, pattern: "[0-9.]{9,13}",
        hint: "Código de 9 dígitos. Será sugerido na preparação da DPS." },
      ...reformFields,
      { name: "operationIndicator", label: "Indicador da operação (cIndOp)", maxLength: 6, pattern: "[0-9]{6}" },
    ] satisfies Field[],
    columns: [{ name: "defaultAmount", label: "Valor padrão (R$)" }, { name: "active", label: "Situação" }],
  },
};

type Item = RecordData & { id: string; name: string };
type Editor = { mode: "create" } | { mode: "view" | "edit"; item: Item };
type Listing = { items: Item[]; hasNext: boolean };

export function CatalogPage({ resource, role, organizationId, endSession }: PageAccess & { resource: keyof typeof catalog }) {
  const config = catalog[resource];
  const request = useRegistrationRequest(organizationId, endSession);
  const canArchive = role === "OWNER" || role === "ADMIN";
  const canWrite = canArchive || role === "OPERATOR";
  const [listing, setListing] = useState<Listing>();
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [editor, setEditor] = useState<Editor>();
  const [archiving, setArchiving] = useState<Item>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CustomerOrder>("name_asc");

  useEffect(() => {
    const timer = window.setTimeout(() => { setPage(1); setQuery(search.trim()); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    setListing(undefined);
    setError("");
    const params = new URLSearchParams({ page: String(page) });
    if (resource === "customers") {
      params.set("sort", sort);
      if (query) params.set("q", query);
    }
    request<Listing>(`${resource}?${params}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setListing(data); })
      .catch((error) => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [page, resource, version, request, query, sort]);

  async function save(data: RecordData) {
    if (!editor || editor.mode === "view") return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const creating = editor.mode === "create";
      const path = creating ? resource : `${resource}/${encodeURIComponent(editor.item.id)}`;
      await request(path, jsonMutation(creating ? "POST" : "PATCH", data));
      setEditor(undefined);
      setNotice("Cadastro salvo.");
      if (creating) setPage(1);
      setVersion((current) => current + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!archiving) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(`${resource}/${encodeURIComponent(archiving.id)}`, { method: "DELETE" });
      setArchiving(undefined);
      setEditor(undefined);
      setNotice("Cadastro arquivado.");
      if (listing?.items.length === 1 && page > 1) setPage(page - 1);
      setVersion((current) => current + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="registry">
      {error && <p role="alert" className="registry-error">{error}</p>}
      {notice && <p role="status" className="registry-notice">{notice}</p>}
      {editor && (
        <div className="registry-card">
          <h2>{editor.mode === "create" ? `Novo ${config.label}` : editor.item.name}</h2>
          {resource === "customers" && editor.mode === "view" &&
            <p><a href={"#clientes?notas=" + encodeURIComponent(editor.item.id)}>Ver notas do cliente</a></p>}
          <RecordForm
            key={editor.mode === "create" ? "new" : `${editor.mode}-${editor.item.id}`}
            fields={config.fields}
            values={editor.mode === "create" ? undefined : editor.item}
            busy={busy}
            onSave={editor.mode === "view" ? undefined : save}
            onClose={() => { setEditor(undefined); setError(""); }}
          />
        </div>
      )}
      {archiving && <ArchiveConfirmation name={archiving.name} busy={busy} onArchive={archive} onCancel={() => setArchiving(undefined)} />}
      <div className="registry-card">
        <CollectionHeading icon={resource === "customers" ? "clients" : "services"} title={`${config.title} da empresa`}
          description={resource === "customers" ? "Contatos, dados fiscais e histórico de cada cliente." : "Seu catálogo de serviços e parâmetros para as notas."}>
          {listing && <PageCount count={listing.items.length} page={page} />}
          {canWrite && <button disabled={busy} onClick={() => { setEditor({ mode: "create" }); setArchiving(undefined); setError(""); setNotice(""); }}>
            <Icon name="plus" />Novo {config.label}
          </button>}
        </CollectionHeading>
        {resource === "customers" && <div className="catalog-list-tools record-form">
          <label>Pesquisar cliente pelo nome<input type="search" value={search} maxLength={120}
            placeholder="Digite o nome ou a razão social" onChange={(event) => setSearch(event.target.value)} /></label>
          <CustomerOrderSelect value={sort} onChange={(value) => { setPage(1); setSort(value); }} />
        </div>}
        {!listing && (error
          ? <button className="button-secondary" onClick={() => setVersion((current) => current + 1)}>Tentar novamente</button>
          : <p role="status">Carregando cadastros…</p>)}
        {listing && (listing.items.length
          ? (
            <div className="registry-table compact-table collection-table">
              <table role="table" aria-label={config.title}>
                <thead><tr><th scope="col">Nome</th>{config.columns.map(({ name, label }) => <th key={name} scope="col">{label}</th>)}{(canWrite || resource === "customers") && <th scope="col">Ações</th>}</tr></thead>
                <tbody role="rowgroup">
                  {listing.items.map((item) => (
                    <tr role="row" key={item.id}>
                      <td role="cell" className="cell-wide"><div className="collection-entity">
                        <span className="collection-avatar" aria-hidden="true">{resource === "customers" ? item.name.slice(0, 2).toLocaleUpperCase("pt-BR") : <Icon name="services" />}</span>
                        <button className="button-link" disabled={busy} onClick={() => { setEditor({ mode: "view", item }); setArchiving(undefined); }}>{item.name}</button>
                      </div></td>
                      {config.columns.map(({ name, label }) => <td role="cell" data-label={label} key={name}>{name === "active" ? <StatusPill tone={item.active ? "positive" : "neutral"}>{item.active ? "Ativo" : "Inativo"}</StatusPill>
                        : name === "federalTaxId" && typeof item[name] === "string" ? formatDocument(item[name]) : item[name] ?? "—"}</td>)}
                      {(canWrite || resource === "customers") && (
                        <td role="cell" className="cell-wide"><div className="record-actions collection-row-actions">
                          {resource === "customers" && <a className="button button-secondary" href={"#clientes?notas=" + encodeURIComponent(item.id)}>Ver notas</a>}
                          {canWrite && <button className="button-secondary" disabled={busy} onClick={() => { setEditor({ mode: "edit", item }); setArchiving(undefined); setError(""); }}>Editar</button>}
                          {canArchive && resource === "customers" && <a href={"#notas-fiscais?cliente=" + encodeURIComponent(item.id)}>Configurar nota mensal</a>}
                          {canArchive && <button className="button-secondary" disabled={busy} onClick={() => { setArchiving(item); setEditor(undefined); setError(""); }}>Arquivar</button>}
                        </div></td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyCollection icon={resource === "customers" ? "clients" : "services"} title={resource === "customers" && query ? "Nenhum cliente encontrado" : "Nenhum cadastro nesta página"}
            description={resource === "customers" && query ? "Tente outro nome ou limpe a pesquisa para consultar os clientes da empresa." : `Use Novo ${config.label} para começar. Seus cadastros ficarão organizados nesta lista.`} />)}
        {listing && (page > 1 || listing.hasNext) && (
          <div className="record-actions registry-pagination">
            <button className="button-secondary" disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
            <span>Página {page}</span>
            <button className="button-secondary" disabled={busy || !listing.hasNext || page >= 10000} onClick={() => setPage(page + 1)}>Próxima</button>
          </div>
        )}
      </div>
    </div>
  );
}
