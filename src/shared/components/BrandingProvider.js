"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { buildBrandPalette, DEFAULT_BRANDING, publicBranding } from "@/shared/branding";

const DEFAULT_PUBLIC_BRANDING = publicBranding(DEFAULT_BRANDING);
const BrandingContext = createContext(null);

export function applyBrandingToDocument(branding) {
  if (typeof document === "undefined") return;
  const current = { ...DEFAULT_PUBLIC_BRANDING, ...(branding || {}) };
  const palette = buildBrandPalette(current.primaryColor);
  const root = document.documentElement;

  for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]) {
    root.style.setProperty(`--color-brand-${shade}`, palette[shade]);
  }
  root.style.setProperty("--color-brand-rgb", palette.rgb);
  root.style.setProperty("--color-primary", palette[500]);
  root.style.setProperty("--color-primary-hover", palette[600]);
  root.style.setProperty("--color-accent", palette[500]);
  root.style.setProperty("--shadow-warm", `0 2px 12px -2px rgb(${palette.rgb} / 0.24)`);
  root.style.setProperty("--shadow-focus", `0 0 0 3px rgb(${palette.rgb} / 0.18)`);

  document.title = current.description
    ? `${current.name} - ${current.description}`
    : current.name;

  let description = document.querySelector('meta[name="description"]');
  if (!description) {
    description = document.createElement("meta");
    description.name = "description";
    document.head.appendChild(description);
  }
  description.content = current.description;

  const favicons = Array.from(document.querySelectorAll('link[rel~="icon"]'));
  if (favicons.length === 0) {
    const favicon = document.createElement("link");
    favicon.rel = "icon";
    document.head.appendChild(favicon);
    favicons.push(favicon);
  }
  for (const favicon of favicons) {
    favicon.dataset.runtimeBranding = "true";
    favicon.removeAttribute("type");
    favicon.removeAttribute("sizes");
    favicon.href = current.faviconSrc;
  }
}

export function BrandingProvider({ children }) {
  const [branding, setBrandingState] = useState(DEFAULT_PUBLIC_BRANDING);
  const [loading, setLoading] = useState(true);

  const setBranding = useCallback((next) => {
    const merged = { ...DEFAULT_PUBLIC_BRANDING, ...(next || {}) };
    setBrandingState(merged);
    applyBrandingToDocument(merged);
    return merged;
  }, []);

  const refreshBranding = useCallback(async () => {
    try {
      const response = await fetch("/api/branding", { cache: "no-store" });
      if (!response.ok) return null;
      const next = await response.json();
      return setBranding(next);
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, [setBranding]);

  useEffect(() => {
    applyBrandingToDocument(DEFAULT_PUBLIC_BRANDING);
    refreshBranding();
  }, [refreshBranding]);

  const value = useMemo(() => ({ branding, loading, refreshBranding, setBranding }), [branding, loading, refreshBranding, setBranding]);
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding() {
  const context = useContext(BrandingContext);
  if (!context) {
    return {
      branding: DEFAULT_PUBLIC_BRANDING,
      loading: false,
      refreshBranding: async () => null,
      setBranding: () => DEFAULT_PUBLIC_BRANDING,
    };
  }
  return context;
}
