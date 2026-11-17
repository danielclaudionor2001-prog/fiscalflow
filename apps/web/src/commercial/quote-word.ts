import { strToU8, zipSync } from "fflate";
import { civilDateLabel, dateLabel, formatDocument } from "../format";
import type { CommercialBrand } from "./branding";
import type { CommercialDocumentData } from "./order-document";

export const wordMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const namespaces = 'xmlns:w="' + word + '" xmlns:r="' + office + '" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const colors = { ink: "162841", muted: "52637B", accent: "0F665F", light: "ECF6F4" };
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const widths = [4500, 900, 1800, 2000];

function escapeText(value: string) {
  return value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

type ParagraphStyle = {
  size?: number; color?: string; bold?: boolean; right?: boolean; after?: number; before?: number; keepNext?: boolean;
};

function paragraph(text: string, { size = 21, color = colors.ink, bold, right, after = 120, before = 0, keepNext }: ParagraphStyle = {}) {
  const content = text.split(/\r\n?|\n/).map((line) => '<w:t xml:space="preserve">' + escapeText(line) + "</w:t>").join("<w:br/>");
  return '<w:p><w:pPr>' + (keepNext ? '<w:keepNext/>' : '') + '<w:spacing w:before="' + before + '" w:after="' + after + '"/>' +
    (right ? '<w:jc w:val="right"/>' : '') + '</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>' +
    (bold ? '<w:b/>' : '') + '<w:color w:val="' + color + '"/><w:sz w:val="' + size + '"/><w:lang w:val="pt-BR"/>' +
    '</w:rPr>' + content + '</w:r></w:p>';
}

function tableRow(values: string[], header = false) {
  return '<w:tr><w:trPr><w:cantSplit/>' + (header ? '<w:tblHeader/>' : '') + '</w:trPr>' +
    values.map((value, index) => '<w:tc><w:tcPr><w:tcW w:w="' + widths[index] + '" w:type="dxa"/>' +
      (header ? '<w:shd w:val="clear" w:fill="' + colors.light + '"/>' : '') +
      '<w:vAlign w:val="center"/></w:tcPr>' +
      paragraph(value, { size: 20, right: index > 0, bold: header, after: 0, color: header ? colors.accent : colors.ink }) + '</w:tc>').join("") +
    '</w:tr>';
}

function pngImage(source: string | null | undefined) {
  const prefix = "data:image/png;base64,";
  if (!source?.startsWith(prefix)) return;
  const bytes = Uint8Array.from(atob(source.slice(prefix.length)), (character) => character.charCodeAt(0));
  if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return;
  const dimensions = new DataView(bytes.buffer);
  const width = dimensions.getUint32(16);
  const height = dimensions.getUint32(20);
  if (width && height) return { bytes, width, height };
}

function picture(image: NonNullable<ReturnType<typeof pngImage>>, watermark = false) {
  const scale = Math.min((watermark ? 3_300_000 : 1_600_000) / image.width, (watermark ? 3_300_000 : 700_000) / image.height);
  const cx = Math.round(image.width * scale);
  const cy = Math.round(image.height * scale);
  const name = watermark ? "Marca d’água" : "Logo da empresa";
  const extent = 'cx="' + cx + '" cy="' + cy + '"';
  const drawing = '<wp:extent ' + extent + '/>' + (watermark ? '<wp:wrapNone/>' : '') +
    '<wp:docPr id="' + (watermark ? 2 : 1) + '" name="' + name + '"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    '<pic:nvPicPr><pic:cNvPr id="0" name="' + name + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="image">' + (watermark ? '<a:alphaModFix amt="12000"/>' : '') +
    '</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext ' + extent + '/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>';
  const position = watermark
    ? '<wp:anchor simplePos="0" relativeHeight="0" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1" distT="0" distB="0" distL="0" distR="0">' +
      '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:align>center</wp:align></wp:positionH>' +
      '<wp:positionV relativeFrom="page"><wp:align>center</wp:align></wp:positionV>' + drawing + '</wp:anchor>'
    : '<wp:inline>' + drawing + '</wp:inline>';
  return '<w:p><w:pPr><w:spacing w:after="140"/></w:pPr><w:r><w:drawing>' + position + '</w:drawing></w:r></w:p>';
}

function relationships(entries: [id: string, kind: string, path: string][]) {
  return xml + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    entries.map(([id, kind, path]) => '<Relationship Id="' + id + '" Type="' + office + '/' + kind + '" Target="' + path + '"/>').join("") +
    '</Relationships>';
}

export function createQuoteWord(order: CommercialDocumentData, brand: CommercialBrand) {
  const logo = pngImage(brand.logo);
  const watermark = brand.quoteWatermark ? pngImage(brand.watermarkImage ?? brand.logo) : undefined;
  const company = paragraph(brand.tradeName || brand.legalName, { bold: true, size: 24, after: 70, keepNext: true }) +
    (brand.tradeName && brand.tradeName !== brand.legalName ? paragraph(brand.legalName, { after: 60 }) : "") +
    [brand.cnpj && "CNPJ " + formatDocument(brand.cnpj), brand.commercialAddress,
      [brand.commercialEmail, brand.commercialPhone].filter(Boolean).join(" · ")].filter(Boolean)
      .map((line) => paragraph(line!, { color: colors.muted, size: 19, after: 60 })).join("");
  const table = '<w:tbl><w:tblPr><w:tblW w:w="9200" w:type="dxa"/>' +
    '<w:tblBorders><w:insideH w:val="single" w:sz="4" w:color="D8E5E8"/></w:tblBorders><w:tblLayout w:type="fixed"/>' +
    '<w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="120" w:type="dxa"/>' +
    '<w:bottom w:w="100" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
    '<w:tblGrid>' + widths.map((width) => '<w:gridCol w:w="' + width + '"/>').join("") + '</w:tblGrid>' +
    tableRow(["Item", "Qtd.", "Unitário", "Subtotal"], true) +
    order.items.map((item) => tableRow([item.label, String(item.quantity),
      currency.format(Number(item.unitPrice)), currency.format(Number(item.unitPrice) * item.quantity)])).join("") + '</w:tbl>';
  const code = order.id.slice(-8).toUpperCase();
  const body = (logo ? picture(logo) : "") + company +
    paragraph("Orçamento " + code, { bold: true, size: 48, color: colors.accent, before: 340, after: 220, keepNext: true }) +
    paragraph("Cliente · " + (order.customerName ?? "Cliente avulso"), { bold: true, keepNext: true }) +
    paragraph("Emissão · " + dateLabel(order.createdAt) + (order.dueOn ? "    Validade · " + civilDateLabel(order.dueOn) : ""), { color: colors.muted }) +
    (order.sellerName ? paragraph("Responsável · " + order.sellerName, { color: colors.muted }) : "") +
    paragraph("Produtos e serviços", { bold: true, color: colors.accent, before: 150, keepNext: true }) + table +
    paragraph("Total · " + currency.format(Number(order.amount)), { bold: true, right: true, size: 30, color: colors.accent, before: 220 }) +
    (order.note ? paragraph("Observações", { bold: true, color: colors.accent, before: 210, keepNext: true }) + paragraph(order.note) : "") +
    paragraph("Documento comercial · Sem valor fiscal", { size: 17, color: colors.muted, before: 280 }) +
    '<w:sectPr>' + (watermark ? '<w:headerReference w:type="default" r:id="branding"/>' : '') +
    '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1260" w:right="1300" w:bottom="1260" w:left="1300" w:header="600" w:footer="600" w:gutter="0"/></w:sectPr>';
  const documentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.";
  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(xml + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      (logo || watermark ? '<Default Extension="png" ContentType="image/png"/>' : '') +
      '<Override PartName="/word/document.xml" ContentType="' + documentType + 'document.main+xml"/>' +
      (watermark ? '<Override PartName="/word/header.xml" ContentType="' + documentType + 'header+xml"/>' : '') + '</Types>'),
    "_rels/.rels": strToU8(relationships([["document", "officeDocument", "word/document.xml"]])),
    "word/document.xml": strToU8(xml + '<w:document ' + namespaces + '><w:body>' + body + '</w:body></w:document>'),
  };
  const links: [string, string, string][] = [];
  if (logo) {
    parts["word/media/logo.png"] = logo.bytes;
    links.push(["image", "image", "media/logo.png"]);
  }
  if (watermark) {
    parts["word/media/watermark.png"] = watermark.bytes;
    parts["word/header.xml"] = strToU8(xml + '<w:hdr ' + namespaces + '>' + picture(watermark, true) + '</w:hdr>');
    parts["word/_rels/header.xml.rels"] = strToU8(relationships([["image", "image", "media/watermark.png"]]));
    links.push(["branding", "header", "header.xml"]);
  }
  if (links.length) parts["word/_rels/document.xml.rels"] = strToU8(relationships(links));
  return zipSync(parts, { level: 3 });
}
