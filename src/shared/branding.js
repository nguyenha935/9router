export const DEFAULT_BRANDING = Object.freeze({
  name: "9Router",
  description: "AI Infrastructure Management",
  primaryColor: "#E56A4A",
  logoUrl: "",
  logoDataUrl: "",
  faviconUrl: "",
  faviconDataUrl: "",
  updatedAt: "",
});

export const DEFAULT_BRANDING_ASSET_SRC = "/favicon.svg";

export const BRANDING_LIMITS = Object.freeze({
  name: 100,
  description: 300,
  url: 2000,
  logoBytes: 500 * 1024,
  faviconBytes: 100 * 1024,
});

export const BRANDING_IMAGE_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

const BRANDING_KEYS = new Set(Object.keys(DEFAULT_BRANDING));
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const DATA_URL = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i;

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUrl(value) {
  const url = normalizeText(value);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : "";
  } catch {
    return "";
  }
}

export function normalizeBranding(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const name = normalizeText(source.name) || DEFAULT_BRANDING.name;
  const description = typeof source.description === "string"
    ? source.description.trim()
    : DEFAULT_BRANDING.description;
  const primaryColor = typeof source.primaryColor === "string" && HEX_COLOR.test(source.primaryColor)
    ? source.primaryColor.toUpperCase()
    : DEFAULT_BRANDING.primaryColor;
  const logoDataUrl = typeof source.logoDataUrl === "string" ? source.logoDataUrl.trim() : "";
  const faviconDataUrl = typeof source.faviconDataUrl === "string" ? source.faviconDataUrl.trim() : "";

  return {
    name,
    description,
    primaryColor,
    // A non-empty upload is the active source; never expose both sources at once,
    // including when an older DB row was written by a client that sent both.
    logoUrl: logoDataUrl ? "" : normalizeUrl(source.logoUrl),
    logoDataUrl,
    faviconUrl: faviconDataUrl ? "" : normalizeUrl(source.faviconUrl),
    faviconDataUrl,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : "",
  };
}

export function parseBrandingDataUrl(value) {
  if (typeof value !== "string") return null;
  const match = value.match(DATA_URL);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  if (!BRANDING_IMAGE_TYPES.includes(mimeType)) return null;
  const base64 = match[2].replace(/\s/g, "");
  if (!base64 || base64.length % 4 !== 0 || !/^[a-z0-9+/]*={0,2}$/i.test(base64)) return null;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  try {
    const binary = atob(base64);
    if (binary.length !== bytes || !matchesImageSignature(binary, mimeType)) return null;
  } catch {
    return null;
  }
  return { mimeType, base64, bytes };
}

function matchesImageSignature(binary, mimeType) {
  const startsWith = (...bytes) => bytes.every((byte, index) => binary.charCodeAt(index) === byte);
  if (mimeType === "image/png") return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mimeType === "image/jpeg") return startsWith(0xff, 0xd8, 0xff);
  if (mimeType === "image/gif") return binary.startsWith("GIF87a") || binary.startsWith("GIF89a");
  if (mimeType === "image/webp") return binary.startsWith("RIFF") && binary.slice(8, 12) === "WEBP";
  if (mimeType === "image/svg+xml") {
    const text = binary.replace(/^\uFEFF/, "").trimStart();
    return /^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text);
  }
  return false;
}

function validateDataUrl(value, kind) {
  if (!value) return null;
  const parsed = parseBrandingDataUrl(value);
  if (!parsed) return `${kind}DataUrl must be a supported base64 image`;
  const max = kind === "logo" ? BRANDING_LIMITS.logoBytes : BRANDING_LIMITS.faviconBytes;
  if (parsed.bytes > max) return `${kind} image exceeds ${Math.round(max / 1024)} KB`;
  return null;
}

function validateUrl(value, field) {
  if (!value) return null;
  if (typeof value !== "string" || value.length > BRANDING_LIMITS.url) {
    return `${field} must be a URL no longer than ${BRANDING_LIMITS.url} characters`;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    return `${field} must use http or https`;
  }
  return null;
}

