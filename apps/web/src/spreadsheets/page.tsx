import { useEffect, useMemo, useRef, useState } from "react";
import { cellLabel, maxFileSize, numericColumns, summarize, type ChartSettings, type Sheet } from "./data";
import { Icon } from "../ui";
import "./style.css";

const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 4 });
const metricLabels = { count: "Contagem de linhas", sum: "Soma", average: "Média" };
const initialChart: ChartSettings = { group: 0, metric: "count", value: 0 };
const chartLimit = 6;
const visibleGroups = 12;

function Chart({ sheet, chart, index, numeric, change, remove }: {
  sheet: Sheet; chart: ChartSettings; index: number; numeric: number[];
  change: (settings: ChartSettings) => void; remove: () => void;
}) {
  const summary = useMemo(() => summarize(sheet, chart), [sheet, chart]);
  const groups = [...summary.groups].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, visibleGroups);
  const minimum = Math.min(0, ...groups.map(({ value }) => value));
  const maximum = Math.max(0, ...groups.map(({ value }) => value));
  const range = maximum - minimum || 1;
  const zero = (0 - minimum) / range;
  const title = chart.metric === "count" ? metricLabels.count : metricLabels[chart.metric] + " de " + sheet.columns[chart.value];
  const columnOptions = (indices: number[]) => indices.map((column) =>
    <option key={column} value={column}>{sheet.columns[column]} · coluna {column + 1}</option>,
  );

  return <section className="registry-card sheet-chart">
    <div className="registry-heading">
      <h3>{title} por {sheet.columns[chart.group]}</h3>
      <button type="button" className="button-secondary" aria-label={"Remover gráfico " + (index + 1)} onClick={remove}>Remover</button>
    </div>
    <div className="sheet-controls">
      <label>Agrupar por<select value={chart.group} onChange={(event) => change({ ...chart, group: Number(event.target.value) })}>
        {columnOptions(sheet.columns.map((_, column) => column))}
      </select></label>
      <label>Cálculo<select value={chart.metric} onChange={(event) => change({
        ...chart, metric: event.target.value as ChartSettings["metric"], value: numeric[0] ?? 0,
      })}>
        <option value="count">Contar linhas</option>
        <option value="sum" disabled={!numeric.length}>Somar</option>
        <option value="average" disabled={!numeric.length}>Calcular média</option>
      </select></label>
      {chart.metric !== "count" && <label>Coluna de valores<select value={chart.value}
        onChange={(event) => change({ ...chart, value: Number(event.target.value) })}>{columnOptions(numeric)}</select></label>}
    </div>
    <dl className="sheet-metrics">
      <div><dt>{chart.metric === "average" ? "Média geral" : "Total"}</dt><dd>{number.format(summary.total)}</dd></div>
      <div><dt>Linhas no cálculo</dt><dd>{number.format(summary.analyzed)}</dd></div>
      <div><dt>Grupos</dt><dd>{number.format(summary.groups.length)}</dd></div>
    </dl>
    <ul className="sheet-bars">
      {groups.map(({ label, value }) => <li key={label}>
        <span className="sheet-bar-label" title={label}>{label}</span>
        <span className="sheet-bar-track" aria-hidden="true">
          <i style={{ insetInlineStart: Math.min(zero, (value - minimum) / range) * 100 + "%", width: Math.abs(value) / range * 100 + "%" }}
            data-negative={value < 0} />
        </span>
        <strong>{number.format(value)}</strong>
      </li>)}
    </ul>
    {summary.groups.length > visibleGroups && <p>Exibindo os {visibleGroups} grupos com maior valor absoluto.</p>}
  </section>;
}

