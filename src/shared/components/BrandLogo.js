"use client";

import { useEffect, useState } from "react";
import { cn } from "@/shared/utils/cn";
import { useBranding } from "./BrandingProvider";

export default function BrandLogo({ className = "", iconClassName = "text-[20px]", alt, decorative = false }) {
  const { branding } = useBranding();
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [branding.logoSrc]);

  if (!failed && branding.logoSrc) {
    return (
      <img
        src={branding.logoSrc}
        alt={decorative ? "" : (alt || branding.name)}
        aria-hidden={decorative || undefined}
        className={cn("object-contain", className)}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        data-i18n-skip="true"
      />
    );
  }

  return (
    <span
      className={cn("material-symbols-outlined", iconClassName, className)}
      aria-label={decorative ? undefined : (alt || branding.name)}
      aria-hidden={decorative || undefined}
    >
      hub
    </span>
  );
}
