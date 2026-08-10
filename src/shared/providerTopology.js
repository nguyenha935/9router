import { isAnthropicCompatibleProvider, isOpenAICompatibleProvider } from "@/shared/constants/providers";

export const TOPOLOGY_GEOMETRY = Object.freeze({
  providerWidth: 164,
  providerHeight: 48,
  routerWidth: 120,
  routerHeight: 44,
  minRadiusX: 320,
  minRadiusY: 200,
  providerGap: 24,
});

export const FALLBACK_COLOR_PALETTE = Object.freeze([
  "#0ea5e9", "#a855f7", "#f59e0b", "#10b981",
  "#ec4899", "#6366f1", "#14b8a6", "#f97316",
]);

export function fnv1a(value) {
  const input = String(value || "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function getFallbackProviderColor(providerId) {
  return FALLBACK_COLOR_PALETTE[fnv1a(providerId) % FALLBACK_COLOR_PALETTE.length];
}

export function getCompatibleBadge(providerId, apiType) {
  if (isAnthropicCompatibleProvider(providerId)) return "AC";
  if (isOpenAICompatibleProvider(providerId)) return apiType === "responses" ? "OR" : "OC";
  return "";
}

export function getTopologyRadii(count) {
  const minArcWidth = TOPOLOGY_GEOMETRY.providerWidth + TOPOLOGY_GEOMETRY.providerGap;
  const radiusX = Math.max(TOPOLOGY_GEOMETRY.minRadiusX, (minArcWidth * Math.max(count, 1)) / (2 * Math.PI));
  return { radiusX, radiusY: Math.max(TOPOLOGY_GEOMETRY.minRadiusY, radiusX * 0.55) };
}

export function getTopologyPosition(index, count) {
  const { radiusX, radiusY } = getTopologyRadii(count);
  const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(count, 1);
  return {
    x: radiusX * Math.cos(angle),
    y: radiusY * Math.sin(angle),
    angle,
  };
}
