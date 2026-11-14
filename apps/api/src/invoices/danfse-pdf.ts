import { readFileSync } from "node:fs";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import type { readAuthorizedNfsePrint } from "../fiscal/documents.ts";
import { RequestError } from "../http.ts";

type Note = ReturnType<typeof readAuthorizedNfsePrint>;
type Field = readonly [label: string, value: string, columns?: number];
type Section = { title: string; rows: Field[][] };
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const time = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "medium",
});
const money = (value: string) => value && currency.format(Number(value));
const percent = (value: string) => value && value.replace(".", ",") + "%";
const dateTime = (value: string) => value && time.format(new Date(value));
const civilDate = (value: string) => value.split("-").reverse().join("/");
const joined = (...values: string[]) => values.filter(Boolean).join(" / ");
const codeLabel = (labels: Record<string, string>, code: string) => labels[code] ?? code;
const document = (value: string) => value
  .replace(/^([0-9A-Z]{2})([0-9A-Z]{3})([0-9A-Z]{3})([0-9A-Z]{4})([0-9]{2})$/, "$1.$2.$3/$4-$5")
  .replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
const logo = new URL("../../fiscal-schemas/nfse-horizontal.png", import.meta.url);

function personRows(person: Note["issuer"], cityName = ""): Field[][] {
  return [
    [["Nome ou razão social", person.name, 2], ["CNPJ / CPF / NIF", document(person.document)], ["Inscrição municipal", person.registration]],
    [["Endereço", person.address, 2], ["Município / UF / país", joined(cityName || person.city, person.uf, person.country)], ["CEP", person.postalCode]],
    [["E-mail", person.email, 2], ["Telefone", person.phone, 2]],
  ];
}

function sections(data: Note): Section[] {
  const { service, municipal, federal, reform, approximateTaxes, discounts } = data;
  const provider = personRows(data.issuer, data.city);
  provider[2] = [["E-mail", data.issuer.email], ["Telefone", data.issuer.phone],
    ["Simples Nacional", codeLabel({ "1": "Não optante", "2": "Optante - MEI", "3": "Optante - ME/EPP" }, data.regime)],
    ["Regime de apuração do Simples", data.regimeAssessment]];
  const parties = [
    { title: "TOMADOR / ADQUIRENTE", person: data.buyer },
    { title: "DESTINATÁRIO DA OPERAÇÃO", person: data.recipient },
    { title: "INTERMEDIÁRIO DA OPERAÇÃO", person: data.intermediary },
  ].map(({ title, person }) => person.document || person.name
    ? { title, rows: personRows(person) }
    : { title: title === "DESTINATÁRIO DA OPERAÇÃO" && data.recipientIsBuyer
      ? "O DESTINATÁRIO É O PRÓPRIO TOMADOR / ADQUIRENTE"
      : title + " NÃO IDENTIFICADO NA NFS-e", rows: [] });
  const taxLabels = ["Federais", "Estaduais", "Municipais"];
  const approximate = approximateTaxes.simples ? "Simples Nacional " + percent(approximateTaxes.simples) :
    taxLabels.flatMap((label, index) => {
      const value = money(approximateTaxes.money[index]) || percent(approximateTaxes.percent[index]);
      return value ? [label + " " + value] : [];
    }).join(" · ");
  const result: Section[] = [
    { title: "PRESTADOR / FORNECEDOR", rows: provider },
    ...parties,
    { title: "SERVIÇO PRESTADO", rows: [
      [["Tributação nacional / municipal", joined(service.nationalCode.replace(/^(..)(..)(..)$/, "$1.$2.$3"), service.municipalCode), 2],
        ["Código NBS", service.nbs], ["Local da prestação", joined(service.city, service.country)]],
      ...([service.nationalLabel, service.municipalLabel].some(Boolean)
        ? [[["Descrição do código de tributação", joined(service.nationalLabel, service.municipalLabel), 4] as Field]] : []),
      [["Descrição do serviço", service.description, 4]],
    ] },
    { title: "TRIBUTAÇÃO MUNICIPAL (ISSQN)", rows: [
      [["Tipo de tributação do ISSQN", codeLabel({ "1": "Operação tributável", "2": "Imunidade", "3": "Exportação de serviço", "4": "Não incidência" }, municipal.tax), 2],
        ["Município de incidência do ISSQN", municipal.city, 2]],
      [["Base de cálculo ISSQN", money(municipal.base)], ["Alíquota aplicada", percent(municipal.rate)],
        ["Retenção do ISSQN", codeLabel({ "1": "Não retido", "2": "Retido pelo tomador", "3": "Retido pelo intermediário" }, municipal.retention)], ["ISSQN apurado", money(municipal.amount)]],
    ] },
    { title: "TRIBUTAÇÃO FEDERAL (EXCETO CBS)", rows: [
      [["IRRF retido", money(federal.income)], ["Contribuição previdenciária retida", money(federal.socialSecurity)],
        ["Contribuições sociais retidas", money(federal.socialContributions)], ["Retenção de PIS/COFINS", federal.contributionRetention]],
      [["PIS", money(federal.pis), 2], ["COFINS", money(federal.cofins), 2]],
    ] },
    { title: "TRIBUTAÇÃO IBS/CBS", rows: [
      [["CST / classificação tributária", joined(reform.classification, reform.category), 2],
        ["Indicador de operação", reform.indicator], ["Incidência", joined(reform.city, reform.cityCode)]],
      [["Base de cálculo IBS/CBS", money(reform.base)], ["Ajustes informados", money(reform.deduction)],
        ["Alíquotas IBS UF / municipal", joined(percent(reform.rateState), percent(reform.rateCity))], ["Alíquota CBS", percent(reform.rateFederal)]],
      [["Reduções IBS UF / municipal", joined(percent(reform.reducedState), percent(reform.reducedCity))], ["Redução CBS", percent(reform.reducedFederal)],
        ["Alíquotas efetivas IBS UF / municipal", joined(percent(reform.effectiveState), percent(reform.effectiveCity))], ["Alíquota efetiva CBS", percent(reform.effectiveFederal)]],
      [["IBS estadual", money(reform.state)], ["IBS municipal", money(reform.municipal)], ["Total do IBS", money(reform.ibs)], ["Total da CBS", money(reform.cbs)]],
    ] },
    { title: "VALOR TOTAL DA NFS-e", rows: [
      [["Valor da operação / serviço", money(service.amount)], ["Desconto incondicionado", money(discounts.unconditional)],
        ["Desconto condicionado", money(discounts.conditional)], ["Total de retenções (ISSQN / federais)", money(municipal.totalRetained)]],
      [["Valor líquido da NFS-e", money(data.total), 2], ["Valor líquido da NFS-e + IBS/CBS", money(reform.total), 2]],
    ] },
    { title: "INFORMAÇÕES COMPLEMENTARES", rows: [
      [["Totais aproximados de tributos", approximate, 4]],
      ...data.additionalInfo.map((info): Field[] => [["Informações da NFS-e", info, 4]]),
    ] },
  ];
  return result;
}

