import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const outputRoot = path.join(root, "data", "gis", "world");
const release = "gbOpen";
const levels = [0, 1, 2, 3, 4];

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "EbolaSurveillanceDashboard/2.0" },
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function compactMetadata(metadata, apiUrl) {
  const sourceUrl = metadata.simplifiedGeometryGeoJSON || metadata.gjDownloadURL;
  return {
    url: sourceUrl.replace(
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/,
      "https://media.githubusercontent.com/media/$1/$2/$3/$4"
    ),
    apiUrl,
    featureCount: Number(metadata.admUnitCount) || 0,
    boundaryYear: metadata.boundaryYearRepresented || "",
    license: metadata.boundaryLicense || "",
    source: metadata.boundarySource || "",
    sourceUrl: metadata.boundarySourceURL || ""
  };
}

await mkdir(outputRoot, { recursive: true });
const manifest = {
  generatedAt: new Date().toISOString(),
  provider: "geoBoundaries",
  release,
  strategy: "global-catalog-active-country-on-demand",
  api: "https://www.geoboundaries.org/api/current/",
  attribution: "geoBoundaries (CC BY 4.0 and source-specific open licenses)",
  countries: {}
};

for (const level of levels) {
  const apiUrl = `https://www.geoboundaries.org/api/current/${release}/ALL/ADM${level}/`;
  const response = await fetchJson(apiUrl);
  const records = Array.isArray(response) ? response : [response];

  for (const metadata of records) {
    const iso3 = String(metadata.boundaryISO || "").toUpperCase();
    const url = metadata.simplifiedGeometryGeoJSON || metadata.gjDownloadURL;
    if (!/^[A-Z]{3}$/.test(iso3) || !url) continue;
    if (!manifest.countries[iso3]) {
      manifest.countries[iso3] = {
        name: metadata.boundaryName || iso3,
        aliases: [metadata.boundaryName, metadata.boundaryCanonical].filter(Boolean),
        levels: {}
      };
    }
    manifest.countries[iso3].levels[`ADM${level}`] = compactMetadata(metadata, apiUrl);
  }

  console.log(`ADM${level}: ${records.length} country records indexed`);
}

const orderedCountries = Object.fromEntries(
  Object.entries(manifest.countries).sort(([a], [b]) => a.localeCompare(b))
);
manifest.countries = orderedCountries;
manifest.countryCount = Object.keys(orderedCountries).length;
manifest.levelCounts = Object.fromEntries(levels.map(level => [
  `ADM${level}`,
  Object.values(orderedCountries).filter(country => country.levels[`ADM${level}`]).length
]));

await writeFile(
  path.join(outputRoot, "manifest.json"),
  JSON.stringify(manifest, null, 2)
);

console.log(JSON.stringify({
  output: "data/gis/world/manifest.json",
  countries: manifest.countryCount,
  levels: manifest.levelCounts
}, null, 2));
