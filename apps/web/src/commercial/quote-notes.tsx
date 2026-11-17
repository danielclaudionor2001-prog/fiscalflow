import { useId, useState, type ChangeEvent } from "react";

const documentPart = "word/document.xml";
const maxFileBytes = 5 * 1024 * 1024;
const maxBodyBytes = 2 * 1024 * 1024;
const maxCharacters = 2000;
const wordNamespaces = [
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
];

async function readWord(file: File) {
  const { unzipSync } = await import("fflate");
  let foundBody = false;
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter(entry) {
    if (entry.name !== documentPart) return false;
    if (foundBody || entry.originalSize > maxBodyBytes || entry.size > maxBodyBytes) throw new Error("Invalid document part");
    foundBody = true;
    return true;
  } });
  const bytes = files[documentPart];
  if (!bytes?.length) throw new Error("Missing document part");
  const xmlText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<!DOCTYPE/i.test(xmlText)) throw new Error("Unsupported document type");
  const document = new DOMParser().parseFromString(xmlText, "application/xml");
  const namespace = document.documentElement.namespaceURI ?? "";
  if (!wordNamespaces.includes(namespace) || document.documentElement.localName !== "document" || document.querySelector("parsererror")) {
    throw new Error("Invalid Word document");
  }
  const body = document.getElementsByTagNameNS(namespace, "body")[0];
  if (!body) throw new Error("Missing Word body");
  return Array.from(body.getElementsByTagNameNS(namespace, "p"), (paragraph) => {
    const pieces: string[] = [];
    for (const node of paragraph.getElementsByTagNameNS(namespace, "*")) {
      if (node.closest("del, moveFrom")) continue;
      if (node.localName === "t") pieces.push(node.textContent ?? "");
      else if (node.localName === "tab") pieces.push(" ");
      else if (node.localName === "br" || node.localName === "cr") pieces.push("\n");
    }
    return pieces.join("");
  }).join("\n").trim();
}

export function QuoteNotes({ note, onChange }: { note: string; onChange: (note: string) => void }) {
  const [imported, setImported] = useState<{ filename: string; text: string }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const helpId = useId();
  const noteId = useId();
  const countId = useId();

  async function importWord(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setImported(undefined);
    setNotice("");
    setError("");
    if (!/\.docx$/i.test(file.name) || !file.size || file.size > maxFileBytes) {
      setError("Selecione um documento Word (.docx) de até 5 MB.");
      return;
    }
    setBusy(true);
    try {
      const text = await readWord(file);
      if (!text) setError("O documento não contém texto para importar.");
      else {
        setImported({ filename: file.name, text: text.slice(0, maxCharacters) });
        if (text.length > maxCharacters) setNotice("As observações comportam 2.000 caracteres. Confira o trecho importado.");
      }
    } catch {
      setError("Não foi possível ler o arquivo. No Word, salve como .docx e tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  const appendText = [note.trimEnd(), imported?.text.trim()].filter(Boolean).join("\n\n");
  function apply(text: string) {
    onChange(text);
    setImported(undefined);
    setNotice("Texto importado para as observações.");
  }

  return <section className="quote-section quote-notes" aria-labelledby={noteId}>
    <div className="quote-notes-toolbar">
      <h3 id={noteId}>Observações</h3>
      <label className="quote-import">
        <input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          disabled={busy} onChange={importWord} aria-describedby={helpId} />
        <span>{busy ? "Lendo documento…" : "Importar do Word"}</span>
      </label>
    </div>
    <small id={helpId}>Importe o texto de um arquivo .docx de até 5 MB.</small>
    <textarea aria-labelledby={noteId} aria-describedby={countId} name="note" rows={7} maxLength={maxCharacters} value={note}
      onChange={(event) => onChange(event.target.value)} placeholder="Ex.: Escopo do serviço, condições de pagamento e prazos." />
    <small className="quote-count" id={countId}>{note.length.toLocaleString("pt-BR")} / 2.000 caracteres</small>
    {busy && <p role="status">Lendo documento…</p>}
    {error && <p className="registry-error" role="alert">{error}</p>}
    {notice && <p className="registry-notice" role="status">{notice}</p>}
    {imported && <div className="quote-word-preview">
      <strong>{imported.filename}</strong>
      <label>Prévia do texto importado<textarea rows={5} maxLength={maxCharacters} value={imported.text}
        onChange={(event) => setImported({ ...imported, text: event.target.value })} /></label>
      {note && appendText.length > maxCharacters && <small>Reduza o texto importado para acrescentá-lo às observações.</small>}
      <div className="record-actions">
        <button type="button" className="secondary" disabled={!imported.text.trim() || appendText.length > maxCharacters}
          onClick={() => apply(appendText)}>{note ? "Acrescentar às observações" : "Usar texto nas observações"}</button>
        {note && <button type="button" className="secondary" disabled={!imported.text.trim()}
          onClick={() => apply(imported.text.trim())}>Substituir observações</button>}
        <button type="button" className="button-link" onClick={() => { setImported(undefined); setNotice(""); }}>Descartar importação</button>
      </div>
    </div>}
  </section>;
}
