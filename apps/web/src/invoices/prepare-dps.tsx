import { DateInput } from "../formatted-inputs";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { errorMessage, RegistrationError, useRegistrationRequest } from "../registrations/api";
import { HomologationCard, type HomologationResult } from "./homologation";
import { ProductionDpsReview, type ProductionReview } from "./production-review";

type Signed = { state: "locally-signed"; idDps: string; preparedAt: string } & Partial<ProductionReview>;
type FiscalDefaults = {
  serie: string;
  nDPS: string;
  cLocPrestacao: string;
  cTribNac: string;
  cTribMun?: string;
  cNBS?: string;
  opSimpNac: string;
  regApTribSN?: string;
  regEspTrib: string;
  tpRetISSQN: string;
  pAliq?: string;
  totTrib: { pTotTribSN?: string; indTotTrib?: string; pTotTrib?: Record<string, string>; valuesPerInvoice?: boolean };
  buyerAddress?: { municipality: string; zipCode: string; street: string; number: string; complement?: string; neighborhood: string };
};
type Context = {
  draftVersion: string;
  issuerCity: string | null;
  nationalServiceCode: string | null;
  municipalServiceCode: string | null;
  certificateAvailable: boolean;
  prepared: (Signed & { current: boolean }) | null;
  homologation: HomologationResult[] | null;
  productionEnabled?: boolean;
  hasIssuerMunicipalRegistration?: boolean;
  customerName?: string;
  description?: string;
  amount?: string;
  hasLinkedService?: boolean;
  numbering?: { serie: string; nDPS: string };
  fiscalDefaults?: FiscalDefaults;
};
type Request = ReturnType<typeof useRegistrationRequest>;

