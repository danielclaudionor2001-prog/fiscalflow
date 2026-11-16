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

export function QuoteNotes({ initial = "" }: { initial?: string }) {
  const [note, setNote] = useState(initial);
  const [imported, setImported] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const helpId = useId();

  async function importWord(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setImported("");
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
        setImported(text.slice(0, maxCharacters));
        if (text.length > maxCharacters) setNotice("As observações comportam 2.000 caracteres. Confira o trecho importado.");
      }
    } catch {
      setError("Não foi possível ler o arquivo. No Word, salve como .docx e tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="commercial-wide quote-notes">
    <label>Observações<textarea name="note" rows={6} maxLength={maxCharacters} value={note} onChange={(event) => setNote(event.target.value)} /></label>
    <label>Importar texto do Word
      <input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        disabled={busy} onChange={importWord} aria-describedby={helpId} />
    </label>
    <small id={helpId}>Selecione um arquivo .docx para aproveitar o texto nas observações do orçamento.</small>
    {busy && <p role="status">Lendo documento…</p>}
    {error && <p className="registry-error" role="alert">{error}</p>}
    {notice && <p className="registry-notice" role="status">{notice}</p>}
    {imported && <div className="quote-word-preview">
      <label>Prévia do texto importado<textarea rows={6} maxLength={maxCharacters} value={imported} onChange={(event) => setImported(event.target.value)} /></label>
      <div className="record-actions">
        <button type="button" className="button-secondary" onClick={() => {
          setNote(imported);
          setImported("");
          setNotice("Texto importado para as observações.");
        }}>{note ? "Substituir observações pelo texto" : "Usar texto nas observações"}</button>
        <button type="button" className="button-link" onClick={() => { setImported(""); setNotice(""); }}>Descartar importação</button>
      </div>
    </div>}
  </div>;
}
