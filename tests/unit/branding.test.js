import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRANDING_LIMITS,
  DEFAULT_BRANDING,
  DEFAULT_BRANDING_ASSET_SRC,
  buildBrandPalette,
  mergeBranding,
  normalizeBranding,
  parseBrandingDataUrl,
  publicBranding,
  validateBrandingPatch,
} from "@/shared/branding";

function imageDataUrl(mimeType, bytes) {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => mocks);

describe("branding helpers", () => {
  it("deep merges defaults and preserves existing asset fields", () => {
    const next = mergeBranding({ name: "Custom", logoUrl: "https://example.com/logo.png" }, { description: "Tagline" }, "rev-1");
    expect(next).toMatchObject({
      name: "Custom",
      description: "Tagline",
      logoUrl: "https://example.com/logo.png",
      primaryColor: DEFAULT_BRANDING.primaryColor,
      showAuthorPromotions: true,
      updatedAt: "rev-1",
    });
  });

  it("validates name, color, URL, source exclusivity and data-url bytes", () => {
    expect(validateBrandingPatch({ name: " ", primaryColor: "red" })).toMatch(/name/);
    expect(validateBrandingPatch({ showAuthorPromotions: "no" })).toMatch(/boolean/);
    expect(validateBrandingPatch({ name: "App", logoUrl: "javascript:alert(1)" })).toMatch(/logoUrl/);
    expect(validateBrandingPatch({ name: "App", logoUrl: "https://a", logoDataUrl: "data:image/png;base64,AAAA" })).toMatch(/logo/);
    const validSvg = `data:image/svg+xml;base64,${Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").toString("base64")}`;
    expect(parseBrandingDataUrl(validSvg)?.mimeType).toBe("image/svg+xml");
    expect(parseBrandingDataUrl("data:image/png;base64,AAAA")).toBeNull();
  });

  it("checks supported MIME signatures and decoded upload limits", () => {
    const samples = [
      ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff])],
      ["image/webp", Buffer.from("RIFF0000WEBP")],
      ["image/gif", Buffer.from("GIF89a")],
      ["image/svg+xml", Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")],
    ];
    for (const [mimeType, bytes] of samples) {
      expect(parseBrandingDataUrl(imageDataUrl(mimeType, bytes))?.mimeType).toBe(mimeType);
    }
    expect(parseBrandingDataUrl(imageDataUrl("image/png", Buffer.from("GIF89a")))).toBeNull();
    expect(parseBrandingDataUrl(imageDataUrl("image/bmp", Buffer.from("BM")))).toBeNull();

    const oversizedLogo = imageDataUrl("image/png", Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(BRANDING_LIMITS.logoBytes),
    ]));
    const oversizedFavicon = imageDataUrl("image/gif", Buffer.concat([
      Buffer.from("GIF89a"),
      Buffer.alloc(BRANDING_LIMITS.faviconBytes),
    ]));
    expect(validateBrandingPatch({ logoDataUrl: oversizedLogo })).toMatch(/500 KB/);
    expect(validateBrandingPatch({ faviconDataUrl: oversizedFavicon })).toMatch(/100 KB/);
  });

  it("keeps only one asset source when a partial update selects URL or upload", () => {
    const current = {
      ...DEFAULT_BRANDING,
      logoDataUrl: "data:image/svg+xml;base64,upload",
      faviconUrl: "https://example.com/favicon.png",
    };
    const fromUrl = mergeBranding(current, { logoUrl: "https://example.com/logo.png" }, "rev-url");
    expect(fromUrl.logoUrl).toBe("https://example.com/logo.png");
    expect(fromUrl.logoDataUrl).toBe("");

    const fromUpload = mergeBranding(current, { faviconDataUrl: "data:image/svg+xml;base64,upload" }, "rev-upload");
    expect(fromUpload.faviconDataUrl).toBe("data:image/svg+xml;base64,upload");
    expect(fromUpload.faviconUrl).toBe("");

    const normalized = normalizeBranding({ ...current, logoUrl: "https://example.com/old.png" });
    expect(normalized.logoUrl).toBe("");

    const promotionsHidden = mergeBranding(current, { showAuthorPromotions: false }, "rev-hidden");
    expect(promotionsHidden.showAuthorPromotions).toBe(false);
    expect(normalizeBranding({}).showAuthorPromotions).toBe(true);
  });

  it("builds a complete palette and only exposes public branding", () => {
    const palette = buildBrandPalette("#123456");
    expect(Object.keys(palette)).toEqual(expect.arrayContaining(["50", "500", "900", "rgb"]));
    expect(publicBranding({ ...DEFAULT_BRANDING, name: "Acme", password: "secret" })).toEqual({
      name: "Acme",
      description: DEFAULT_BRANDING.description,
      primaryColor: DEFAULT_BRANDING.primaryColor,
      showAuthorPromotions: true,
      logoSrc: expect.stringContaining("/api/branding/asset?kind=logo"),
      faviconSrc: expect.stringContaining("/api/branding/asset?kind=favicon"),
      revision: "default",
    });
  });
});