const errors: Record<string, string> = {
  "draft-changed": "O rascunho mudou. Abra a versão mais recente para preparar a DPS.",
  "production-preparation-disabled": "A emissão em produção está bloqueada. Solicite a liberação à equipe do Fiscal Floow.",
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

type FormProps = { draftId: string; request: Request; close: () => void; pending?: boolean; direct?: boolean;
  preferProduction?: boolean; initialCompetence?: string };

export function PrepareDpsForm(props: FormProps) {
  const [mode, setMode] = useState(props.pending ? "production" : props.preferProduction ? "preferred" : "homologation");
  const production = mode !== "homologation";
  const fallback = useCallback(() => setMode("homologation"), []);
  return <DpsForm key={String(production)} {...props} production={production}
    fallback={mode === "preferred" ? fallback : undefined} switchMode={() => setMode(production ? "homologation" : "production")} />;
}

function DpsForm({ draftId, request, close, pending, production, direct, initialCompetence, switchMode, fallback }: FormProps & {
  production: boolean; switchMode: () => void; fallback?: () => void;
}) {
  const [context, setContext] = useState<Context>();
  const [regime, setRegime] = useState("");
  const [totalMode, setTotalMode] = useState("pTotTrib");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Signed>();
  const [includeAddress, setIncludeAddress] = useState(false);
  const [retention, setRetention] = useState("");
  const [editingFiscal, setEditingFiscal] = useState(false);
  const [revision, setRevision] = useState(0);
  const defaults = context?.fiscalDefaults;
  const buyerAddress = defaults?.buyerAddress;
  const path = "invoices/" + encodeURIComponent(draftId) + (production ? "/production-dps" : "/dps");
  useEffect(() => {
    const controller = new AbortController();
    request<Context>(path, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setContext(data);
        const fiscal = data.fiscalDefaults;
        setRegime(fiscal?.opSimpNac ?? "");
        const totals = fiscal?.totTrib;
        setTotalMode(totals?.pTotTribSN !== undefined ? "pTotTribSN" : totals?.indTotTrib !== undefined ? "indTotTrib"
          : totals?.valuesPerInvoice ? "vTotTrib" : "pTotTrib");
        setIncludeAddress(Boolean(fiscal?.buyerAddress));
        setRetention(fiscal?.tpRetISSQN ?? "");
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (fallback && failure instanceof RegistrationError && failure.status === 404 &&
            (!failure.code || failure.code === "production-preparation-disabled" || failure.code === "not-found")) {
          fallback();
          return;
        }
        setError(message(failure));
      });
    return () => controller.abort();
  }, [path, request, fallback, revision]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!context?.certificateAvailable || busy) return;
    const fields = new FormData(event.currentTarget);
    const get = (key: string) => String(fields.get(key) ?? "").trim();
    const optional = (key: string) => get(key) || undefined;
    const nationalCode = get("cTribNac").replaceAll(".", "");
    const municipalCode = get("cTribMun").split(".");
    if (municipalCode.length > 1 && municipalCode.slice(0, -1).join("") !== nationalCode) {
      setError("O código complementar municipal precisa corresponder ao código nacional do serviço.");
      return;
    }
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
          cLocPrestacao: get("cLocPrestacao"), cTribNac: nationalCode,
          cTribMun: municipalCode.at(-1) || undefined, cNBS: optional("cNBS")?.replaceAll(".", ""),
          opSimpNac: regime, regApTribSN: optional("regApTribSN"),
          regEspTrib: get("regEspTrib"), tpRetISSQN: get("tpRetISSQN"), pAliq: get("pAliq") ? decimal("pAliq") : undefined, totTrib,
          ...(!production && fields.has("omitIssuerMunicipalRegistration") && { omitIssuerMunicipalRegistration: true }),
          ...(production && { rememberFiscalData: true }),
          ...(production && fields.has("rememberServiceFiscalData") && { rememberServiceFiscalData: true }),
          ...(production && includeAddress && { buyerAddress: {
            municipality: get("buyerMunicipality"), zipCode: get("buyerZip").replace(/-/g, ""),
            street: get("buyerStreet"), number: get("buyerNumber"),
            complement: optional("buyerComplement"), neighborhood: get("buyerNeighborhood"),
          } }),
        }),
      }));
      setEditingFiscal(false);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  const result = saved ?? context?.prepared;
  const canShowSigned = production && !editingFiscal && result?.sha256 && result.details && result.transmission;
  const canEdit = context?.certificateAvailable && context.issuerCity && !saved && !pending &&
    (production ? !canShowSigned || (!direct && result?.transmission !== "PENDING" && result?.transmission !== "AUTHORIZED") : true);
  const reviewCompetence = result?.details?.competence ?? initialCompetence;
  const attempts = context?.homologation;
  const olderAttempts = attempts?.filter(({ idDps }) => idDps !== result?.idDps) ?? [];
  return (
    <div className="registry-card">
      <h2>{production ? direct ? "Emissão de NFS-e" : "Preparar DPS para emissão real" : "Preparar DPS para homologação"}</h2>
      {production ? <p>{direct ? "Confira os dados fiscais da prestação antes de emitir." : "Revise os dados reais do serviço antes de assinar a DPS."}</p>
        : <p>Revise os dados para assinar e validar uma DPS de teste em produção restrita.</p>}
      {context?.productionEnabled && !pending && (!direct || !production) && <button type="button" className="button-secondary" disabled={busy} onClick={switchMode}>
        {production ? "Voltar à homologação" : "Preparar emissão real"}
      </button>}
      {!context && !error && <p role="status">Conferindo dados da empresa…</p>}
      {error && <p className="registry-error" role="alert">{error}</p>}
      {result && !production && <p className="registry-notice" role="status">
        {saved || context?.prepared?.current ? "DPS assinada localmente" : "DPS assinada em uma versão anterior"} · <code>{result.idDps}</code>
      </p>}
      {production && context && !canShowSigned && <dl className="record-details">
        <div><dt>Tomador</dt><dd>{context.customerName}</dd></div>
        <div><dt>Serviço</dt><dd>{context.description}</dd></div>
        <div><dt>Valor</dt><dd>{Number(context.amount).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</dd></div>
      </dl>}
      {canShowSigned && result?.sha256 && result.details && result.transmission && <ProductionDpsReview
        key={result.idDps} draftPath={path} idDps={result.idDps} sha256={result.sha256} details={result.details}
        transmission={result.transmission} codes={result.codes ?? []} current={Boolean(saved || context?.prepared?.current)} request={request}
        direct={direct} edit={direct ? () => {
          setEditingFiscal(true);
          setContext(undefined);
          setSaved(undefined);
          setError("");
          setRevision((value) => value + 1);
        } : undefined} />}
      {result && attempts && <HomologationCard key={result.idDps} draftPath={path} dpsId={result.idDps}
        current={Boolean(saved || context?.prepared?.current)} previous={attempts.find(({ idDps }) => idDps === result.idDps)} request={request} />}
      {olderAttempts.length > 0 && <details>
        <summary>Tentativas anteriores de homologação</summary>
        {olderAttempts.map((attempt) => <HomologationCard key={attempt.idDps} draftPath={path} dpsId={attempt.idDps}
          current={false} previous={attempt} request={request} />)}
      </details>}
      {context && !context.issuerCity && <p>Preencha o código IBGE do município em <a href="#organizacao">Organização</a>.</p>}
      {context && !context.certificateAvailable && result?.transmission !== "AUTHORIZED" && <p>O proprietário precisa cadastrar um certificado A1 válido da empresa.</p>}
      {canEdit && context && (
        <form className="record-form" onSubmit={submit}>
          <fieldset disabled={busy}>
            <DateInput label="Competência" name="dCompet" defaultValue={reviewCompetence} required />
            <details className="dps-fiscal-details" open={!defaults || defaults.totTrib.valuesPerInvoice} onInvalidCapture={(event) => { event.currentTarget.open = true; }}>
              <summary>{defaults ? "Conferir ou editar os dados fiscais salvos" : "Dados fiscais"}</summary>
              <fieldset aria-label="Dados fiscais">
                <label>Município da prestação (código IBGE)<input name="cLocPrestacao" inputMode="numeric" pattern="[0-9]{7}" defaultValue={defaults?.cLocPrestacao ?? context.issuerCity ?? undefined} required /></label>
                <label>{production ? "Série do aplicativo próprio" : "Série de teste"}<input name="serie" inputMode="numeric" pattern="[0-9]{1,5}" defaultValue={defaults?.serie ?? context.numbering?.serie} required /></label>
                <label>Número disponível da DPS<input name="nDPS" inputMode="numeric" pattern="[1-9][0-9]{0,14}" defaultValue={defaults?.nDPS ?? context.numbering?.nDPS} required /></label>
                <label>Código de tributação nacional<input name="cTribNac" inputMode="decimal" pattern="[0-9]{6}|[0-9]{2}[.][0-9]{2}[.][0-9]{2}" defaultValue={defaults ? defaults.cTribNac : context.nationalServiceCode ?? ""} required /></label>
                <label>Código complementar municipal (se aplicável)<input name="cTribMun" inputMode="decimal" pattern="[0-9]{3}|[0-9]{2}[.][0-9]{2}[.][0-9]{2}[.][0-9]{3}" defaultValue={defaults ? defaults.cTribMun : context.municipalServiceCode ?? ""} /></label>
                <label>Código NBS (se aplicável)<input name="cNBS" inputMode="decimal" pattern="[0-9]{9}|[0-9][.][0-9]{4}[.][0-9]{2}[.][0-9]{2}" defaultValue={defaults?.cNBS} /></label>
                {!production && context.hasIssuerMunicipalRegistration && (
                  <label><input type="checkbox" name="omitIssuerMunicipalRegistration" /> Omitir inscrição municipal do prestador neste teste (E0120)</label>
                )}
                <label>Opção pelo Simples Nacional
                  <select value={regime} onChange={(event) => { setRegime(event.target.value); setTotalMode("pTotTrib"); }} required>
                    <option value="">Selecione</option><option value="1">Não optante</option><option value="2">MEI</option><option value="3">ME/EPP optante</option>
                  </select>
                </label>
                {regime === "3" && <label>Código do regime de apuração do Simples<input name="regApTribSN" inputMode="numeric" pattern="[1-3]" defaultValue={defaults?.regApTribSN} required /></label>}
                <label>Código do regime especial de tributação<input name="regEspTrib" inputMode="numeric" pattern="[0-69]" defaultValue={defaults?.regEspTrib} required /></label>
                <label>Retenção de ISSQN
                  <select name="tpRetISSQN" value={retention} onChange={(event) => setRetention(event.target.value)} required>
                    <option value="">Selecione</option><option value="1">Sem retenção</option><option value="2">Retido pelo tomador</option>
                  </select>
                </label>
                <label>Alíquota de ISSQN (%) quando aplicável<input name="pAliq" inputMode="decimal" pattern="[0-9]([.,][0-9]{1,2})?" defaultValue={defaults?.pAliq} /></label>
                {production && <>
                  <label className="record-checkbox"><input type="checkbox" checked={includeAddress} onChange={(event) => setIncludeAddress(event.target.checked)} /> Informar endereço do tomador</label>
                  {includeAddress && <fieldset>
                    <legend>Endereço do tomador</legend>
                    <label>Município do tomador (código IBGE)<input name="buyerMunicipality" inputMode="numeric" pattern="[0-9]{7}" defaultValue={buyerAddress?.municipality} required /></label>
                    <label>CEP<input name="buyerZip" inputMode="numeric" pattern="[0-9]{5}-?[0-9]{3}" defaultValue={buyerAddress?.zipCode} required /></label>
                    <label>Logradouro<input name="buyerStreet" maxLength={255} defaultValue={buyerAddress?.street} required /></label>
                    <label>Número do endereço<input name="buyerNumber" maxLength={60} defaultValue={buyerAddress?.number} required /></label>
                    <label>Complemento<input name="buyerComplement" maxLength={156} defaultValue={buyerAddress?.complement} /></label>
                    <label>Bairro<input name="buyerNeighborhood" maxLength={60} defaultValue={buyerAddress?.neighborhood} required /></label>
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
                      <input key={totalMode} name={name} inputMode="decimal" pattern="[0-9]+([.,][0-9]{1,2})?" defaultValue={totalMode === "pTotTrib" ? defaults?.totTrib.pTotTrib?.[name] : undefined} required />
                    </label>
                  ))
                )}
                {totalMode === "pTotTribSN" && <label>Percentual do Simples<input name="pTotTribSN" inputMode="decimal" pattern="[0-9]{1,2}([.,][0-9]{1,2})?" defaultValue={defaults?.totTrib.pTotTribSN} required /></label>}
                {production && context.hasLinkedService && retention === "1" && !includeAddress && (
                  <label className="record-checkbox"><input type="checkbox" name="rememberServiceFiscalData" /> Usar como padrão deste serviço para outros clientes sem retenção de ISSQN</label>
                )}
              </fieldset>
            </details>
          </fieldset>
          <div className="record-actions"><button disabled={busy}>{busy ? "Preparando…" : production
            ? direct ? "Revisar nota" : "Assinar e salvar para revisão" : "Assinar DPS localmente"}</button></div>
        </form>
      )}
      <div className="record-actions registry-pagination">
        <button type="button" className="button-secondary" disabled={busy} onClick={close}>{direct ? "Voltar às notas fiscais" : "Voltar aos rascunhos"}</button>
      </div>
    </div>
  );
}
