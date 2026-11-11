import { DateInput } from "../formatted-inputs";
import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, RegistrationError, useRegistrationRequest } from "../registrations/api";
import { HomologationCard, type HomologationResult } from "./homologation";
import { ProductionDpsReview, type ProductionReview } from "./production-review";

type Signed = { state: "locally-signed"; idDps: string; preparedAt: string } & Partial<ProductionReview>;
type Context = {
  draftVersion: string;
  issuerCity: string | null;
  nationalServiceCode: string | null;
  municipalServiceCode: string | null;
  certificateAvailable: boolean;
  prepared: (Signed & { current: boolean }) | null;
  homologation: HomologationResult[] | null;
  productionEnabled?: boolean;
  customerName?: string;
  description?: string;
  amount?: string;
};
type Request = ReturnType<typeof useRegistrationRequest>;

const errors: Record<string, string> = {
  "draft-changed": "O rascunho mudou. Abra a versão mais recente para preparar a DPS.",
  "valid-certificate-required": "Cadastre um certificado A1 válido da empresa para assinar a DPS.",
  "certificate-unavailable": "O cofre de certificados está indisponível.",
  "issuer-cnpj-required": "A preparação da DPS com e-CNPJ A1 está disponível para contas com CNPJ.",
  "certificate-chain-untrusted": "A cadeia do certificado precisa ser validada novamente.",
  "certificate-busy": "Há outra validação em andamento. Tente novamente em alguns segundos.",
  "issuer-city-required": "Informe o código IBGE do município da empresa na aba Organização.",
  "customer-unavailable": "O cliente deste rascunho está indisponível.",
  "service-unavailable": "O serviço deste rascunho está indisponível.",
  "dps-number-in-use": "Esta série e este número de DPS já foram usados. Informe outro número disponível.",
  "invalid-input": "Confira os campos e use os códigos fiscais no formato indicado.",
  "invalid-dps-data": "Os dados fiscais não formam uma DPS válida. Revise o regime e os totais informados.",
  "invalid-schema": "Os dados não passaram na validação do leiaute oficial. Revise o preenchimento.",
  "future-competence": "Informe uma competência até a data de hoje.",
  "buyer-address-required": "Informe o endereço do tomador para a retenção de ISSQN.",
};

function message(error: unknown) {
  if (error instanceof RegistrationError && error.code && Object.hasOwn(errors, error.code)) return errors[error.code];
  return errorMessage(error);
}

type FormProps = { draftId: string; request: Request; close: () => void; pending?: boolean };

export function PrepareDpsForm(props: FormProps) {
  const [production, setProduction] = useState(Boolean(props.pending));
  return <DpsForm key={String(production)} {...props} production={production} switchMode={() => setProduction(!production)} />;
}