function SheetDashboard({ sheet }: { sheet: Sheet }) {
  const [charts, setCharts] = useState<ChartSettings[]>([initialChart]);
  const [showRows, setShowRows] = useState(false);
  const numeric = useMemo(() => numericColumns(sheet), [sheet]);
  if (!sheet.rows.length) return <p className="registry-card">Esta aba precisa de cabeçalhos e linhas de dados.</p>;
  return <>
    <section className="registry-card">
      <div className="registry-heading">
        <h2>Dashboard</h2>
        <div className="record-actions">
          <button type="button" className="button-secondary" aria-expanded={showRows} onClick={() => setShowRows(!showRows)}>
            {showRows ? "Ocultar dados" : "Conferir dados"}
          </button>
          <button type="button" disabled={charts.length >= chartLimit} onClick={() => setCharts([...charts, initialChart])}>
            Adicionar gráfico
          </button>
        </div>
      </div>
      <p>{number.format(sheet.rows.length)} linhas de dados · {sheet.columns.length} colunas</p>
      {showRows && <div className="registry-table sheet-preview">
        <table aria-label="Prévia da planilha">
          <thead><tr>{sheet.columns.map((name, index) => <th scope="col" key={index}>{name}</th>)}</tr></thead>
          <tbody>{sheet.rows.slice(0, 20).map((row, index) => <tr key={index}>
            {sheet.columns.map((_name, column) => <td key={column}>{cellLabel(row[column]) || "—"}</td>)}
          </tr>)}</tbody>
        </table>
        {sheet.rows.length > 20 && <p>Primeiras 20 linhas. Os gráficos consideram todas as linhas da aba.</p>}
      </div>}
    </section>
    {charts.map((chart, index) => <Chart key={index} {...{ sheet, chart, index, numeric }}
      change={(settings) => setCharts((current) => current.map((item, i) => i === index ? settings : item))}
      remove={() => setCharts((current) => current.filter((_item, i) => i !== index))} />)}
  </>;
}

export function SpreadsheetsPage() {
  const worker = useRef<Worker>();
  const timeout = useRef<number>();
  const [workbook, setWorkbook] = useState<{ name: string; sheets: Sheet[]; version: number }>();
  const [sheetIndex, setSheetIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => () => {
    worker.current?.terminate();
    window.clearTimeout(timeout.current);
  }, []);

  function load(file: File) {
    if (busy) return;
    setError("");
    if (!/\.(xlsx|csv)$/i.test(file.name) || !file.size || file.size > maxFileSize) {
      setError("Escolha um arquivo .xlsx ou .csv de até 5 MB.");
      return;
    }
    const task = new Worker(new URL("./import.worker.ts", import.meta.url), { type: "module" });
    worker.current = task;
    setBusy(true);
    const finish = (message?: string) => {
      task.terminate();
      worker.current = undefined;
      window.clearTimeout(timeout.current);
      setBusy(false);
      if (message) setError(message);
    };
    task.onmessage = ({ data }: MessageEvent<{ sheets?: Sheet[]; message?: string }>) => {
      if (data.sheets) {
        setSheetIndex(data.sheets.findIndex((sheet) => sheet.rows.length > 0));
        setWorkbook({ name: file.name, sheets: data.sheets, version });
        setVersion((current) => current + 1);
      }
      finish(data.message);
    };
    task.onerror = () => finish("O navegador interrompeu a leitura. Tente com uma cópia menor.");
    timeout.current = window.setTimeout(() => finish("A leitura demorou demais. Tente reduzir as abas ou as linhas."), 20_000);
    task.postMessage(file);
  }

  const sheet = workbook?.sheets[sheetIndex];
  return <div className="registry sheet-workspace">
    <section className="registry-card sheet-import">
      <div className="sheet-import-heading">
        <Icon name="report" />
        <div><h2>Importar planilha</h2><p>Use .xlsx ou CSV UTF-8 de até 5 MB. Coloque os títulos na primeira linha da aba.</p></div>
      </div>
      <label className="sheet-file">Arquivo do Excel ou CSV
        <input type="file" accept=".xlsx,.csv" disabled={busy} onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) load(file);
        }} />
      </label>
      <p>Os dados ficam no navegador durante esta análise.</p>
      {busy && <p role="status">Lendo planilha…</p>}
      {error && <p role="alert" className="registry-error">{error}</p>}
      {workbook && <div className="sheet-source">
        <strong>{workbook.name}</strong>
        <label>Aba<select value={sheetIndex} onChange={(event) => setSheetIndex(Number(event.target.value))}>
          {workbook.sheets.map(({ name }, index) => <option key={index} value={index}>{name}</option>)}
        </select></label>
      </div>}
    </section>
    {workbook && sheet && <SheetDashboard key={workbook.version + ":" + sheetIndex} sheet={sheet} />}
  </div>;
}
