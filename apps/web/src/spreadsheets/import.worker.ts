import Papa from "papaparse";
import readExcel from "read-excel-file/universal";
import { maxFileSize, sheetFromRows, type Sheet } from "./data";

self.addEventListener("message", async (event: MessageEvent<File>) => {
  const file = event.data;
  const extension = file.name.split(".").pop()?.toLowerCase();
  try {
    if (!file.size || file.size > maxFileSize) throw new Error("Selecione um arquivo de até 5 MB.");
    let sheets: Sheet[];
    if (extension === "xlsx") {
      const workbook = await readExcel(file);
      if (workbook.length > 12) throw new Error("Use uma planilha com até 12 abas.");
      sheets = workbook.map(({ sheet, data }) => sheetFromRows(sheet,
        data.map((row) => row.map((cell) => typeof cell === "function" ? null : cell)),
      ));
    } else if (extension === "csv") {
      const csv = await file.text();
      if (csv.includes("\u0000") || csv.includes("\ufffd")) throw new Error("Salve o CSV com codificação UTF-8.");
      const parsed = Papa.parse<string[]>(csv, { skipEmptyLines: "greedy", delimitersToGuess: [";", ",", "\t"], preview: 5002 });
      if (parsed.errors.some(({ code }) => code !== "UndetectableDelimiter")) throw new Error("Revise as aspas e os separadores do CSV.");
      sheets = [sheetFromRows("CSV", parsed.data)];
    } else {
      throw new Error("Selecione um arquivo do Excel (.xlsx) ou CSV (.csv).");
    }
    if (!sheets.some((sheet) => sheet.rows.length)) {
      throw new Error("Inclua os títulos das colunas na primeira linha e pelo menos uma linha de dados.");
    }
    self.postMessage({ sheets });
  } catch (error) {
    const message = error instanceof Error && /^(Use |Selecione |Inclua |Revise |Salve )/.test(error.message)
      ? error.message : "Não foi possível ler o arquivo. Confira se ele abre no Excel e salve uma cópia em .xlsx ou CSV UTF-8.";
    self.postMessage({ message });
  }
});
