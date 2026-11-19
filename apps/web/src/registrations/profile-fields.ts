import type { Field } from "./form";

export const addressFields: Field[] = [
  { name: "zipCode", label: "CEP", section: "Endereço", maxLength: 9, pattern: "[0-9]{5}-?[0-9]{3}" },
  { name: "street", label: "Logradouro", maxLength: 255 },
  { name: "addressNumber", label: "Número", maxLength: 60 },
  { name: "addressComplement", label: "Complemento", maxLength: 156 },
  { name: "neighborhood", label: "Bairro", maxLength: 60 },
  { name: "cityName", label: "Município", maxLength: 100 },
  { name: "state", label: "UF", options: [
    "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
    "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
  ].map((value) => ({ value, label: value })) },
  { name: "cityIbgeCode", label: "Código IBGE do município", maxLength: 7, pattern: "[0-9]{7}" },
];

export const contactFields: Field[] = [
  { name: "contactName", label: "Responsável pelo atendimento", section: "Contatos para atendimento e cobrança", maxLength: 160 },
  { name: "financialContactName", label: "Responsável financeiro", maxLength: 160 },
  { name: "financialContactEmail", label: "E-mail financeiro", kind: "email", maxLength: 254 },
  { name: "financialContactPhone", label: "Telefone financeiro", maxLength: 32 },
];

export const registrationFields: Field[] = [
  { name: "municipalRegistration", label: "Inscrição municipal", maxLength: 40 },
  { name: "stateRegistration", label: "Inscrição estadual", maxLength: 40 },
];

export const reformFields: Field[] = [
  { name: "ibsCbsCst", label: "CST do IBS/CBS", section: "Classificação do IBS/CBS", maxLength: 3, pattern: "[0-9]{3}",
    hint: "Código de 3 dígitos definido para a operação." },
  { name: "ibsCbsClassCode", label: "Classificação tributária (cClassTrib)", maxLength: 6, pattern: "[0-9]{6}",
    hint: "Código de 6 dígitos que corresponde ao CST informado." },
];

export const organizationTaxFields: Field[] = [
  { name: "taxRegime", label: "Regime tributário", section: "Enquadramento tributário", options: [
    { value: "MEI", label: "MEI" }, { value: "SIMPLES_NACIONAL", label: "Simples Nacional - ME/EPP" },
    { value: "LUCRO_PRESUMIDO", label: "Lucro presumido" }, { value: "LUCRO_REAL", label: "Lucro real" },
    { value: "IMUNE_ISENTA", label: "Imune ou isenta" }, { value: "OUTRO", label: "Outro" },
  ] },
  { name: "simplesApportionment", label: "Apuração dos tributos do Simples (ME/EPP)", options: [
    { value: "1", label: "Tributos federais e ISS pelo Simples" },
    { value: "2", label: "Tributos federais pelo Simples e ISS pela legislação municipal" },
    { value: "3", label: "Tributos federais e ISS fora do Simples" },
  ] },
  { name: "specialTaxRegime", label: "Regime especial de tributação do ISS", options: [
    { value: "0", label: "Nenhum" }, { value: "1", label: "Ato cooperado" },
    { value: "2", label: "Estimativa" }, { value: "3", label: "Microempresa municipal" },
    { value: "4", label: "Notário ou registrador" }, { value: "5", label: "Profissional autônomo" },
    { value: "6", label: "Sociedade de profissionais" }, { value: "9", label: "Outros" },
  ] },
];
