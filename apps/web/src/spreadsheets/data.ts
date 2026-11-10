import { civilDateLabel } from "../format";

export type Cell = string | number | boolean | Date | null;
export type Sheet = { name: string; columns: string[]; rows: Cell[][] };
export type ChartSettings = { group: number; metric: "count" | "sum" | "average"; value: number };
export const maxFileSize = 5 * 1024 * 1024;
const maxRows = 5_000;
const maxColumns = 40;

export function sheetFromRows(name: string, input: Cell[][]): Sheet {
  const rows = input.filter((row) => row.some((cell) => cell !== null && cell !== undefined && cell !== ""));
  if (rows.length > maxRows + 1 || rows.some((row) => row.length > maxColumns)) {
    throw new Error("Use até 5.000 linhas de dados e 40 colunas em cada aba.");
  }
  const [header, ...data] = rows;
  const width = rows.reduce((size, row) => Math.max(size, row.length), 0);
  return {
    name,
    columns: Array.from({ length: width }, (_, i) => cellLabel(header?.[i]).slice(0, 100) || "Coluna " + (i + 1)),
    rows: data,
  };
}

export function cellLabel(value: Cell | undefined) {
  if (value instanceof Date) return civilDateLabel(value.toISOString());
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  return value === null || value === undefined ? "" : String(value);
}

export function numericCell(value: Cell | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^R\$\s*/, "");
  if (!/^[+-]?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:\.\d{3})+)(?:,\d+)?$/.test(text)) return null;
  const number = Number(text.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

export function numericColumns(sheet: Sheet) {
  return sheet.columns.flatMap((_name, index) => {
    const values = sheet.rows.map((row) => row[index]).filter((value) => cellLabel(value) !== "");
    return values.length && values.every((value) => numericCell(value) !== null) ? [index] : [];
  });
}

export function summarize(sheet: Sheet, chart: ChartSettings) {
  const grouped = new Map<string, { total: number; count: number }>();
  let analyzed = 0;
  let total = 0;
  for (const row of sheet.rows) {
    const amount = chart.metric === "count" ? 1 : numericCell(row[chart.value]);
    if (amount === null) continue;
    const label = cellLabel(row[chart.group]).trim() || "(em branco)";
    const group = grouped.get(label) ?? { total: 0, count: 0 };
    group.total += amount;
    group.count++;
    grouped.set(label, group);
    total += amount;
    analyzed++;
  }

  const valueFor = (sum: number, count: number) => chart.metric === "average" && count ? sum / count : sum;
  const groups = Array.from(grouped, ([label, group]) => ({ label, value: valueFor(group.total, group.count) }));
  return { analyzed, total: valueFor(total, analyzed), groups };
}
