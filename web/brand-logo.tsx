import { brandArt } from './brand-art.mjs';
// Logo artwork from https://softline.ru/local/templates/softline/assets/images/logo.svg
export function BrandLogo({ compact = false }: { compact?: boolean }) {
  return (
    <svg className="brand-mark" viewBox={compact ? "447.4 30.2 98.3 98.3" : "0 0 566.9 141.7"} aria-hidden="true" focusable="false">
      <g dangerouslySetInnerHTML={{ __html: brandArt }} />
    </svg>
  );
}
