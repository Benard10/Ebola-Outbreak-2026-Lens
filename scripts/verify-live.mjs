import { readFile } from "node:fs/promises";

const appConfig = await readFile("app-config.js", "utf8");
const manifest = JSON.parse(await readFile("data/gis/world/manifest.json", "utf8"));
const api = appConfig.match(/apiBase\s*:\s*"([^"]+)"/)?.[1];
if (!api) throw new Error("Could not find apiBase in app-config.js");

async function readJson(url, label, attempts = 1) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const separator = url.includes("?") ? "&" : "?";
      const requestUrl = attempts > 1 ? `${url}${separator}_check=${Date.now()}-${attempt}` : url;
      const response = await fetch(requestUrl, { redirect: "follow", signal: AbortSignal.timeout(60000) });
      const text = await response.text();
      if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}: ${text.slice(0, 160)}`);
      try { return JSON.parse(text); }
      catch { throw new Error(`${label} returned non-JSON content: ${text.slice(0, 120)}`); }
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

const normalize = value => String(value || "")
  .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, " ").trim();
const countryIndex = new Map();
for (const [iso3, country] of Object.entries(manifest.countries)) {
  [iso3, country.name, ...(country.aliases || [])].forEach(name => countryIndex.set(normalize(name), iso3));
}
countryIndex.set("democratic republic of congo", "COD");
countryIndex.set("the democratic republic of the congo", "COD");
countryIndex.set("drc", "COD");

const ping = await readJson(`${api}?action=ping`, "ping", 3);
const data = await readJson(`${api}?action=getData`, "getData", 3);
const nationalStats = data.map?.nationalStats || [];
const affected = nationalStats
  .filter(row => Number(row.caseTotal) > 0)
  .map(row => ({
    country: row.country || row.name,
    iso3: row.countryIso || countryIndex.get(normalize(row.country || row.name)) || ""
  }));

const geometryChecks = [];
for (const country of affected) {
  const metadata = manifest.countries[country.iso3]?.levels?.ADM0;
  if (!metadata) {
    geometryChecks.push({ ...country, ok: false, error: "ADM0 unavailable" });
    continue;
  }
  const geometry = await readJson(metadata.url, `${country.iso3} ADM0`);
  geometryChecks.push({ ...country, ok: Array.isArray(geometry.features) && geometry.features.length > 0, features: geometry.features?.length || 0 });
}

console.log(JSON.stringify({
  api,
  ping,
  apiVersion: data.apiVersion || "",
  totals: data.totals,
  mapPayload: {
    present: Boolean(data.map),
    nationalStats: nationalStats.length,
    adminStats: data.map?.adminStats?.length || 0,
    points: data.map?.points?.length || 0
  },
  geometryChecks
}, null, 2));
