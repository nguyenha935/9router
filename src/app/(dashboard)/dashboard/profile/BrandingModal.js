"use client";

import { useEffect, useMemo, useState } from "react";
import Modal from "@/shared/components/Modal";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Toggle from "@/shared/components/Toggle";
import { BRANDING_IMAGE_TYPES, BRANDING_LIMITS, DEFAULT_BRANDING, DEFAULT_BRANDING_ASSET_SRC, normalizeBranding, validateBrandingPatch } from "@/shared/branding";
import { useBranding } from "@/shared/components/BrandingProvider";
import { cn } from "@/shared/utils/cn";

function sourceMode(branding, kind) {
  if (branding[`${kind}DataUrl`]) return "upload";
  if (branding[`${kind}Url`]) return "url";
  return "upload";
}

function hasCustomSource(branding, kind) {
  return Boolean(branding[`${kind}DataUrl`] || branding[`${kind}Url`]);
}

function validRemoteAssetUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function readImage(file, kind) {
  const max = kind === "logo" ? BRANDING_LIMITS.logoBytes : BRANDING_LIMITS.faviconBytes;
  if (!BRANDING_IMAGE_TYPES.includes(file.type)) {
    return Promise.reject(new Error("Use PNG, JPEG, WebP, GIF, or SVG."));
  }
  if (file.size > max) {
    return Promise.reject(new Error(`${kind === "logo" ? "Logo" : "Favicon"} must be ${Math.round(max / 1024)} KB or smaller.`));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function AssetEditor({ kind, label, draft, setDraft, mode, setMode, locked, setLocked, error, setError }) {
  const dataField = `${kind}DataUrl`;
  const urlField = `${kind}Url`;
  const [previewFailed, setPreviewFailed] = useState(false);
  const [defaultPreviewFailed, setDefaultPreviewFailed] = useState(false);
  const customPreview = mode === "upload" ? draft[dataField] : draft[urlField];
  const hasCustom = hasCustomSource(draft, kind);
  const preview = customPreview && !previewFailed ? customPreview : DEFAULT_BRANDING_ASSET_SRC;

  useEffect(() => {
    setPreviewFailed(false);
    setDefaultPreviewFailed(false);
  }, [customPreview]);

  const pickFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || locked) return;
    try {
      const dataUrl = await readImage(file, kind);
      setDraft((current) => ({ ...current, [dataField]: dataUrl, [urlField]: "" }));
      setMode("upload");
      setLocked(true);
      setError("");
    } catch (readError) {
      setError(readError.message);
    }
  };

  const switchMode = (next) => {
    if (locked) return;
    setMode(next);
    setError("");
    setDraft((current) => ({
      ...current,
      [dataField]: next === "upload" ? current[dataField] : "",
      [urlField]: next === "url" ? current[urlField] : "",
    }));
  };

  const removeCustom = () => {
    setDraft((current) => ({ ...current, [dataField]: "", [urlField]: "" }));
    setMode("upload");
    setLocked(false);
    setError("");
  };

  const lockUrl = () => {
    const value = draft[urlField].trim();
    if (!value) return;
    if (!validRemoteAssetUrl(value)) {
      setError("Use an http or https URL.");
      return;
    }
    setLocked(true);
  };

  const handlePreviewError = () => {
    if (customPreview && !previewFailed) {
      setPreviewFailed(true);
      return;
    }
    setDefaultPreviewFailed(true);
  };

  return (
    <div className="rounded-[10px] border border-border bg-bg p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-text-main">{label}</p>
          <p className="text-xs text-text-muted">Choose one source.</p>
        </div>
        <div className="flex rounded-lg bg-surface-2 p-1">
          {["upload", "url"].map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => switchMode(option)}
              disabled={locked}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                mode === option ? "bg-surface text-primary shadow-sm" : "text-text-muted hover:text-text-main",
                locked && "cursor-not-allowed opacity-50"
              )}
            >
              {option === "upload" ? "Upload" : "URL"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-3">
        <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-transparent">
          {!defaultPreviewFailed ? (
            <img src={preview} alt={`${label} preview`} className="size-full object-contain" onError={handlePreviewError} />
          ) : (
            <span className="material-symbols-outlined text-[24px] text-text-muted">hub</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {mode === "upload" ? (
            <label className={cn(
              "inline-flex h-9 items-center gap-2 rounded-[10px] border border-border bg-surface-2 px-3 text-sm font-semibold text-text-main transition-colors",
              locked ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-surface-3"
            )}>
              <input type="file" accept={BRANDING_IMAGE_TYPES.join(",")} onChange={pickFile} disabled={locked} className="hidden" />
              <span className="material-symbols-outlined text-[18px]">upload</span>
              Choose image
            </label>
          ) : (
            <Input
              value={draft[urlField]}
              disabled={locked}
              onChange={(event) => {
                setDraft((current) => ({ ...current, [urlField]: event.target.value, [dataField]: "" }));
                setError("");
              }}
              onBlur={lockUrl}
              placeholder="https://example.com/brand.png"
              error={error}
            />
          )}
          {mode === "upload" && error && <p className="mt-1 text-xs text-red-500">{error}</p>}
          {locked && <p className="mt-2 text-xs text-text-muted">Remove the current custom {kind} before choosing another source.</p>}
          {hasCustom ? (
            <button
              type="button"
              onClick={removeCustom}
              className="mt-2 text-xs font-medium text-text-muted hover:text-red-500"
            >
              Remove custom {kind}
            </button>
          ) : (
            <p className="mt-2 text-xs text-text-muted">Using the default 9Router asset.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function BrandingModal({ isOpen, onClose, value, onSaved }) {
  const { refreshBranding } = useBranding();
  const [draft, setDraft] = useState(() => normalizeBranding(value));
  const [logoMode, setLogoMode] = useState("upload");
  const [faviconMode, setFaviconMode] = useState("upload");
  const [logoLocked, setLogoLocked] = useState(() => hasCustomSource(normalizeBranding(value), "logo"));
  const [faviconLocked, setFaviconLocked] = useState(() => hasCustomSource(normalizeBranding(value), "favicon"));
  const [fieldErrors, setFieldErrors] = useState({});
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const next = normalizeBranding(value);
    setDraft(next);
    setLogoMode(sourceMode(next, "logo"));
    setFaviconMode(sourceMode(next, "favicon"));
    setLogoLocked(hasCustomSource(next, "logo"));
    setFaviconLocked(hasCustomSource(next, "favicon"));
    setFieldErrors({});
    setSaveError("");
  }, [isOpen, value]);

  const normalizedColor = /^#[0-9a-f]{6}$/i.test(draft.primaryColor) ? draft.primaryColor : DEFAULT_BRANDING.primaryColor;
  const payload = useMemo(() => ({
    name: draft.name.trim(),
    description: draft.description.trim(),
    primaryColor: draft.primaryColor.toUpperCase(),
    logoUrl: logoMode === "url" ? draft.logoUrl.trim() : "",
    logoDataUrl: logoMode === "upload" ? draft.logoDataUrl : "",
    faviconUrl: faviconMode === "url" ? draft.faviconUrl.trim() : "",
    faviconDataUrl: faviconMode === "upload" ? draft.faviconDataUrl : "",
    showAuthorPromotions: draft.showAuthorPromotions !== false,
  }), [draft, logoMode, faviconMode]);

  const save = async () => {
    const validationError = validateBrandingPatch(payload);
    if (validationError) {
      const field = validationError.includes("name") ? "name"
        : validationError.includes("description") ? "description"
          : validationError.includes("primaryColor") ? "primaryColor"
            : validationError.includes("logo") ? "logo"
              : validationError.includes("favicon") ? "favicon"
                : "general";
      setFieldErrors({ [field]: validationError.replace(/^branding\./, "") });
      setSaveError(field === "general" ? validationError : "");
      return;
    }

    setSaving(true);
    setFieldErrors({});
    setSaveError("");
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branding: payload }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to save branding");
      await refreshBranding();
      onSaved?.(data.branding);
      onClose();
    } catch (error) {
      setSaveError(error.message || "Failed to save branding");
    } finally {
      setSaving(false);
    }
  };

  const resetDraft = () => {
    setDraft({ ...DEFAULT_BRANDING });
    setLogoMode("upload");
    setFaviconMode("upload");
    setLogoLocked(false);
    setFaviconLocked(false);
    setFieldErrors({});
    setSaveError("");
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Branding"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={resetDraft} disabled={saving}>Reset to defaults</Button>
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving}>Save</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-i18n-skip="true">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Application name"
            required
            maxLength={BRANDING_LIMITS.name}
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            error={fieldErrors.name}
          />
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-main">Primary color</label>
            <div className="flex gap-2">
              <input
                type="color"
                value={normalizedColor}
                onChange={(event) => setDraft((current) => ({ ...current, primaryColor: event.target.value.toUpperCase() }))}
                className="h-10 w-12 rounded-[10px] border border-border bg-surface-2 p-1"
                aria-label="Primary color picker"
              />
              <Input
                value={draft.primaryColor}
                onChange={(event) => setDraft((current) => ({ ...current, primaryColor: event.target.value }))}
                maxLength={7}
                error={fieldErrors.primaryColor}
                className="flex-1"
              />
            </div>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-text-main">Description</label>
          <textarea
            value={draft.description}
            maxLength={BRANDING_LIMITS.description}
            onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
            className={cn(
              "min-h-20 w-full resize-y rounded-[10px] border bg-surface-2 px-3 py-2.5 text-[16px] text-text-main outline-none transition-all sm:text-sm",
              fieldErrors.description ? "border-red-500 ring-1 ring-red-500" : "border-transparent focus:border-brand-500/40 focus:ring-2 focus:ring-brand-500/30"
            )}
          />
          <div className="mt-1 flex justify-between text-xs text-text-muted">
            <span className={fieldErrors.description ? "text-red-500" : ""}>{fieldErrors.description || "Shown on login and in browser metadata."}</span>
            <span>{draft.description.length}/{BRANDING_LIMITS.description}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <AssetEditor kind="logo" label="Application logo" draft={draft} setDraft={setDraft} mode={logoMode} setMode={setLogoMode} locked={logoLocked} setLocked={setLogoLocked} error={fieldErrors.logo} setError={(message) => setFieldErrors((current) => ({ ...current, logo: message }))} />
          <AssetEditor kind="favicon" label="Browser favicon" draft={draft} setDraft={setDraft} mode={faviconMode} setMode={setFaviconMode} locked={faviconLocked} setLocked={setFaviconLocked} error={fieldErrors.favicon} setError={(message) => setFieldErrors((current) => ({ ...current, favicon: message }))} />
        </div>

        <div className="rounded-[10px] border border-border bg-bg p-3">
          <Toggle
            checked={draft.showAuthorPromotions !== false}
            onChange={(showAuthorPromotions) => setDraft((current) => ({ ...current, showAuthorPromotions }))}
            label="Show author promotions"
            description="Show 9Remote, 9English, and the author donation prompt."
          />
        </div>

        <div className="rounded-[10px] border border-border bg-surface-2 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Preview</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {["Light", "Dark"].map((mode) => (
              <div key={mode} className={cn("flex items-center gap-3 rounded-lg border p-3", mode === "Dark" ? "border-neutral-700 bg-neutral-900 text-white" : "border-neutral-200 bg-white text-neutral-900")}>
                <div className="flex size-9 items-center justify-center overflow-hidden rounded-lg" style={{ color: normalizedColor }}>
                  <img src={payload.logoDataUrl || payload.logoUrl || DEFAULT_BRANDING_ASSET_SRC} alt="Brand preview" className="size-full object-contain" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{draft.name.trim() || DEFAULT_BRANDING.name}</p>
                  <p className="truncate text-xs opacity-60">{draft.description.trim() || DEFAULT_BRANDING.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {saveError && <p className="text-sm text-red-500">{saveError}</p>}
      </div>
    </Modal>
  );
}
