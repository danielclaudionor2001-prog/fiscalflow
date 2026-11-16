import { useRef, useState, type FormEvent } from "react";
import { formatDocument } from "../format";
import { field, jsonRequest, Notice, useAction, useResource, type Request } from "./shared";

export type CommercialBrand = {
  legalName: string; tradeName: string | null; cnpj: string | null;
  commercialEmail: string | null; commercialPhone: string | null; commercialAddress: string | null;
  logo: string | null; quoteWatermark: boolean; watermarkImage: string | null;
};

async function prepareBrandImage(file: File) {
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
    throw new Error("Escolha uma imagem menor.");
  } finally {
    image.close();
  }
}

function BrandImageInput({ label, preview, remove, image, onChange, onLoading, onError }: {
  label: string; preview: string; remove: string; image: string | null; onChange: (image: string | null) => void;
  onLoading: (busy: boolean) => void; onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  async function selectImage(file?: File) {
    if (!file) return;
    onError("");
    onLoading(true);
    try {
      onChange(await prepareBrandImage(file));
    } catch {
      onError("Não foi possível usar a imagem. Escolha um PNG, JPEG ou WebP de até 5 MB.");
      if (input.current) input.current.value = "";
    } finally {
      onLoading(false);
    }
  }
  return <div className="commercial-brand-image-field">
    <label>{label}<input ref={input} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void selectImage(event.currentTarget.files?.[0])} /></label>
    {image && <div className="record-actions">
      <img className="commercial-brand-logo" src={image} alt={preview} />
      <button type="button" className="button-secondary" onClick={() => {
        onChange(null);
        onError("");
        if (input.current) input.current.value = "";
      }}>{remove}</button>
    </div>}
  </div>;
}

function BrandingForm({ request, brand, saved }: { request: Request; brand: CommercialBrand; saved: (brand: CommercialBrand) => void }) {
  const [logo, setLogo] = useState(brand.logo);
  const [watermarkImage, setWatermarkImage] = useState(brand.watermarkImage ?? null);
  const [loadingImage, setLoadingImage] = useState(false);
  const [imageError, setImageError] = useState("");
  const action = useAction();
  const imageState = { onLoading: setLoadingImage, onError: setImageError };

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loadingImage || action.busy) return;
    const form = new FormData(event.currentTarget);
    void action.run(async () => {
      saved(await request<CommercialBrand>("organizations/current/branding", jsonRequest("PUT", {
        commercialEmail: field(form, "commercialEmail") || null,
        commercialPhone: field(form, "commercialPhone") || null,
        commercialAddress: field(form, "commercialAddress") || null,
        quoteWatermark: form.has("quoteWatermark"),
        ...(logo !== brand.logo && { commercialLogo: logo?.split(",")[1] ?? null }),
        ...(watermarkImage !== (brand.watermarkImage ?? null) && { quoteWatermarkImage: watermarkImage?.split(",")[1] ?? null }),
      })));
    });
  }

  return <form className="record-form" onSubmit={save}>
    <fieldset disabled={action.busy || loadingImage}>
      <label>E-mail comercial<input type="email" name="commercialEmail" maxLength={254} defaultValue={brand.commercialEmail ?? ""} /></label>
      <label>Telefone comercial<input type="tel" name="commercialPhone" maxLength={40} defaultValue={brand.commercialPhone ?? ""} /></label>
      <label>Endereço comercial<textarea name="commercialAddress" maxLength={300} rows={2} defaultValue={brand.commercialAddress ?? ""} /></label>
      <BrandImageInput label="Logo da empresa" preview="Prévia do logo" remove="Remover logo" image={logo} onChange={setLogo} {...imageState} />
      <div className="commercial-brand-image-field">
        <BrandImageInput label="Imagem da marca d’água (opcional)" preview="Prévia da marca d’água" remove="Remover imagem da marca d’água"
          image={watermarkImage} onChange={setWatermarkImage} {...imageState} />
        <small>Sem imagem própria, a marca d’água usa o logo da empresa.</small>
      </div>
      <label className="record-checkbox"><input name="quoteWatermark" type="checkbox" defaultChecked={brand.quoteWatermark} />Exibir marca d’água no orçamento</label>
    </fieldset>
    <Notice error={imageError || action.error} />
    <div className="record-actions"><button disabled={action.busy || loadingImage}>Salvar identidade visual</button></div>
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
