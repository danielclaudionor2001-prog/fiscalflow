import { useRef, useState, type FormEvent } from "react";
import { formatDocument } from "../format";
import { field, jsonRequest, Notice, useAction, useResource, type Request } from "./shared";

export type CommercialBrand = {
  legalName: string; tradeName: string | null; cnpj: string | null;
  commercialEmail: string | null; commercialPhone: string | null; commercialAddress: string | null;
  logo: string | null; quoteWatermark: boolean;
};

async function prepareLogo(file: File) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
    throw new Error("Use uma imagem PNG, JPEG ou WebP de até 5 MB.");
  }
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 640 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Não foi possível processar a imagem.");
    for (const factor of [scale, scale * .75, scale * .5]) {
      canvas.width = Math.max(1, Math.round(image.width * factor));
      canvas.height = Math.max(1, Math.round(image.height * factor));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/png");
      if (url.length <= 524288 + "data:image/png;base64,".length) return url;
    }
    throw new Error("Escolha um logo menor.");
  } finally {
    image.close();
  }
}

function BrandingForm({ request, brand, saved }: { request: Request; brand: CommercialBrand; saved: (brand: CommercialBrand) => void }) {
  const [logo, setLogo] = useState(brand.logo);
  const [loadingLogo, setLoadingLogo] = useState(false);
  const [imageError, setImageError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const action = useAction();

  async function selectLogo(file?: File) {
    if (!file) return;
    setImageError("");
    setLoadingLogo(true);
    try {
      setLogo(await prepareLogo(file));
    } catch {
      setImageError("Não foi possível usar a imagem. Escolha um PNG, JPEG ou WebP de até 5 MB.");
      if (input.current) input.current.value = "";
    } finally {
      setLoadingLogo(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loadingLogo) return;
    const form = new FormData(event.currentTarget);
    void action.run(async () => {
      saved(await request<CommercialBrand>("organizations/current/branding", jsonRequest("PUT", {
        commercialEmail: field(form, "commercialEmail") || null,
        commercialPhone: field(form, "commercialPhone") || null,
        commercialAddress: field(form, "commercialAddress") || null,
        quoteWatermark: form.has("quoteWatermark"),
        ...(logo !== brand.logo && { commercialLogo: logo?.split(",")[1] ?? null }),
      })));
    });
  }

  return <form className="record-form" onSubmit={save}>
    <fieldset disabled={action.busy || loadingLogo}>
      <label>E-mail comercial<input type="email" name="commercialEmail" maxLength={254} defaultValue={brand.commercialEmail ?? ""} /></label>
      <label>Telefone comercial<input type="tel" name="commercialPhone" maxLength={40} defaultValue={brand.commercialPhone ?? ""} /></label>
      <label>Endereço comercial<textarea name="commercialAddress" maxLength={300} rows={2} defaultValue={brand.commercialAddress ?? ""} /></label>
      <label>Logo da empresa<input ref={input} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void selectLogo(event.currentTarget.files?.[0])} /></label>
      {logo && <div className="record-actions">
        <img className="commercial-brand-logo" src={logo} alt="Prévia do logo" />
        <button type="button" className="button-secondary" onClick={() => { setLogo(null); if (input.current) input.current.value = ""; }}>Remover logo</button>
      </div>}
      <label className="record-checkbox"><input name="quoteWatermark" type="checkbox" defaultChecked={brand.quoteWatermark} />Usar o logo como marca d’água no orçamento</label>
    </fieldset>
    <Notice error={imageError || action.error} />
    <div className="record-actions"><button disabled={action.busy || loadingLogo}>Salvar identidade visual</button></div>
  </form>;
}

export function CommercialBranding({ request }: { request: Request }) {
  const resource = useResource<CommercialBrand>(request, "organizations/current/branding");
  const [savedBrand, setSavedBrand] = useState<CommercialBrand>();
  const brand = savedBrand ?? resource.data;
  return <section className="registry-card">
    <h2>Identidade visual e dados comerciais</h2>
    <p>Use estes dados nos orçamentos e compartilhe apenas contatos comerciais com seus clientes.</p>
    {!brand && <Notice error={resource.error} pending reload={resource.reload} />}
    {brand && <BrandingForm request={request} brand={brand} saved={setSavedBrand} />}
    {savedBrand && <p role="status" className="registry-notice">Identidade visual salva.</p>}
  </section>;
}

export function CommercialBrandHeader({ brand }: { brand?: CommercialBrand }) {
  if (!brand) return null;
  return <div className="commercial-brand">
    {brand.logo && <img className="commercial-brand-logo" src={brand.logo} alt={brand.tradeName ?? brand.legalName} />}
    <div>
      <strong>{brand.tradeName || brand.legalName}</strong>
      {brand.tradeName && brand.tradeName !== brand.legalName && <span>{brand.legalName}</span>}
      {brand.cnpj && <span>CNPJ {formatDocument(brand.cnpj)}</span>}
      {brand.commercialAddress && <span className="commercial-address">{brand.commercialAddress}</span>}
      {(brand.commercialEmail || brand.commercialPhone) && <span>{[brand.commercialEmail, brand.commercialPhone].filter(Boolean).join(" · ")}</span>}
    </div>
  </div>;
}