export function validateBrandingPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return "branding must be an object";
  }
  for (const key of Object.keys(patch)) {
    if (!BRANDING_KEYS.has(key) || key === "updatedAt") return `branding.${key} is not allowed`;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "name")) {
    if (typeof patch.name !== "string" || !patch.name.trim() || patch.name.trim().length > BRANDING_LIMITS.name) {
      return `branding.name must be 1-${BRANDING_LIMITS.name} characters`;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "description")) {
    if (typeof patch.description !== "string" || patch.description.trim().length > BRANDING_LIMITS.description) {
      return `branding.description must be at most ${BRANDING_LIMITS.description} characters`;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "primaryColor") &&
      (typeof patch.primaryColor !== "string" || !HEX_COLOR.test(patch.primaryColor))) {
    return "branding.primaryColor must be a #RRGGBB color";
  }
  for (const field of ["logoUrl", "faviconUrl"]) {
    const error = validateUrl(patch[field], `branding.${field}`);
    if (error) return error;
  }
  for (const kind of ["logo", "favicon"]) {
    const error = validateDataUrl(patch[`${kind}DataUrl`], kind);
    if (error) return error;
    if (patch[`${kind}Url`] && patch[`${kind}DataUrl`]) {
      return `branding.${kind} must use either URL or upload, not both`;
    }
  }
  return null;
}

export function mergeBranding(current, patch, now = new Date().toISOString()) {
  const base = normalizeBranding(current);
  const next = { ...base, ...patch, updatedAt: now };
  for (const kind of ["logo", "favicon"]) {
    const urlField = `${kind}Url`;
    const dataField = `${kind}DataUrl`;
    // Partial updates are request-safe: selecting one non-empty source clears
    // the other even when the caller did not send that counterpart field.
    if (Object.prototype.hasOwnProperty.call(patch, dataField) && next[dataField]) {
      next[urlField] = "";
    } else if (Object.prototype.hasOwnProperty.call(patch, urlField) && next[urlField]) {
      next[dataField] = "";
    }
  }
  const merged = normalizeBranding(next);
  merged.updatedAt = now;
  return merged;
}

export function publicBranding(value) {
  const branding = normalizeBranding(value);
  const revision = encodeURIComponent(branding.updatedAt || "default");
  return {
    name: branding.name,
    description: branding.description,
    primaryColor: branding.primaryColor,
    logoSrc: `/api/branding/asset?kind=logo&v=${revision}`,
    faviconSrc: `/api/branding/asset?kind=favicon&v=${revision}`,
    revision: branding.updatedAt || "default",
  };
}

function mixChannel(channel, target, amount) {
  return Math.round(channel + (target - channel) * amount);
}

function toHex(value) {
  return value.toString(16).padStart(2, "0");
}

function mixHex(hex, target, amount) {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  return `#${channels.map((channel) => toHex(mixChannel(channel, target, amount))).join("")}`;
}

export function buildBrandPalette(value) {
  const hex = typeof value === "string" && HEX_COLOR.test(value)
    ? value.toUpperCase()
    : DEFAULT_BRANDING.primaryColor;
  const rgbValue = Number.parseInt(hex.slice(1), 16);
  const rgb = `${(rgbValue >> 16) & 255} ${(rgbValue >> 8) & 255} ${rgbValue & 255}`;
  return {
    50: mixHex(hex, 255, 0.92),
    100: mixHex(hex, 255, 0.82),
    200: mixHex(hex, 255, 0.65),
    300: mixHex(hex, 255, 0.45),
    400: mixHex(hex, 255, 0.22),
    500: hex,
    600: mixHex(hex, 0, 0.12),
    700: mixHex(hex, 0, 0.28),
    800: mixHex(hex, 0, 0.44),
    900: mixHex(hex, 0, 0.60),
    rgb,
  };
}
