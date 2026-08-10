import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { publicBranding } from "@/shared/branding";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json(publicBranding(settings.branding), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(publicBranding(null), {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
