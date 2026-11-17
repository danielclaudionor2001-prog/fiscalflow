import { useState } from "react";
import { Icon } from "../ui";
import directory from "./bank-directory.json";

const aliases: Record<string, string> = {
  "001": "Banco do Brasil", "033": "Santander", "041": "Banrisul", "070": "BRB",
  "077": "Banco Inter", "085": "Ailos", "097": "Credisis", "104": "Caixa Econômica Federal",
  "121": "Agibank", "133": "Cresol", "136": "Unicred", "197": "Stone", "208": "BTG Pactual",
  "212": "Banco Original", "237": "Bradesco", "260": "Nubank", "290": "PagBank", "318": "Banco BMG",
  "323": "Mercado Pago", "336": "C6 Bank", "341": "Itaú Unibanco", "380": "PicPay",
  "403": "Cora", "461": "Asaas", "655": "Banco Votorantim (BV)", "748": "Sicredi", "756": "Sicoob",
};

type Bank = { code: string; name: string };
const normalize = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const banks = directory.map(([code, short, legal]) => ({
  code,
  name: aliases[code] ?? (legal.length <= 100 ? legal : short),
  search: normalize([code, aliases[code] ?? "", short, legal].join(" ")),
})).sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
const commonCodes = ["001", "104", "237", "341", "033", "260", "077", "756"];
const commonBanks = commonCodes.flatMap((code) => banks.find((bank) => bank.code === code) ?? []);

export function BankPicker({ selected, onChange, requiredError }: {
  selected?: Bank; onChange: (bank: Bank | undefined) => void; requiredError: boolean;
}) {
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState(false);
  const [all, setAll] = useState(false);
  const query = normalize(search.trim());
  const available = query ? banks.filter((bank) => query.split(/\s+/).every((part) => bank.search.includes(part)))
    : all ? banks : commonBanks;
  return <div className="bank-picker">
    {manual ? <>
      <div className="bank-manual-fields">
        <label>Nome do banco<input name="bankName" required minLength={2} maxLength={100} defaultValue={selected?.name} /></label>
        <label>Código do banco (3 dígitos)<input name="bankCode" inputMode="numeric" required pattern="[0-9]{3}" defaultValue={selected?.code} /></label>
      </div>
      <button className="button-link" type="button" onClick={() => setManual(false)}>Usar a lista de instituições</button>
    </> : <>
      <label>Pesquisar banco ou instituição
        <input type="search" value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)}
          placeholder="Nome ou código do banco" aria-invalid={requiredError && !selected} />
      </label>
      <input type="hidden" name="bankName" value={selected?.name ?? ""} />
      <input type="hidden" name="bankCode" value={selected?.code ?? ""} />
      {selected && <p className="bank-selected"><Icon name="building" /> <strong>{selected.name}</strong> · {selected.code}</p>}
      <div className="bank-list-heading">
        <strong>{query ? "Resultados da pesquisa" : all ? "Instituições disponíveis" : "Bancos frequentes"}</strong>
        {!query && <button className="button-link" type="button" aria-expanded={all}
          onClick={() => setAll((value) => !value)}>{all ? "Ver bancos frequentes" : "Ver todas as instituições"}</button>}
      </div>
      <ul className={"bank-options" + (!query && !all ? " bank-options-common" : "")} aria-label="Instituições disponíveis">
        {available.map(({ code, name }) => <li key={code}><button type="button" className="bank-option"
          aria-pressed={selected?.code === code} onClick={() => onChange({ code, name })}>
          <span className="bank-icon" aria-hidden="true">{aliases[code]
            ? name.replace(/^Banco /, "").split(" ").slice(0, 2).map((word) => word[0]).join("").toUpperCase()
            : <Icon name="building" />}</span>
          <span className="bank-option-name">{name}</span><small>{code}</small>
        </button></li>)}
      </ul>
      {available.length === 0 && <small role="status">Nenhuma instituição encontrada.</small>}
      <div className="record-actions">
        <a href="https://dadosabertos.bcb.gov.br/dataset/lista-de-participantes-do-str" target="_blank" rel="noreferrer">Fonte Banco Central</a>
        <button className="button-link" type="button" onClick={() => setManual(true)}>Informar outro banco</button>
      </div>
    </>}
  </div>;
}
