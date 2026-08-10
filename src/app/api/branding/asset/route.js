import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { DEFAULT_BRANDING_ASSET_SRC, normalizeBranding, parseBrandingDataUrl } from "@/shared/branding";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(request) {
  const kind = new URL(request.url).searchParams.get("kind");
  if (kind !== "logo" && kind !== "favicon") {
    return NextResponse.json({ error: "kind must be logo or favicon" }, { status: 400 });
  }

  try {
    const settings = await getSettings();
    const branding = normalizeBranding(settings.branding);
    const parsed = parseBrandingDataUrl(branding[`${kind}DataUrl`]);
    if (parsed) {
      return new NextResponse(Buffer.from(parsed.base64, "base64"), {
        headers: { ...HEADERS, "Content-Type": parsed.mimeType },
      });
    }
    const remoteUrl = branding[`${kind}Url`];
    if (remoteUrl) return NextResponse.redirect(remoteUrl, { headers: HEADERS });
  } catch {}

  // Keep the default asset on the caller's origin. request.url is the internal
  // localhost URL behind a reverse proxy, so constructing an absolute URL from
  // it would redirect remote browsers to their own localhost.
  return new NextResponse(null, {
    status: 307,
    headers: { ...HEADERS, Location: DEFAULT_BRANDING_ASSET_SRC },
  });
}