describe("public branding route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({
      branding: { name: "Acme", description: "Private", primaryColor: "#123456" },
      password: "must-not-leak",
    });
  });

  it("returns only resolved branding fields", async () => {
    const { GET } = await import("@/app/api/branding/route.js");
    const response = await GET();
    const body = await response.json();
    expect(body).toEqual({
      name: "Acme",
      description: "Private",
      primaryColor: "#123456",
      showAuthorPromotions: true,
      logoSrc: expect.any(String),
      faviconSrc: expect.any(String),
      revision: "default",
    });
    expect(body.password).toBeUndefined();
  });

  it("resolves uploaded, remote and default assets without caching", async () => {
    const { GET } = await import("@/app/api/branding/asset/route.js");
    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").toString("base64")}`;
    mocks.getSettings.mockResolvedValueOnce({ branding: { logoDataUrl: svg } });
    const upload = await GET(new Request("http://localhost/api/branding/asset?kind=logo"));
    expect(upload.headers.get("content-type")).toBe("image/svg+xml");
    expect(upload.headers.get("cache-control")).toBe("no-store");

    mocks.getSettings.mockResolvedValueOnce({ branding: { faviconUrl: "https://example.com/icon.png" } });
    const remote = await GET(new Request("http://localhost/api/branding/asset?kind=favicon"));
    expect(remote.status).toBe(307);
    expect(remote.headers.get("location")).toBe("https://example.com/icon.png");

    mocks.getSettings.mockResolvedValueOnce({ branding: {} });
    const fallback = await GET(new Request("http://localhost/api/branding/asset?kind=logo"));
    expect(DEFAULT_BRANDING_ASSET_SRC).toBe("/favicon.svg");
    expect(fallback.headers.get("location")).toBe(DEFAULT_BRANDING_ASSET_SRC);
  });
});

describe("branding settings PATCH", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateSettings.mockImplementation(async (value) => ({
      ...value,
      branding: { ...DEFAULT_BRANDING, ...value.branding, updatedAt: "server-revision" },
    }));
  });

  it("sends one partial object to the atomic repository update", async () => {
    const { PATCH } = await import("@/app/api/settings/route.js");
    const response = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branding: { description: "New tagline" } }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledOnce();
    expect(mocks.updateSettings).toHaveBeenCalledWith({ branding: { description: "New tagline" } });
  });

  it("persists the author-promotion visibility as a branding boolean", async () => {
    const { PATCH } = await import("@/app/api/settings/route.js");
    const response = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branding: { showAuthorPromotions: false } }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ branding: { showAuthorPromotions: false } });
    expect(body.branding.showAuthorPromotions).toBe(false);
  });

  it("rejects a client-supplied updatedAt", async () => {
    const { PATCH } = await import("@/app/api/settings/route.js");
    const response = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branding: { updatedAt: "client-value" } }),
    }));
    expect(response.status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});
