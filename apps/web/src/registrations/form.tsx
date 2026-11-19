import { Fragment, useState, type FormEvent } from "react";
import { DocumentInput } from "../formatted-inputs";
import { formatDocument, normalizeDocument } from "../format";
import type { RecordData } from "./api";

export type Field = {
  name: string;
  label: string;
  kind?: "email" | "decimal" | "multiline" | "checkbox" | "document" | "cnpj" | "cpf";
  required?: boolean;
  maxLength?: number;
  section?: string;
  hint?: string;
  pattern?: string;
  options?: { value: string; label: string }[];
};

export function RecordFields({ fields, values }: Pick<FormProps, "fields" | "values">) {
  return <>{fields.map(({ name, label, kind, required, maxLength, section, hint, pattern, options }) => {
    const value = values?.[name];
    const input = { name, required, maxLength, defaultValue: typeof value === "string" ? value : "" };
    return <Fragment key={name}>
      {section && <div className="record-section"><h3>{section}</h3></div>}
      {kind === "checkbox"
        ? <label className="record-checkbox"><input name={name} type="checkbox" defaultChecked={value !== false} />{label}</label>
        : <label>{label}
          {options ? <select {...input}><option value="">Selecione</option>{options.map((option) =>
            <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            : kind === "multiline" ? <textarea {...input} rows={3} />
              : kind === "document" || kind === "cnpj" || kind === "cpf"
                ? <DocumentInput {...input} mode={kind === "document" ? "either" : kind} />
                : <input {...input} pattern={pattern} type={kind === "email" ? "email" : "text"}
                  inputMode={kind === "decimal" ? "decimal" : undefined} />}
          {hint && <small className="record-hint">{hint}</small>}
        </label>}
    </Fragment>;
  })}</>;
}

type FormProps = {
  fields: Field[];
  values?: RecordData;
  busy?: boolean;
  onSave?: (data: RecordData) => void;
  onClose?: () => void;
};

export function RecordForm({ fields, values, busy, onSave, onClose }: FormProps) {
  const [unchanged, setUnchanged] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const entries = fields.map(({ name, kind, required }): [string, RecordData[string]] => {
      if (kind === "checkbox") return [name, data.has(name)];
      const raw = String(data.get(name) ?? "").trim();
      const value = kind === "document" || kind === "cnpj" || kind === "cpf" ? normalizeDocument(raw) : raw;
      return [name, value || (required ? "" : null)];
    }).filter(([name, value]) => {
      if (!values) return true;
      const kind = fields.find((field) => field.name === name)?.kind;
      const previous = values[name];
      return value !== ((kind === "document" || kind === "cnpj" || kind === "cpf") && typeof previous === "string" ? normalizeDocument(previous) : previous);
    });
    setUnchanged(entries.length === 0);
    if (entries.length) onSave?.(Object.fromEntries(entries));
  }

  if (!onSave) {
    return (
      <>
        <dl className="record-details">
          {fields.map(({ name, label, kind, options, section }) => {
            const stored = values?.[name];
            const value = (kind === "document" || kind === "cnpj" || kind === "cpf") && typeof stored === "string"
              ? formatDocument(stored) : options?.find((option) => option.value === stored)?.label ?? stored;
            return <Fragment key={name}>{section && <div className="record-section"><dt>{section}</dt></div>}
              <div><dt>{label}</dt><dd>{typeof value === "boolean" ? (value ? "Sim" : "Não") : value ?? "—"}</dd></div></Fragment>;
          })}
        </dl>
        {onClose && <button type="button" className="button-secondary" onClick={onClose}>Fechar</button>}
      </>
    );
  }

  return (
    <form className="record-form" onSubmit={submit} onChange={() => setUnchanged(false)}>
      <fieldset disabled={busy}>
        <RecordFields fields={fields} values={values} />
      </fieldset>
      {unchanged && <p role="status">Altere um campo para salvar.</p>}
      <div className="record-actions">
        <button disabled={busy}>{busy ? "Salvando…" : "Salvar"}</button>
        {onClose && <button type="button" className="button-secondary" disabled={busy} onClick={onClose}>Cancelar</button>}
      </div>
    </form>
  );
}

export function ArchiveConfirmation({ name, busy, onArchive, onCancel }: {
  name: string;
  busy: boolean;
  onArchive: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="archive-confirmation">
      <p>Arquivar <strong>{name}</strong>? O histórico será preservado.</p>
      <div className="record-actions">
        <button className="button-danger" disabled={busy} onClick={onArchive}>{busy ? "Arquivando…" : "Confirmar arquivamento"}</button>
        <button className="button-secondary" disabled={busy} onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}