function DpsForm({ draftId, request, close, pending, production, switchMode }: FormProps & { production: boolean; switchMode: () => void }) {
  const [context, setContext] = useState<Context>();
  const [regime, setRegime] = useState("");
  const [totalMode, setTotalMode] = useState("pTotTrib");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Signed>();
  const [includeAddress, setIncludeAddress] = useState(false);
  const path = "invoices/" + encodeURIComponent(draftId) + (production ? "/production-dps" : "/dps");
  useEffect(() => {
    const controller = new AbortController();
    request<Context>(path, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setContext(data); })
      .catch((failure) => { if (!controller.signal.aborted) setError(message(failure)); });
    return () => controller.abort();
  }, [path, request]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!context?.certificateAvailable || busy) return;
    const fields = new FormData(event.currentTarget);
    const get = (key: string) => String(fields.get(key) ?? "").trim();
    const optional = (key: string) => get(key) || undefined;
    const decimal = (key: string) => {
      const [whole, cents] = get(key).replace(",", ".").split(".");
      return cents === undefined ? whole : whole + "." + cents.padEnd(2, "0");
    };
    const totals = { federal: decimal("federal"), estadual: decimal("estadual"), municipal: decimal("municipal") };
    const totTrib = totalMode === "indTotTrib" ? { indTotTrib: "0" }
      : totalMode === "pTotTribSN" ? { pTotTribSN: decimal("pTotTribSN") }
      : { [totalMode]: totals };
    setBusy(true);
    setError("");
    try {
      setSaved(await request<Signed>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "If-Match": '"' + context.draftVersion + '"' },
        body: JSON.stringify({
          serie: get("serie"), nDPS: get("nDPS"), dCompet: get("dCompet"),
          cLocPrestacao: get("cLocPrestacao"), cTribNac: get("cTribNac"),
          cTribMun: optional("cTribMun"), cNBS: optional("cNBS"), opSimpNac: regime, regApTribSN: optional("regApTribSN"),
          regEspTrib: get("regEspTrib"), tpRetISSQN: get("tpRetISSQN"), pAliq: get("pAliq") ? decimal("pAliq") : undefined, totTrib,
          ...(production && includeAddress && { buyerAddress: {
            municipality: get("buyerMunicipality"), zipCode: get("buyerZip").replace(/-/g, ""),
            street: get("buyerStreet"), number: get("buyerNumber"),
            complement: optional("buyerComplement"), neighborhood: get("buyerNeighborhood"),
          } }),
        }),
      }));
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  const result = saved ?? context?.prepared;
  const attempts = context?.homologation;
  const olderAttempts = attempts?.filter(({ idDps }) => idDps !== result?.idDps) ?? [];
  return (
    <div className="registry-card">
      <h2>{production ? "Preparar DPS para emissão real" : "Preparar DPS para homologação"}</h2>
      {production ? <p>Revise os dados reais do serviço. Assinar a DPS nesta etapa apenas salva o documento para conferência.</p>
        : <p>Revise os dados para assinar e validar uma DPS de teste em produção restrita.</p>}
      {context?.productionEnabled && !pending && <button type="button" className="button-secondary" disabled={busy} onClick={switchMode}>
        {production ? "Voltar à homologação" : "Preparar emissão real"}
      </button>}
      {!context && !error && <p role="status">Conferindo dados da empresa…</p>}
      {error && <p className="registry-error" role="alert">{error}</p>}
      {result && !production && <p className="registry-notice" role="status">
        {saved || context?.prepared?.current ? "DPS assinada localmente" : "DPS assinada em uma versão anterior"} · <code>{result.idDps}</code>
      </p>}
      {production && context && <dl className="record-details">
        <div><dt>Tomador</dt><dd>{context.customerName}</dd></div>
        <div><dt>Serviço</dt><dd>{context.description}</dd></div>
        <div><dt>Valor</dt><dd>{Number(context.amount).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</dd></div>
      </dl>}
      {production && !result?.sha256 && <p role="status">Envio bloqueado até a autorização da primeira nota.</p>}
      {production && result?.sha256 && result.details && result.transmission && <ProductionDpsReview
        key={result.idDps} draftPath={path} idDps={result.idDps} sha256={result.sha256} details={result.details}
        transmission={result.transmission} codes={result.codes ?? []} current={Boolean(saved || context?.prepared?.current)} request={request} />}
      {result && attempts && <HomologationCard key={result.idDps} draftPath={path} dpsId={result.idDps}
        current={Boolean(saved || context?.prepared?.current)} previous={attempts.find(({ idDps }) => idDps === result.idDps)} request={request} />}
      {olderAttempts.length > 0 && <details>
        <summary>Tentativas anteriores de homologação</summary>
        {olderAttempts.map((attempt) => <HomologationCard key={attempt.idDps} draftPath={path} dpsId={attempt.idDps}
          current={false} previous={attempt} request={request} />)}
      </details>}
      {context && !context.issuerCity && <p>Preencha o código IBGE do município em <a href="#organizacao">Organização</a>.</p>}
      {context && !context.certificateAvailable && <p>O proprietário precisa cadastrar um certificado A1 válido da empresa.</p>}
      {context?.certificateAvailable && context.issuerCity && !saved && !pending && (
        <form className="record-form" onSubmit={submit}>
          <fieldset disabled={busy}>
            <DateInput label="Competência" name="dCompet" required />
            <label>Município da prestação (código IBGE)<input name="cLocPrestacao" inputMode="numeric" pattern="[0-9]{7}" defaultValue={context.issuerCity} required /></label>
            <label>{production ? "Série do aplicativo próprio" : "Série de teste"}<input name="serie" inputMode="numeric" pattern="[0-9]{1,5}" required /></label>
            <label>Número disponível da DPS<input name="nDPS" inputMode="numeric" pattern="[1-9][0-9]{0,14}" required /></label>
            <label>Código nacional do serviço (6 dígitos)<input name="cTribNac" inputMode="numeric" pattern="[0-9]{6}" defaultValue={context.nationalServiceCode ?? ""} required /></label>
            <label>Código municipal (se aplicável)<input name="cTribMun" inputMode="numeric" pattern="[0-9]{3}" defaultValue={context.municipalServiceCode ?? ""} /></label>
            <label>Código NBS (se aplicável)<input name="cNBS" inputMode="numeric" pattern="[0-9]{9}" /></label>
            <label>Opção pelo Simples Nacional
              <select value={regime} onChange={(event) => { setRegime(event.target.value); setTotalMode("pTotTrib"); }} required>
                <option value="">Selecione</option><option value="1">Não optante</option><option value="2">MEI</option><option value="3">ME/EPP optante</option>
              </select>
            </label>
            {regime === "3" && <label>Código do regime de apuração do Simples<input name="regApTribSN" inputMode="numeric" pattern="[1-3]" required /></label>}
            <label>Código do regime especial de tributação<input name="regEspTrib" inputMode="numeric" pattern="[0-69]" required /></label>
            <label>Retenção de ISSQN
              <select name="tpRetISSQN" defaultValue="" required>
                <option value="">Selecione</option><option value="1">Sem retenção</option><option value="2">Retido pelo tomador</option>
              </select>
            </label>
            <label>Alíquota de ISSQN (%) quando aplicável<input name="pAliq" inputMode="decimal" pattern="[0-9]([.,][0-9]{1,2})?" /></label>
            {production && <>
              <label><input type="checkbox" checked={includeAddress} onChange={(event) => setIncludeAddress(event.target.checked)} /> Informar endereço do tomador</label>
              {includeAddress && <fieldset>
                <legend>Endereço do tomador</legend>
                <label>Município do tomador (código IBGE)<input name="buyerMunicipality" inputMode="numeric" pattern="[0-9]{7}" required /></label>
                <label>CEP<input name="buyerZip" inputMode="numeric" pattern="[0-9]{5}-?[0-9]{3}" required /></label>
                <label>Logradouro<input name="buyerStreet" maxLength={255} required /></label>
                <label>Número do endereço<input name="buyerNumber" maxLength={60} required /></label>
                <label>Complemento<input name="buyerComplement" maxLength={156} /></label>
                <label>Bairro<input name="buyerNeighborhood" maxLength={60} required /></label>
              </fieldset>}
            </>}
            <label>Totais aproximados de tributos
              <select value={totalMode} onChange={(event) => setTotalMode(event.target.value)}>
                <option value="pTotTrib">Percentuais</option><option value="vTotTrib">Valores em reais</option>
                {regime === "3" && <option value="pTotTribSN">Percentual do Simples</option>}
                {regime === "2" && <option value="indTotTrib">Sem detalhamento (MEI)</option>}
              </select>
            </label>
            {(totalMode === "pTotTrib" || totalMode === "vTotTrib") && (
              ["federal", "estadual", "municipal"].map((name) => (
                <label key={name}>Total {name} ({totalMode === "pTotTrib" ? "%" : "R$"})
                  <input name={name} inputMode="decimal" pattern="[0-9]+([.,][0-9]{1,2})?" required />
                </label>
              ))
            )}
            {totalMode === "pTotTribSN" && <label>Percentual do Simples<input name="pTotTribSN" inputMode="decimal" pattern="[0-9]{1,2}([.,][0-9]{1,2})?" required /></label>}
          </fieldset>
          <div className="record-actions"><button disabled={busy}>{busy ? "Assinando…" : production ? "Assinar e salvar para revisão" : "Assinar DPS localmente"}</button></div>
        </form>
      )}
      <div className="record-actions registry-pagination">
        <button type="button" className="button-secondary" disabled={busy} onClick={close}>Voltar aos rascunhos</button>
      </div>
    </div>
  );
}
