import { useState, type FormEvent } from "react";
import type { RecordData } from "./api";

export type Field = {
  name: string;
  label: string;
  kind?: "email" | "decimal" | "multiline" | "checkbox";
  required?: boolean;
  maxLength?: number;
};

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
      const value = String(data.get(name) ?? "").trim();
      return [name, value || (required ? "" : null)];
    }).filter(([name, value]) => !values || value !== values[name]);
    setUnchanged(entries.length === 0);
    if (entries.length) onSave?.(Object.fromEntries(entries));
  }

  if (!onSave) {
    return (
      <>
        <dl className="record-details">
          {fields.map(({ name, label }) => {
            const value = values?.[name];
            return <div key={name}><dt>{label}</dt><dd>{typeof value === "boolean" ? (value ? "Sim" : "Não") : value ?? "—"}</dd></div>;
          })}
        </dl>
        {onClose && <button type="button" className="button-secondary" onClick={onClose}>Fechar</button>}
      </>
    );
  }

  return (
    <form className="record-form" onSubmit={submit} onChange={() => setUnchanged(false)}>
      <fieldset disabled={busy}>
        {fields.map(({ name, label, kind, required, maxLength }) => {
          const value = values?.[name];
          if (kind === "checkbox") {
            return <label className="record-checkbox" key={name}><input name={name} type="checkbox" defaultChecked={value !== false} />{label}</label>;
          }
          const input = { name, required, maxLength, defaultValue: typeof value === "string" ? value : "" };
          return (
            <label key={name}>
              {label}
              {kind === "multiline"
                ? <textarea {...input} rows={4} />
                : <input {...input} type={kind === "email" ? "email" : "text"} inputMode={kind === "decimal" ? "decimal" : undefined} />}
            </label>
          );
        })}
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
