import { useEffect, useRef, useState } from "react";
import { normalizeDocument } from "../format";
import { DocumentInput } from "../formatted-inputs";
import { jsonMutation, RegistrationError, type useRegistrationRequest } from "../registrations/api";
import { CatalogPicker } from "./catalog-picker";

export type InvoiceCustomerValue =
  | { customerId: string }
  | { customerCnpj: string; customerName: string }
  | { customerCpf: string; customerName: string };
type CustomerPickerProps = {
  request: ReturnType<typeof useRegistrationRequest>;
  onChange: (customer: InvoiceCustomerValue | undefined) => void;
};
type Lookup =
  | { source: "registered"; customerId: string; name: string }
  | { source: "public"; name: string }
  | { source: "not-found" | "unavailable" };
type DocumentType = "cpf" | "cnpj";
const searchLabels = { cnpj: "Buscar pelo CNPJ", cpf: "Buscar pelo CPF", name: "Buscar pelo nome" };
const searchModes = ["cnpj", "cpf", "name"] as const;

function DocumentCustomer({ request, onChange, type }: CustomerPickerProps & { type: DocumentType }) {
  const [document, setDocument] = useState("");
  const [lookup, setLookup] = useState<Lookup>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const isCpf = type === "cpf";
  const documentLabel = isCpf ? "CPF" : "CNPJ";
  const nameLabel = isCpf ? "Nome completo" : "Razão social";
  const complete = (isCpf ? /^\d{11}$/ : /^[A-Z0-9]{12}\d{2}$/).test(document);

  useEffect(() => {
    if (!complete) return;
    const controller = new AbortController();
    pending.current = controller;
    const timer = window.setTimeout(async () => {
      try {
        const result = await request<Lookup>("invoices/customer-lookup", {
          ...jsonMutation("POST", { [type]: document }), signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setLookup(result);
        if (result.source === "registered") onChange({ customerId: result.customerId });
        if (type === "cnpj" && result.source === "public") {
          setName(result.name);
          onChange({ customerCnpj: document, customerName: result.name });
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof RegistrationError) {
          if (failure.status === 400) {
            setError(`Confira os dígitos do ${documentLabel}.`);
            return;
          }
          if (failure.code === "customer-archived") {
            setError("Este cliente está arquivado. Selecione outro cliente para a nota.");
            return;
          }
          if (failure.status === 403) {
            setError("Seu acesso não permite consultar clientes para emissão.");
            return;
          }
        }
        setLookup({ source: "unavailable" });
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [document, complete, documentLabel, onChange, request, type]);

  return <>
    <label>{documentLabel} do cliente
      <DocumentInput mode={type} required maxLength={isCpf ? 14 : 18} autoComplete="off" onDocumentChange={(value) => {
        const normalized = normalizeDocument(value);
        if (normalized === document) return;
        pending.current?.abort();
        setDocument(normalized);
        setLookup(undefined);
        setError("");
        setName("");
        onChange(undefined);
      }} />
    </label>
    <div className="invoice-customer-status" role="status">
      {complete && !lookup && !error && "Buscando cliente…"}
      {lookup?.source === "registered" && <><strong>{lookup.name}</strong> · Cliente cadastrado</>}
      {lookup?.source === "public" && "Razão social encontrada na BrasilAPI. Confira antes de continuar."}
      {lookup?.source === "not-found" && (isCpf ? "CPF ainda sem cadastro. Informe o nome completo para continuar."
        : "CNPJ sem resultado na consulta. Informe a razão social para continuar.")}
      {lookup?.source === "unavailable" && `Consulta indisponível. Informe ${isCpf ? "o nome completo" : "a razão social"} para continuar.`}
    </div>
    {error && <p role="alert" className="registry-error">{error}</p>}
    {lookup && lookup.source !== "registered" && <label>{nameLabel}
      <input value={name} required maxLength={160} autoComplete={isCpf ? "off" : "organization"} onChange={(event) => {
        const customerName = event.target.value.trim();
        setName(event.target.value);
        const customer = isCpf ? { customerCpf: document, customerName } : { customerCnpj: document, customerName };
        onChange(customerName ? customer : undefined);
      }} />
    </label>}
  </>;
}

export function InvoiceCustomer({ request, onChange }: CustomerPickerProps) {
  const [mode, setMode] = useState<typeof searchModes[number]>("cnpj");
  const [customerId, setCustomerId] = useState("");
  return <div className="invoice-customer">
    <div className="invoice-customer-heading">
      <strong>Tomador da nota</strong>
      <div className="invoice-customer-search">
        {searchModes.filter((option) => option !== mode).map((option) => (
          <button key={option} type="button" className="button-link" onClick={() => {
            setMode(option);
            setCustomerId("");
            onChange(undefined);
          }}>{searchLabels[option]}</button>
        ))}
      </div>
    </div>
    {mode === "name"
      ? <CatalogPicker request={request} resource="customers" label="Cliente" value={customerId} onChange={(option) => {
        setCustomerId(option?.id ?? "");
        onChange(option ? { customerId: option.id } : undefined);
      }} />
      : <DocumentCustomer key={mode} type={mode} request={request} onChange={onChange} />}
  </div>;
}