export function danfsePdf(data: Note, cancelled: boolean) {
  const qrUrl = "https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=" + data.accessKey;
  const qr = QRCode.create(qrUrl, { errorCorrectionLevel: "M" }).modules;
  const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: "DANFSe nº " + data.number, Creator: "Fiscal Floow" } });
  const left = 9;
  const width = doc.page.width - 2 * left;
  const bottom = doc.page.height - left;
  const label = "Helvetica-Bold";
  const body = "Helvetica";
  let y = 119;

  const contentSections = sections(data);
  const layout = (fontSize: number, padding: number) => contentSections.map((section) => ({
    ...section,
    rows: section.rows.map((row) => {
      const cells = row.map(([caption, value, columns = 1]) => {
        const cellWidth = width * columns / 4;
        const textWidth = cellWidth - 10;
        const options = { width: textWidth, lineGap: 0 };
        const labelHeight = doc.font(label).fontSize(6).heightOfString(caption, options);
        const content = value || "-";
        const height = doc.font(body).fontSize(fontSize).heightOfString(content, options);
        return { caption, content, cellWidth, options, labelHeight, height };
      });
      return { cells, height: Math.max(...cells.map((cell) => cell.labelHeight + cell.height)) + padding };
    }),
  }));
  const height = (plan: ReturnType<typeof layout>) => plan.reduce(
    (total, section) => total + 11 + section.rows.reduce((sum, row) => sum + row.height, 0), 0,
  );
  let size = 7;
  let plan = layout(size, 4);
  if (y + height(plan) > bottom - 21) {
    size = 6;
    plan = layout(size, 2);
  }
  if (y + height(plan) > bottom - 21) {
    doc.end();
    throw new RequestError(422, "danfse-layout-unavailable");
  }

  const text = (value: string, x: number, top: number, font: string, fontSize: number, options: PDFKit.Mixins.TextOptions = {}) => {
    doc.font(font).fontSize(fontSize).fillColor("#000000").text(value || "-", x, top, options);
  };
  doc.lineWidth(0.55).strokeColor("#000000").rect(left, left, width, bottom - left).stroke();
  doc.image(readFileSync(logo), left + 6, left + 5, { fit: [112, 24] });
  text("DANFSe v2.0\nDocumento Auxiliar da NFS-e", left + 128, left + 5, label, 9, { width: width - 256, align: "center" });
  text([data.city ? "Município: " + joined(data.city, data.issuer.uf) : "", data.generator ? "Ambiente gerador: " + data.generator : "", "Tipo de ambiente: 1"]
    .filter(Boolean).join("\n"), left + width - 135, left + 5, body, 6, { width: 130 });
  doc.moveTo(left, 44).lineTo(left + width, 44).stroke();

  const qrSize = 54;
  const qrX = 490;
  const qrY = 42;
  const module = qrSize / (qr.size + 8);
  for (let row = 0; row < qr.size; row++) {
    for (let col = 0; col < qr.size; col++) {
      if (qr.get(row, col)) doc.rect(qrX + (col + 4) * module, qrY + (row + 4) * module, module, module);
    }
  }
  doc.fill("#000000");
  text("Consulte a autenticidade no Portal Nacional da NFS-e", left + width - 138, 100, body, 6, { width: 129, align: "center", link: qrUrl });
  text("CHAVE DE ACESSO DA NFS-e", left + 5, 49, label, 7, { lineBreak: false });
  text(data.accessKey, left + 5, 58, body, 7, { lineBreak: false, link: qrUrl });
  const identification: Field[][] = [
    [["Número da NFS-e", data.number], ["Competência da NFS-e", civilDate(data.competence)], ["Emissão da NFS-e", dateTime(data.processedAt)]],
    [["Número da DPS", data.dpsNumber], ["Série da DPS", data.series], ["Emissão da DPS", dateTime(data.issuedAt)]],
    [["Emitente da NFS-e", codeLabel({ "1": "Prestador", "2": "Tomador", "3": "Intermediário" }, data.emitType)],
      ["Situação da NFS-e", codeLabel({ "100": "NFS-e gerada", "102": "NFS-e de decisão judicial", "103": "NFS-e avulsa", "107": "NFS-e MEI" }, data.status)],
      ["Finalidade", codeLabel({ "0": "NFS-e regular" }, data.purpose)]],
  ];
  identification.forEach((row, index) => row.forEach(([caption, value], column) => {
    const x = left + 5 + column * width / 4;
    const top = 67 + index * 17;
    text(caption, x, top, label, 7, { lineBreak: false });
    text(value, x, top + 8, body, 7, { lineBreak: false });
  }));
  for (const section of plan) {
    doc.rect(left + 0.4, y, width - 0.8, 11).fill("#eeeeee");
    doc.moveTo(left, y).lineTo(left + width, y).strokeColor("#000000").stroke();
    text(section.title, left + 5, y + 2, label, 7, { lineBreak: false });
    y += 11;
    for (const row of section.rows) {
      let x = left + 5;
      for (const cell of row.cells) {
        text(cell.caption, x, y + 1, label, 6, cell.options);
        text(cell.content, x, y + 1 + cell.labelHeight, body, size, cell.options);
        x += cell.cellWidth;
      }
      y += row.height;
    }
  }
  doc.moveTo(left, bottom - 19).lineTo(left + width, bottom - 19).stroke();
  for (const offset of [0.25, 0.5]) {
    const x = left + width * offset;
    doc.moveTo(x, bottom - 19).lineTo(x, bottom).stroke();
  }
  text("DATA DA CIENTIFICAÇÃO", left + 5, bottom - 16, label, 6, { lineBreak: false });
  text("IDENTIFICAÇÃO E ASSINATURA", left + width / 4 + 5, bottom - 16, label, 6, { lineBreak: false });
  text("Nº NFS-e / CHAVE NFS-e", left + width / 2 + 5, bottom - 16, label, 6, { lineBreak: false });
  text(data.number + " / " + data.accessKey, left + width / 2 + 5, bottom - 9, body, 6, { lineBreak: false, link: qrUrl });
  if (cancelled) {
    doc.save().rotate(-34, { origin: [doc.page.width / 2, doc.page.height / 2] })
      .fillColor("#a6a6a6").fillOpacity(0.55).font(label).fontSize(50)
      .text("CANCELADA", 0, doc.page.height / 2 - 30, { width: doc.page.width, align: "center", lineBreak: false }).restore();
  }
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.once("end", () => resolve(Buffer.concat(chunks)));
    doc.once("error", reject);
    doc.end();
  });
}
