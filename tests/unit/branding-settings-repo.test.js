import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-branding-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("settings repository branding merge", () => {
  it("merges partial branding inside the settings transaction", async () => {
    const { getSettings, updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ branding: { name: "Acme", description: "Original" } });
    await updateSettings({ branding: { primaryColor: "#123456" } });
    const settings = await getSettings();
    expect(settings.branding).toMatchObject({
      name: "Acme",
      description: "Original",
      primaryColor: "#123456",
    });
    expect(settings.branding.updatedAt).not.toBe("");
  });
});
