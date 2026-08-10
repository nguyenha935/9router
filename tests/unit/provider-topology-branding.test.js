import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_COLOR_PALETTE,
  TOPOLOGY_GEOMETRY,
  fnv1a,
  getCompatibleBadge,
  getFallbackProviderColor,
  getTopologyPosition,
} from "@/shared/providerTopology";
import { getProviderDisplayIconSrc } from "@/shared/utils/providerIcon";

describe("provider topology helpers", () => {
  it("uses deterministic FNV colors and semantic compatible badges", () => {
    expect(fnv1a("openai-compatible-acme")).toBe(fnv1a("openai-compatible-acme"));
    expect(getFallbackProviderColor("openai-compatible-acme")).toBe(getFallbackProviderColor("openai-compatible-acme"));
    expect(FALLBACK_COLOR_PALETTE).toContain(getFallbackProviderColor("custom-provider"));
    expect(getCompatibleBadge("anthropic-compatible-acme", undefined)).toBe("AC");
    expect(getCompatibleBadge("openai-compatible-acme", "chat")).toBe("OC");
    expect(getCompatibleBadge("openai-compatible-acme", "responses")).toBe("OR");
  });

  it("uses the same compatible-provider icon mapping as the Providers UI", () => {
    expect(getProviderDisplayIconSrc("openai-compatible-acme", "responses")).toBe("/providers/oai-r.png");
    expect(getProviderDisplayIconSrc("openai-compatible-acme", "chat")).toBe("/providers/oai-cc.png");
    expect(getProviderDisplayIconSrc("anthropic-compatible-acme")).toBe("/providers/anthropic-m.png");
  });

  it("keeps geometry shared by node dimensions and ellipse coordinates", () => {
    const point = getTopologyPosition(0, 4);
    expect(TOPOLOGY_GEOMETRY.providerWidth).toBe(164);
    expect(TOPOLOGY_GEOMETRY.providerHeight).toBe(48);
    expect(TOPOLOGY_GEOMETRY.routerWidth).toBe(120);
    expect(TOPOLOGY_GEOMETRY.routerHeight).toBe(44);
    expect(point.x).toBeCloseTo(0);
    expect(point.y).toBeLessThan(-TOPOLOGY_GEOMETRY.minRadiusY + 1);
  });

  it("keeps the modal, root provider and React Flow CSS regression hooks", () => {
    const read = (file) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
    expect(read("src/app/(dashboard)/dashboard/profile/page.js")).toContain("<BrandingModal");
    expect(read("src/app/layout.js")).toContain("<BrandingProvider>");
    expect(read("src/app/globals.css")).toContain(".react-flow.router-topology-flow .react-flow__handle");
    const topology = read("src/app/(dashboard)/dashboard/usage/components/ProviderTopology.js");
    expect(topology).toContain('className="router-topology-flow"');
    expect(topology).toContain("providers.forEach((p, i) =>");
    expect(topology).not.toContain("sortTopologyProviders");
    expect(read("src/shared/components/Sidebar.js")).not.toContain("bg-gradient-to-br from-brand-500 to-brand-700 p-1.5");
    expect(read("src/app/login/page.js")).not.toContain("bg-primary/10 p-2");
    const profile = read("src/app/(dashboard)/dashboard/profile/page.js");
    const brandingModal = read("src/app/(dashboard)/dashboard/profile/BrandingModal.js");
    expect(profile).toContain(">Preferences</h3>");
    expect(brandingModal).toContain("DEFAULT_BRANDING_ASSET_SRC");
    expect(brandingModal).toContain("disabled={locked}");
    expect(brandingModal).toContain("Remove custom {kind}");
  });
});
