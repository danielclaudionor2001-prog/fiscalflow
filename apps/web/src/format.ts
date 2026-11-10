const documentSeparators = /[.\/\-\s]/g;
const cpfPattern = /^\d{11}$/;
const cnpjPattern = /^[A-Z0-9]{12}\d{2}$/;

export function normalizeDocument(value: string) {
  return value.replace(documentSeparators, "").toUpperCase();
}

function group(value: string, widths: number[], separators: string[]) {
  let offset = 0;
  return widths.map((width, index) => {
    const part = value.slice(offset, offset + width);
    offset += width;
    return part && (separators[index - 1] ?? "") + part;
  }).join("") + value.slice(offset);
}

export function maskDocument(value: string, mode: "cpf" | "cnpj" | "either" = "either") {
  const normalized = normalizeDocument(value);
  if (!/^[A-Z0-9]*$/.test(normalized)) return value;
  const cpf = mode === "cpf" || (mode === "either" && /^\d{0,11}$/.test(normalized));
  return cpf ? group(normalized, [3, 3, 3, 2], [".", ".", "-"])
    : group(normalized, [2, 3, 3, 4, 2], [".", ".", "/", "-"]);
}

export function formatDocument(value: string) {
  const normalized = normalizeDocument(value);
  return cpfPattern.test(normalized) || cnpjPattern.test(normalized) ? maskDocument(value) : value;
}

export function maskDate(value: string) {
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return civilDateLabel(text);
  if (!/^[\d/\s]*$/.test(text)) return value;
  return group(text.replace(/[/\s]/g, ""), [2, 2, 4], ["/", "/"]);
}

export function parseBrazilianDate(value: string) {
  const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!parts || parts[3] === "0000") return "";
  const iso = parts[3] + "-" + parts[2] + "-" + parts[1];
  const date = new Date(iso + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : "";
}

export function civilDateLabel(iso: string) {
  return iso.slice(0, 10).split("-").reverse().join("/");
}

const dateOptions = { day: "2-digit", month: "2-digit", year: "numeric" } as const;
const date = new Intl.DateTimeFormat("pt-BR", { ...dateOptions, timeZone: "America/Sao_Paulo" });
const timestamp = new Intl.DateTimeFormat("pt-BR", {
  ...dateOptions, timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit",
});

export const dateLabel = (iso: string) => date.format(new Date(iso));
export const timestampLabel = (iso: string) => timestamp.format(new Date(iso));
