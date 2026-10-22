
  const APP_CONFIG = window.EBOLA_APP_CONFIG || {};
  const API_BASE = APP_CONFIG.apiBase || "";
  let map = null;
  let mapReadyPromise = null;
  let adminBoundaryCache = {};
  let boundaryManifest = null;
  let countryNameIndex = new Map();
  let currentDashboardData = null;
  let boundaryRequestId = 0;
  let renderedAdminLevel = -1;
  let renderedCountryCodes = new Set();
  let pendingCountryBoundaries = new Map();
  let mapExtentBounds = null;
  let chartInstances = {};
  let mapMode = "choropleth";
  let hasInitialFit = false;
  let mapGeographyKey = null;
  let lastCheckedAt = null;
  let dataLoadInProgress = false;
  let pendingForceRefresh = false;
  let mapRenderInProgress = false;
  let pendingMapData = null;
  let autoRefreshEnabled = true;
  let autoRefreshTimer = null;
  let AUTO_REFRESH_MS = Number(APP_CONFIG.autoRefreshMs) || 30000;
  const HISTORY_REFRESH_MS = Number(APP_CONFIG.historyRefreshMs) || 300000;
  const DASHBOARD_STORAGE_KEY = APP_CONFIG.dashboardStorageKey || "ebola-dashboard-last-data-v2";
  const REFRESH_SIGNAL_KEY = APP_CONFIG.refreshSignalKey || "ebola-dashboard-refresh-request";
  let runtimeSources = {
    ...(APP_CONFIG.sources || {}),
    dailyHistory: { ...(APP_CONFIG.sources?.dailyHistory || {}) },
    subnational: { ...(APP_CONFIG.sources?.subnational || {}) }
  };
  let cachedDashboardMeta = null;
  let dailyHistoryPromise = null;
  let dailyHistoryLoadedAt = 0;
  let subnationalPromise = null;
  let subnationalLoadedAt = 0;

  const colors = { teal: '#54b7a6', red: '#e4605e', yellow: '#e9c46a', blue: '#4a90e2', grid: '#364146', text: '#8493a5' };
  const mapColors = { high: '#ef4444', moderate: '#f59e0b', low: '#38bdf8', none: '#4b5563' };
  const MAP_THRESHOLDS = APP_CONFIG.mapThresholds || {
    total: { moderate: 15, high: 50 }, confirmed: { moderate: 15, high: 50 },
    deaths: { moderate: 5, high: 15 }, recovered: { moderate: 10, high: 30 }
  };
  const MAP_METRICS = {
    total: { field: 'caseTotal', label: 'Total cases' },
    confirmed: { field: 'confirmed', label: 'Confirmed cases' },
    deaths: { field: 'deaths', label: 'Deaths' },
    recovered: { field: 'recovered', label: 'Recovered' }
  };

  if (window.Chart) {
    Chart.defaults.color = colors.text;
    Chart.defaults.font.family = "'IBM Plex Sans', sans-serif";
    Chart.Tooltip.positioners.growthLine = function(items, eventPosition) {
      const lineAnchor = items.find(item => item.datasetIndex === 1 && item.element);
      return lineAnchor
        ? { x: lineAnchor.element.x, y: lineAnchor.element.y }
        : eventPosition;
    };
  }

  function getRiskColor(val) {
    const metric = document.getElementById("mapMetric")?.value || "total";
    const thresholds = MAP_THRESHOLDS[metric] || MAP_THRESHOLDS.total;
    if (val <= 0) return mapColors.none;
    if (val >= thresholds.high) return mapColors.high;
    if (val >= thresholds.moderate) return mapColors.moderate;
    return mapColors.low;
  }

  function activeMapMetric() {
    const key = document.getElementById("mapMetric")?.value || "total";
    return { key, ...(MAP_METRICS[key] || MAP_METRICS.total), thresholds: MAP_THRESHOLDS[key] || MAP_THRESHOLDS.total };
  }

  function mapMetricValue(item, metric = activeMapMetric()) {
    return metric.field === "caseTotal" ? reportedCases(item) : getStat(item || {}, metric.field);
  }

  function metricRadiusExpression(metric = activeMapMetric()) {
    return ["interpolate", ["linear"], ["to-number", ["get", metric.field], 0],
      0, 10, metric.thresholds.moderate, 18, metric.thresholds.high, 28
    ];
  }

  function updateMapLegend() {
    const metric = activeMapMetric();
    const lowMax = Math.max(1, metric.thresholds.moderate - 1);
    document.getElementById("mapLegendTitle").textContent = `${metric.label} intensity`;
    document.getElementById("legendHigh").textContent = `High (${metric.thresholds.high}+)`;
    document.getElementById("legendModerate").textContent = `Moderate (${metric.thresholds.moderate}–${metric.thresholds.high - 1})`;
    document.getElementById("legendLow").textContent = `Lower (1–${lowMax})`;
  }

  function normalizeBoundaryName(name) {
    return String(name || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function normalizeCountryName(name) {
    const value = normalizeBoundaryName(name);
    if (
      value === "drc" ||
      value === "dr congo" ||
      value === "congo drc" ||
      value === "d r congo" ||
      value === "congo democratic republic" ||
      value === "democratic republic of the congo" ||
      value === "democraticrepublicofthecongo"
    ) {
      return "democratic republic of the congo";
    }
    if (value === "southsudan") return "south sudan";
    if (value === "republicofthecongo") return "republic of the congo";
    return value;
  }

  function buildCountryNameIndex(manifest) {
    countryNameIndex = new Map();
    Object.entries(manifest.countries || {}).forEach(([iso3, country]) => {
      [iso3, country.name, ...(country.aliases || [])].forEach(name => {
        const key = normalizeCountryName(name);
        if (key) countryNameIndex.set(key, iso3);
      });
    });
    const aliases = {
      "drc": "COD", "dr congo": "COD", "congo kinshasa": "COD",
      "democratic republic of congo": "COD", "the democratic republic of the congo": "COD",
      "republic of congo": "COG", "congo brazzaville": "COG",
      "cote d ivoire": "CIV", "ivory coast": "CIV",
      "tanzania united republic of": "TZA", "united republic of tanzania": "TZA",
      "bolivia plurinational state of": "BOL", "venezuela bolivarian republic of": "VEN",
      "iran islamic republic of": "IRN", "lao people s democratic republic": "LAO",
      "syrian arab republic": "SYR", "viet nam": "VNM", "south korea": "KOR",
      "north korea": "PRK", "russia": "RUS", "moldova": "MDA",
      "brunei": "BRN", "cape verde": "CPV", "eswatini": "SWZ"
    };
    Object.entries(aliases).forEach(([name, iso3]) => countryNameIndex.set(name, iso3));
  }

  function resolveCountryIso(value) {
    const direct = String(value || "").toUpperCase();
    if (/^[A-Z]{3}$/.test(direct) && boundaryManifest?.countries?.[direct]) return direct;
    return countryNameIndex.get(normalizeCountryName(value)) || "";
  }

  function isValidCoordinate(lat, lon) {
    if (Number.isNaN(lat) || Number.isNaN(lon)) return false;
    if (lat === 0 && lon === 0) return false;
    return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  }

  class FullExtentControl {
    onAdd(targetMap) {
      this.map = targetMap;
      this.container = document.createElement("div");
      this.container.className = "maplibregl-ctrl maplibregl-ctrl-group";
      const button = document.createElement("button");
      button.type = "button";
      button.title = "Zoom to full outbreak extent";
      button.setAttribute("aria-label", button.title);
      button.innerHTML = '<span aria-hidden="true" style="font:700 17px/1 sans-serif;color:#fff">⌗</span>';
      button.addEventListener("click", () => fitOutbreakExtent());
      this.container.appendChild(button);
      return this.container;
    }
    onRemove() {
      this.container.remove();
      this.map = null;
    }
  }

  function fitOutbreakExtent(duration = 700) {
    if (map && mapExtentBounds && !mapExtentBounds.isEmpty()) {
      const panel = document.getElementById('map');
      const legend = document.querySelector('.map-legend');
      const width = panel.clientWidth, height = panel.clientHeight;
      if (!width || !height) return;
      const padding = {
        top: Math.min(20, height * .15),
        bottom: Math.min((legend?.offsetHeight || 0) + 16, height * .3),
        left: Math.min(30, width * .1), right: Math.min(48, width * .15)
      };
      map.fitBounds(mapExtentBounds, { padding, maxZoom: 7,
        bearing: 0, pitch: 0,
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration });
    }
  }

  async function ensureMap() {
    if (!window.maplibregl) return false;
    if (mapReadyPromise) return mapReadyPromise;
    try {
      map = new maplibregl.Map({
        container: "map",
        center: [25.0, 0.0],
        zoom: 4,
        attributionControl: false,
        style: runtimeSources.mapStyle
      });
      window.__mapErrors = [];
      map.on('style.load', () => window.applyMapPresentation?.(true));
      map.on("error", event => {
        const message = String(event?.error?.message || event?.error || event || "Unknown MapLibre error");
        window.__mapErrors.push(message);
        console.error("MapLibre error:", message);
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(new maplibregl.FullscreenControl({ container: document.querySelector(".map-panel") }), "top-right");
      map.addControl(new FullExtentControl(), "top-right");
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
      // Breakpoint, orientation and fullscreen changes can resize the panel
      // independently of the window. Keep the WebGL canvas in sync.
      if (window.ResizeObserver) {
        const mapResizeObserver = new ResizeObserver(() => map.resize());
        mapResizeObserver.observe(document.getElementById("map"));
        map.once("remove", () => mapResizeObserver.disconnect());
      }
      mapReadyPromise = new Promise(resolve => {
        map.once("load", () => {
          map.on("zoomend", () => {
            const selector = document.getElementById("adminLevel");
            if (selector && selector.value === "auto" && currentDashboardData) renderAdminDetailLayer(currentDashboardData);
          });
          resolve(true);
        });
      });
      return mapReadyPromise;
    } catch (err) {
      console.error("Map initialization failed:", err);
      return false;
    }
  }

  function getStat(item, field) {
    const mappings = { confirmed: ['confirmed', 'conf'], suspected: ['suspected', 'susp'], deaths: ['deaths'], recovered: ['recovered'] };
    if (mappings[field]) {
      for (let alias of mappings[field]) {
        if (item[alias] !== undefined) return Number(item[alias]) || 0;
      }
    }
    return Number(item[field]) || 0;
  }

  function showInfoPanel(item) {
    const options = document.getElementById('mapOptions');
    if (options) options.open = false;
    const panel = document.getElementById('info-panel');
    const isBoundary = item.isBoundary === true;
    document.getElementById('info-title').innerText = item.name || "Unknown Zone";
    document.getElementById('info-province').innerText = item.province || item.country_name || item.Province || item.COUNTRY || '---';
    const confirmed = getStat(item, 'confirmed');
    const suspected = getStat(item, 'suspected');
    const deaths = getStat(item, 'deaths');
    const recovered = getStat(item, 'recovered');
    const total = Number(item.caseTotal) || (confirmed + suspected);
    document.getElementById('info-total').innerText = total.toLocaleString();
    document.getElementById('info-conf').innerText = confirmed.toLocaleString();
    document.getElementById('info-susp').innerText = suspected.toLocaleString();
    document.getElementById('info-death').innerText = deaths.toLocaleString();
    document.getElementById('info-rec').innerText = recovered.toLocaleString();
    const zonesContainer = document.getElementById('info-zones');
    const zones = Array.isArray(item.zones) ? item.zones : [];
    const infoList = document.querySelector('.info-list');
    const listTitle = document.querySelector('.info-list-title');
    if (infoList) infoList.style.display = (zones.length > 0) ? 'block' : 'none';
    if (listTitle && isBoundary) {
      listTitle.innerText = zones.length > 0 ? `HEALTH ZONES (${zones.length})` : '';
      listTitle.style.display = zones.length > 0 ? 'block' : 'none';
    }
    zonesContainer.innerHTML = zones.map(z => `
      <div class="info-zone">
        <div class="info-zone-name">${escapeHtml(z.name || "Unknown point")}</div>
        <div class="info-zone-meta">${(getStat(z, 'confirmed') + getStat(z, 'suspected')).toLocaleString()} total | ${getStat(z, 'confirmed').toLocaleString()} confirmed | ${getStat(z, 'deaths').toLocaleString()} deaths</div>
      </div>
    `).join("");
    panel.style.display = 'block';
  }

  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function riskColorExpression(fieldName) {
    const metric = activeMapMetric();
    const thresholds = metric.thresholds;
    const value = ["to-number", ["get", fieldName], 0];
    return ["case", ["<=", value, 0], mapColors.none, ["step", value, mapColors.low, thresholds.moderate, mapColors.moderate, thresholds.high, mapColors.high]];
  }

  async function fetchJsonWithRetry(url, attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(url, { redirect: "follow", cache: attempt === 1 ? "default" : "reload" });
        const body = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (/^\s*</.test(body)) throw new Error("Server returned HTML instead of JSON");
        return JSON.parse(body);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 800 * attempt));
      }
    }
    throw lastError;
  }

  function mapFeatureProperties(properties) {
    const props = { ...(properties || {}) };
    if (typeof props.zonesJson === "string") {
      try { props.zones = JSON.parse(props.zonesJson); } catch (_) { props.zones = []; }
    }
    return props;
  }

  async function loadBoundaryManifest() {
    if (boundaryManifest) return boundaryManifest;
    const response = await fetch(runtimeSources.boundaryManifest);
    if (!response.ok) throw new Error(`Boundary manifest returned ${response.status}`);
    boundaryManifest = await response.json();
    buildCountryNameIndex(boundaryManifest);
    return boundaryManifest;
  }

  function compactBoundaryCollection(sourceData, iso3, level) {
    const country = boundaryManifest?.countries?.[iso3];
    return {
      type: "FeatureCollection",
      features: (sourceData.features || []).flatMap((feature, index) => {
        const source = feature.properties || {};
        const name = String(source.shapeName || source.name || source.NAME || source.NOM || country?.name || iso3).trim();
        const boundaryId = `${iso3}-ADM${level}-${source.shapeID || source.shapeISO || index + 1}`;
        const geometries = feature.geometry?.type === "MultiPolygon"
          ? feature.geometry.coordinates.map(coordinates => ({ type: "Polygon", coordinates }))
          : [feature.geometry];
        const primaryPart = geometries.reduce((best, geometry, partIndex) => {
          const area = Math.abs(ringArea(geometry?.coordinates?.[0] || []));
          return area > best.area ? { area, partIndex } : best;
        }, { area: -1, partIndex: 0 }).partIndex;
        return geometries.filter(Boolean).map((geometry, partIndex) => ({
          type: "Feature",
          properties: {
            boundary_id: `${boundaryId}-${partIndex + 1}`,
            boundary_name: name,
            boundary_key: normalizeBoundaryName(name),
            country_iso: iso3,
            country_name: country?.name || iso3,
            admin_level: level,
            label_primary: partIndex === primaryPart
          },
          geometry
        }));
      })
    };
  }

  async function fetchAdminBoundary(iso3, level) {
    const key = `${iso3}|${level}`;
    if (adminBoundaryCache[key]) return adminBoundaryCache[key];
    const manifest = await loadBoundaryManifest();
    const metadata = manifest.countries?.[iso3]?.levels?.[`ADM${level}`];
    if (!metadata) return null;
    const sourceUrl = metadata.path ? `${metadata.path}?v=20261007` : String(metadata.url || "").replace(
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/,
      "https://media.githubusercontent.com/media/$1/$2/$3/$4"
    );
    if (!sourceUrl) return null;
    const response = await fetch(sourceUrl);
    if (!response.ok) return null;
    const body = await response.text();
    if (/^\s*</.test(body) || /^version https:\/\/git-lfs\.github\.com\/spec\//.test(body)) {
      throw new Error(`Boundary source for ${iso3} ADM${level} did not return GeoJSON`);
    }
    const geojson = compactBoundaryCollection(JSON.parse(body), iso3, level);
    adminBoundaryCache[key] = geojson;
    return geojson;
  }

  function hydrateCountryCodes(data) {
    if (!data.map) {
      data.map = { points: data.zones || [], nationalStats: [], adminStats: [], snapshotDate: data.totals?.sourceDate || "" };
    }
    [data.map.nationalStats, data.map.adminStats, data.map.points, data.zones, data.boundaryStats]
      .filter(Array.isArray)
      .forEach(records => records.forEach(item => {
        if (!item.countryIso) item.countryIso = resolveCountryIso(item.country || item.country_name || item.Country);
      }));
  }

  function reportedCases(item) {
    return Number(item?.caseTotal) || getStat(item || {}, "confirmed") + getStat(item || {}, "suspected") + Number(item?.probable || 0);
  }

  function getActiveCountryCodes(data) {
    const records = [
      ...(data.map?.nationalStats || []),
      ...(data.map?.points || []),
      ...(data.zones || []),
      ...(data.boundaryStats || [])
    ];
    return Array.from(new Set(records
      .filter(item => reportedCases(item) > 0)
      .map(item => item.countryIso || resolveCountryIso(item.country || item.country_name))
      .filter(Boolean)));
  }

  function selectedAdminLevel() {
    const value = document.getElementById("adminLevel")?.value || "auto";
    if (value !== "auto") return Number(value);
    const zoom = map ? map.getZoom() : 4;
    if (zoom < 4.5) return 0;
    if (zoom < 6.5) return 1;
    if (zoom < 8.5) return 2;
    if (zoom < 10.5) return 3;
    return 4;
  }

  function availableLevelForCountry(iso3, requestedLevel) {
    const levels = boundaryManifest?.countries?.[iso3]?.levels || {};
    for (let level = requestedLevel; level >= 0; level--) {
      if (levels[`ADM${level}`]) return level;
    }
    return null;
  }

  async function loadCombinedBoundaries(countryCodes, requestedLevel) {
    const collections = await Promise.all(countryCodes.map(async iso3 => {
      const level = availableLevelForCountry(iso3, requestedLevel);
      return level === null ? null : fetchAdminBoundary(iso3, level);
    }));
    return {
      type: "FeatureCollection",
      features: collections.flatMap(collection => collection?.features || [])
    };
  }

  function enrichBoundaries(geojson, data, level) {
    const national = new Map((data.map?.nationalStats || []).map(item => [item.countryIso, item]));
    const admin = new Map((data.map?.adminStats || []).map(item => [`${item.countryIso}|${item.normalizedName}`, item]));
    return {
      type: "FeatureCollection",
      features: (geojson.features || []).map(feature => {
        const properties = feature.properties || {};
        const stat = level === 0
          ? national.get(properties.country_iso)
          : admin.get(`${properties.country_iso}|${properties.boundary_key}`);
        return {
          ...feature,
          properties: {
            ...properties,
            name: properties.boundary_name,
            confirmed: Number(stat?.confirmed) || 0,
            suspected: Number(stat?.suspected) || 0,
            deaths: Number(stat?.deaths) || 0,
            recovered: Number(stat?.recovered) || 0,
            caseTotal: Number(stat?.caseTotal) || 0,
            status: stat ? (stat.status || "ACTIVE") : "NO GRANULAR DATA",
            lastUpdated: stat?.lastUpdated || data.map?.snapshotDate || "",
            isBoundary: true
          }
        };
      })
    };
  }

  function caseloadColorExpression(maxValue) {
    const max = Math.max(1, Number(maxValue) || 1);
    return ["interpolate", ["linear"], ["to-number", ["get", "caseTotal"], 0],
      0, "#1e2326", Math.max(1, max * 0.03), mapColors.low, Math.max(2, max * 0.3), mapColors.moderate, max, mapColors.high
    ];
  }

  function geojsonMax(geojson) {
    return Math.max(1, ...(geojson.features || []).map(feature => Number(feature.properties?.caseTotal) || 0));
  }

  function extendMapExtent(geojson) {
    if (!mapExtentBounds) mapExtentBounds = new maplibregl.LngLatBounds();
    const collect = value => {
      if (!Array.isArray(value)) return;
      if (typeof value[0] === "number" && typeof value[1] === "number") mapExtentBounds.extend(value);
      else value.forEach(collect);
    };
    (geojson.features || []).forEach(feature => collect(feature.geometry?.coordinates));
  }

  function ringArea(ring) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      area += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
    }
    return area / 2;
  }

  function pointInRing(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      const crosses = ((yi > point[1]) !== (yj > point[1])) &&
        (point[0] < (xj - xi) * (point[1] - yi) / ((yj - yi) || Number.EPSILON) + xi);
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function interiorPoint(feature) {
    const geometry = feature?.geometry;
    if (!geometry) return null;
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    const outerRings = (polygons || []).map(polygon => polygon?.[0]).filter(ring => ring?.length > 3);
    const ring = outerRings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)))[0];
    if (!ring) return null;

    let twiceArea = 0, x = 0, y = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      twiceArea += cross;
      x += (ring[j][0] + ring[i][0]) * cross;
      y += (ring[j][1] + ring[i][1]) * cross;
    }
    const centroid = Math.abs(twiceArea) > 1e-12 ? [x / (3 * twiceArea), y / (3 * twiceArea)] : ring[0];
    if (pointInRing(centroid, ring)) return centroid;

    const xs = ring.map(point => point[0]), ys = ring.map(point => point[1]);
    const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    for (let grid = 5; grid <= 25; grid += 5) {
      for (let row = 0; row < grid; row++) for (let column = 0; column < grid; column++) {
        const candidate = [
          bounds[0] + (column + 0.5) * (bounds[2] - bounds[0]) / grid,
          bounds[1] + (row + 0.5) * (bounds[3] - bounds[1]) / grid
        ];
        if (pointInRing(candidate, ring)) return candidate;
      }
    }
    return ring[0];
  }

  function addNationalRepresentativePoints(data, countryGeojson) {
    if (!data.map) return;
    const points = data.map.points || (data.map.points = []);
    const existing = new Set(points.filter(point => point.countryIso).map(point => point.countryIso));
    (data.map.nationalStats || []).forEach(stat => {
      if (!stat.countryIso || existing.has(stat.countryIso) || reportedCases(stat) <= 0) return;
      const feature = (countryGeojson.features || []).find(item => item.properties?.country_iso === stat.countryIso);
      const coordinates = interiorPoint(feature);
      if (!coordinates) return;
      points.push({
        ...stat,
        kind: "national-representative",
        province: "National",
        lon: coordinates[0],
        lat: coordinates[1]
      });
      existing.add(stat.countryIso);
    });
  }

  function selectMapCountry(item) {
    const select = document.getElementById('countryFilter');
    const country = recordCountry(item);
    const iso = item.country_iso || item.countryIso || resolveCountryIso(country);
    const option = Array.from(select.options).find(option => option.value && (
      normalizeCountryName(option.value) === normalizeCountryName(country) ||
      (iso && resolveCountryIso(option.value) === iso)
    ));
    if (!option) return;
    select.value = select.value === option.value ? '' : option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function updateCountrySelection() {
    const country = document.getElementById('countryFilter').value;
    const iso = resolveCountryIso(country);
    const province = document.getElementById('provinceFilter').value;
    document.getElementById('selectionStatus').textContent = `Viewing: ${province || country || 'All countries'}`;
    document.getElementById('clearGeographySelection').hidden = !country && !province;
    if (!map || !map.isStyleLoaded()) return;
    renderedCountryCodes.forEach(code => {
      const slug = code.toLowerCase();
      const selected = !!iso && code === iso;
      if (map.getLayer(`cases-fill-${slug}`)) map.setPaintProperty(`cases-fill-${slug}`, 'fill-opacity', !iso || selected ? 0.72 : 0.4);
      if (map.getLayer(`cases-line-${slug}`)) {
        map.setPaintProperty(`cases-line-${slug}`, 'line-width', selected ? 4 : 2.2);
        map.setPaintProperty(`cases-line-${slug}`, 'line-color', selected ? '#ffffff' : riskColorExpression(activeMapMetric().field));
      }
    });
  }

  const handledBoundaryClicks = new WeakSet();
  function bindBoundaryInteraction(layerId) {
    map.on("click", layerId, event => {
      if (event.originalEvent && handledBoundaryClicks.has(event.originalEvent)) return;
      if (event.originalEvent) handledBoundaryClicks.add(event.originalEvent);
      const item = mapFeatureProperties(event.features[0].properties);
      selectMapCountry(item);
      if (document.getElementById('countryFilter').value) showInfoPanel(item);
      else document.getElementById('info-panel').style.display = 'none';
    });
    map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
  }

  function upsertCountryBoundary(iso3, geojson) {
    const slug = iso3.toLowerCase();
    const sourceId = `cases-${slug}`;
    const fillId = `cases-fill-${slug}`;
    const lineId = `cases-line-${slug}`;
    const metricField = activeMapMetric().field;
    const countryColor = riskColorExpression(metricField);

    if (map.getSource(sourceId)) {
      map.getSource(sourceId).setData(geojson);
      map.setPaintProperty(fillId, "fill-color", countryColor);
      map.setPaintProperty(lineId, "line-color", countryColor);
      return;
    }

    map.addSource(sourceId, { type: "geojson", data: structuredClone(geojson) });
    map.addLayer({ id: fillId, type: "fill", source: sourceId, paint: {
      "fill-color": countryColor,
      "fill-opacity": 0.72
    }});
    map.addLayer({ id: lineId, type: "line", source: sourceId, paint: {
      "line-color": countryColor, "line-width": 2.2, "line-opacity": 1
    }});
    bindBoundaryInteraction(fillId);
  }

  function flushCountryBoundaries() {
    const activeCodes = new Set(pendingCountryBoundaries.keys());
    renderedCountryCodes.forEach(iso3 => {
      if (!activeCodes.has(iso3)) map.getSource(`cases-${iso3.toLowerCase()}`)?.setData({ type: "FeatureCollection", features: [] });
    });
    pendingCountryBoundaries.forEach((geojson, iso3) => upsertCountryBoundary(iso3, geojson));
    renderedCountryCodes = activeCodes;
    map.triggerRepaint();
  }

  async function renderBoundaryLayer(data) {
    if (!await ensureMap()) return;
    try {
      await loadBoundaryManifest();
      const countries = getActiveCountryCodes(data);
      const rawCountries = await loadCombinedBoundaries(countries, 0);
      const countryGeojson = enrichBoundaries(rawCountries, data, 0);
      countryGeojson.features = countryGeojson.features.filter(feature => feature.properties?.label_primary === true);
      addNationalRepresentativePoints(data, countryGeojson);
      extendMapExtent(countryGeojson);
      if (!hasInitialFit) {
        fitOutbreakExtent(0);
        hasInitialFit = true;
      }
      pendingCountryBoundaries = new Map(countries.map(iso3 => [iso3, {
        type: "FeatureCollection",
        features: countryGeojson.features.filter(feature => feature.properties?.country_iso === iso3)
      }]));
      await renderAdminDetailLayer(data, true);
      applyMapMode();
    } catch (err) { console.error("Boundary render error:", err); }
  }

  async function renderAdminDetailLayer(data, force = false) {
    if (!map || !boundaryManifest) return;
    const requestedLevel = selectedAdminLevel();
    if (!force && requestedLevel === renderedAdminLevel) return;
    renderedAdminLevel = requestedLevel;
    const requestId = ++boundaryRequestId;
    const countries = getActiveCountryCodes(data);
    const raw = requestedLevel === 0 ? { type: "FeatureCollection", features: [] } : await loadCombinedBoundaries(countries, requestedLevel);
    if (requestId !== boundaryRequestId) return;
    const detailGeojson = enrichBoundaries(raw, data, requestedLevel);
    const metricField = activeMapMetric().field;
    const detailColor = riskColorExpression(metricField);

    if (map.getSource("admin-boundaries")) {
      map.getSource("admin-boundaries").setData(detailGeojson);
      map.setPaintProperty("admin-boundary-fill", "fill-color", detailColor);
    } else {
      map.addSource("admin-boundaries", { type: "geojson", data: detailGeojson });
      map.addLayer({ id: "admin-boundary-fill", type: "fill", source: "admin-boundaries", paint: {
        "fill-color": detailColor,
        "fill-opacity": ["case", [">", ["to-number", ["get", metricField], 0], 0], 0.68, 0.07]
      }});
      map.addLayer({ id: "admin-boundary-line", type: "line", source: "admin-boundaries", paint: {
        "line-color": ["case", [">", ["to-number", ["get", metricField], 0], 0], mapColors.moderate, "#788389"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.35, 11, 1.1],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.48, 11, 0.82]
      }});
      bindBoundaryInteraction("admin-boundary-fill");
    }
    applyMapMode();
  }

  async function renderMap(pointsData) {
    if (!pointsData || !Array.isArray(pointsData) || !await ensureMap()) return;
    const points = [];
    const bounds = new maplibregl.LngLatBounds();
    pointsData.forEach(z => {
      const lat = parseFloat(z.lat), lon = parseFloat(z.lon);
      if (!isValidCoordinate(lat, lon)) return;
      const total = Number(z.caseTotal) || getStat(z, "confirmed") + getStat(z, "suspected") + Number(z.probable || 0);
      const confirmed = getStat(z, "confirmed");
      const deaths = getStat(z, "deaths");
      const recovered = getStat(z, "recovered");
      if (Math.max(total, confirmed, deaths, recovered) <= 0) return;
      bounds.extend([lon, lat]);
      if (!mapExtentBounds) mapExtentBounds = new maplibregl.LngLatBounds();
      mapExtentBounds.extend([lon, lat]);
      points.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { ...z, caseTotal: total, confirmed, deaths, recovered } });
    });
    const geojson = { type: "FeatureCollection", features: points };
    if (map.getSource("zones")) {
      map.getSource("zones").setData(geojson);
    } else {
      map.addSource("zones", { type: "geojson", data: geojson, cluster: true, clusterRadius: 40, clusterMaxZoom: 13, clusterProperties: {
        caseTotal: ["+", ["to-number", ["get", "caseTotal"], 0]],
        confirmed: ["+", ["to-number", ["get", "confirmed"], 0]],
        deaths: ["+", ["to-number", ["get", "deaths"], 0]],
        recovered: ["+", ["to-number", ["get", "recovered"], 0]]
      } });
      map.addLayer({ id: "zone-clusters", type: "circle", source: "zones", filter: ["has", "point_count"], paint: {
        "circle-color": riskColorExpression(activeMapMetric().field), "circle-radius": metricRadiusExpression(), "circle-stroke-color": "rgba(0,0,0,0.45)", "circle-stroke-width": 2
      }});
      map.addLayer({ id: "zone-cluster-count", type: "symbol", source: "zones", filter: ["has", "point_count"], layout: { "text-field": ["to-string", ["get", activeMapMetric().field]], "text-size": 11 }, paint: { "text-color": "#ffffff" } });
      map.addLayer({ id: "zone-points", type: "circle", source: "zones", filter: ["!", ["has", "point_count"]], paint: { "circle-color": riskColorExpression(activeMapMetric().field), "circle-radius": 11, "circle-stroke-color": "rgba(0,0,0,0.45)", "circle-stroke-width": 2 } });
      map.addLayer({ id: "zone-point-count", type: "symbol", source: "zones", filter: ["!", ["has", "point_count"]], layout: { "text-field": ["to-string", ["get", activeMapMetric().field]], "text-size": 9 }, paint: { "text-color": "#ffffff" } });
      map.on("click", "zone-clusters", event => {
        const feature = event.features[0];
        map.getSource("zones").getClusterExpansionZoom(feature.properties.cluster_id).then(zoom => map.easeTo({ center: feature.geometry.coordinates, zoom }));
      });
      map.on("click", "zone-points", event => showInfoPanel(mapFeatureProperties(event.features[0].properties)));
      ["zone-clusters", "zone-points"].forEach(id => {
        map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", id, () => {
          map.getCanvas().style.cursor = "";
        });
      });
    }
    if (!bounds.isEmpty() && !hasInitialFit) {
      fitOutbreakExtent(0);
      hasInitialFit = true;
    }
    applyMapMode();
    applyMapMetricStyling();
  }

  function applyMapMetricStyling() {
    if (!map || !map.isStyleLoaded()) return;
    const metric = activeMapMetric();
    const color = riskColorExpression(metric.field);
    renderedCountryCodes.forEach(iso3 => {
      const slug = iso3.toLowerCase();
      if (map.getLayer(`cases-fill-${slug}`)) map.setPaintProperty(`cases-fill-${slug}`, "fill-color", color);
      if (map.getLayer(`cases-line-${slug}`)) map.setPaintProperty(`cases-line-${slug}`, "line-color", color);
    });
    if (map.getLayer("admin-boundary-fill")) {
      map.setPaintProperty("admin-boundary-fill", "fill-color", color);
      map.setPaintProperty("admin-boundary-fill", "fill-opacity", ["case", [">", ["to-number", ["get", metric.field], 0], 0], 0.68, 0.07]);
    }
    if (map.getLayer("admin-boundary-line")) {
      map.setPaintProperty("admin-boundary-line", "line-color", ["case", [">", ["to-number", ["get", metric.field], 0], 0], mapColors.moderate, "#788389"]);
    }
    if (map.getLayer("zone-clusters")) {
      map.setPaintProperty("zone-clusters", "circle-color", color);
      map.setPaintProperty("zone-clusters", "circle-radius", metricRadiusExpression(metric));
      map.setLayoutProperty("zone-cluster-count", "text-field", ["to-string", ["get", metric.field]]);
      map.setPaintProperty("zone-points", "circle-color", color);
      map.setLayoutProperty("zone-point-count", "text-field", ["to-string", ["get", metric.field]]);
    }
    updateMapLegend();
  }

  function setMapMode(nextMode) {
    mapMode = nextMode;
    document.querySelectorAll("[data-map-mode]").forEach(btn => btn.classList.toggle("active", btn.dataset.mapMode === mapMode));
    applyMapMode();
  }

  function applyMapMode() {
    if (!map) return;
    const showBoundaries = mapMode === "choropleth";
    const showPoints = mapMode === "points";
    (map.getStyle()?.layers || []).forEach(layer => {
      const id = layer.id;
      if (id.startsWith("cases-") || ["admin-boundary-fill", "admin-boundary-line"].includes(id)) {
        map.setLayoutProperty(id, "visibility", showBoundaries ? "visible" : "none");
      }
    });
    ["zone-clusters", "zone-cluster-count", "zone-points", "zone-point-count"].forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", showPoints ? "visible" : "none"); });
  }

  function recordCountry(item) {
    return String(item?.country || item?.country_name || item?.Country || "").replace(/\s*[*#†‡]+\s*$/, "").trim();
  }

  function recordProvince(item) {
    const inferred = item?.levelHint === "province" || (!item?.scope && item?.country && item?.name && !item?.kind)
      ? item.name
      : "";
    return String(item?.province || item?.Province || inferred || "").trim();
  }

  function isMeaningfulProvince(name, country) {
    const provinceKey = normalizeBoundaryName(name);
    const countryKey = normalizeCountryName(country);
    if (!provinceKey || /^(national|unknown)$/.test(provinceKey)) return false;
    return provinceKey !== countryKey && !countryKey.endsWith(` ${provinceKey}`);
  }

  function matchesGeography(item, country, province) {
    if (country && normalizeCountryName(recordCountry(item)) !== normalizeCountryName(country)) return false;
    if (province && normalizeBoundaryName(recordProvince(item)) !== normalizeBoundaryName(province)) return false;
    return true;
  }

  function summarizeRecords(records, sourceTotals) {
    const totals = { confirmed: 0, suspected: 0, probable: 0, deaths: 0, deathsConfirmed: 0, deathsSuspected: 0, recovered: 0 };
    (records || []).forEach(item => {
      totals.confirmed += getStat(item, "confirmed");
      totals.suspected += getStat(item, "suspected");
      totals.probable += Number(item.probable) || 0;
      totals.deaths += getStat(item, "deaths");
      totals.deathsConfirmed += Number(item.deathsConfirmed ?? item.dConf ?? item.deaths) || 0;
      totals.deathsSuspected += Number(item.deathsSuspected ?? item.dSusp) || 0;
      totals.recovered += getStat(item, "recovered");
    });
    totals.source = sourceTotals?.source || "Filtered dashboard data";
    totals.sourceDate = sourceTotals?.sourceDate || "";
    return totals;
  }

  function getFilteredDashboardData(data) {
    if (!data) return data;
    const country = document.getElementById("countryFilter")?.value || "";
    const province = document.getElementById("provinceFilter")?.value || "";
    if (!country && !province) return data;

    const zones = (data.zones || []).filter(item => matchesGeography(item, country, province));
    const boundaryStats = (data.boundaryStats || []).filter(item => matchesGeography(item, country, province));
    const provinces = (data.provinces || []).filter(item => matchesGeography(item, country, province));
    const nationalStats = (data.map?.nationalStats || []).filter(item => !province && matchesGeography(item, country, ""));
    const adminStats = (data.map?.adminStats || []).filter(item => matchesGeography(item, country, province));
    const points = (data.map?.points || []).filter(item => matchesGeography(item, country, province));
    const totalRecords = province ? zones : (nationalStats.length ? nationalStats : zones);

    return {
      ...data,
      zones,
      boundaryStats,
      provinces,
      totals: summarizeRecords(totalRecords, data.totals),
      map: { ...(data.map || {}), points, nationalStats, adminStats },
      geographyFilter: { country, province }
    };
  }

  function populateGeographyFilters(data) {
    const countrySelect = document.getElementById("countryFilter");
    const provinceSelect = document.getElementById("provinceFilter");
    if (!countrySelect || !provinceSelect) return;
    const selectedCountry = countrySelect.value;
    const selectedProvince = provinceSelect.value;
    const records = [
      ...(data.zones || []), ...(data.provinces || []),
      ...(data.map?.nationalStats || []), ...(data.map?.points || [])
    ];
    const countries = Array.from(new Set(records.map(recordCountry).filter(Boolean))).sort();
    countrySelect.innerHTML = '<option value="">All countries</option>' + countries.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    if (countries.includes(selectedCountry)) countrySelect.value = selectedCountry;

    const activeCountry = countrySelect.value;
    const provinces = Array.from(new Set(records
      .filter(item => activeCountry && matchesGeography(item, activeCountry, ""))
      .filter(item => isMeaningfulProvince(recordProvince(item), recordCountry(item)))
      .map(recordProvince))).sort();
    provinceSelect.innerHTML = '<option value="">All provinces</option>' + provinces.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    provinceSelect.disabled = !activeCountry || !provinces.length;
    if (provinces.includes(selectedProvince)) provinceSelect.value = selectedProvince;
  }

  function renderFilteredDashboard() {
    if (!currentDashboardData) return;
    const view = getFilteredDashboardData(currentDashboardData);
    renderDashboardView(view, currentDashboardData);
    const manifestPromise = loadBoundaryManifest().catch(() => null);
    void renderMapData(currentDashboardData, manifestPromise, ensureMap());
  }

  function geographicRanking(data) {
    const filter = data.geographyFilter || {};
    if (filter.province) {
      const zones = (data.boundaryStats || []).filter(item => normalizeBoundaryName(item.name) !== normalizeBoundaryName(filter.province));
      return { scope: "Health zones", records: zones.length ? zones : (data.zones || []) };
    }
    if (filter.country) {
      const external = data.subnationalByCountry?.[normalizeCountryName(filter.country)] || [];
      if (external.length) return { scope: "Health zones", records: external, availableMetrics: ["total", "confirmed", "deaths"] };
      const provinces = (data.provinces || []).filter(item => isMeaningfulProvince(item.name, item.country));
      const adminProvinces = (data.map?.adminStats || []).filter(item => item.levelHint === "province" && isMeaningfulProvince(item.name, item.country));
      const records = provinces.length ? provinces : adminProvinces;
      return { scope: records.length ? "Provinces" : "No public subnational data", records };
    }
    const countries = consolidateCountryRecords(data.map?.nationalStats || []);
    return { scope: "Countries", records: countries.length ? countries : (data.provinces || []) };
  }

  function consolidateCountryRecords(records) {
    const consolidated = new Map();
    (records || []).forEach(item => {
      const country = recordCountry(item) || String(item?.name || "").trim();
      const key = String(item?.countryIso || resolveCountryIso(country) || normalizeCountryName(country));
      if (!key) return;
      const existing = consolidated.get(key);
      if (!existing) {
        consolidated.set(key, { ...item, name: country, country });
        return;
      }
      const preferred = reportedCases(item) > reportedCases(existing) ? item : existing;
      consolidated.set(key, {
        ...existing,
        ...preferred,
        name: country,
        country,
        caseTotal: Math.max(reportedCases(existing), reportedCases(item)),
        confirmed: Math.max(getStat(existing, "confirmed"), getStat(item, "confirmed")),
        suspected: Math.max(getStat(existing, "suspected"), getStat(item, "suspected")),
        probable: Math.max(Number(existing.probable) || 0, Number(item.probable) || 0),
        deaths: Math.max(getStat(existing, "deaths"), getStat(item, "deaths")),
        recovered: Math.max(getStat(existing, "recovered"), getStat(item, "recovered"))
      });
    });
    return Array.from(consolidated.values());
  }

  function geographicLabel(item, scope) {
    const name = String(item?.name || "").trim();
    const country = recordCountry(item);
    if (scope === "Countries") return country || name || "Unknown";
    if (!country || normalizeBoundaryName(name) === normalizeCountryName(country)) return name || country || "Unknown";
    return name;
  }

  function renderCharts(data) {
    window.renderDashboardCharts?.(data);
  }

  function parseDailyHistoryCsv(text, valueColumn) {
    const rows = String(text || "").trim().split(/\r?\n/);
    if (rows.length < 2) return [];
    const headers = rows[0].split(",");
    const dateIndex = headers.indexOf("date");
    const valueIndex = headers.indexOf(valueColumn);
    if (dateIndex < 0 || valueIndex < 0) return [];
    return rows.slice(1).map(row => {
      const cells = row.split(",");
      const value = Number(cells[valueIndex]);
      return { date: cells[dateIndex], value };
    }).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.value));
  }

  async function loadDailyHistory(force = false) {
    if (force || (dailyHistoryLoadedAt && Date.now() - dailyHistoryLoadedAt >= HISTORY_REFRESH_MS)) {
      dailyHistoryPromise = null;
    }
    if (dailyHistoryPromise) return dailyHistoryPromise;
    dailyHistoryPromise = Promise.all([
      fetch(runtimeSources.dailyHistory.confirmed, { cache: force ? "reload" : "default" }).then(response => {
        if (!response.ok) throw new Error(`Daily cases returned ${response.status}`);
        return response.text();
      }),
      fetch(runtimeSources.dailyHistory.deaths, { cache: force ? "reload" : "default" }).then(response => {
        if (!response.ok) throw new Error(`Daily deaths returned ${response.status}`);
        return response.text();
      })
    ]).then(([caseCsv, deathCsv]) => {
      const byDate = new Map();
      parseDailyHistoryCsv(caseCsv, "national_cumulative_confirmed_cases").forEach(row => {
        byDate.set(row.date, { date: row.date, confirmed: row.value, suspected: 0, probable: 0, deaths: 0, recovered: 0, source: "INSP DRC daily situation report" });
      });
      parseDailyHistoryCsv(deathCsv, "national_cumulative_confirmed_deaths").forEach(row => {
        const point = byDate.get(row.date);
        if (point) point.deaths = row.value;
      });
      dailyHistoryLoadedAt = Date.now();
      return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    }).catch(error => {
      console.warn("Daily history unavailable; using API snapshots only:", error);
      dailyHistoryPromise = null;
      return [];
    });
    return dailyHistoryPromise;
  }

  function parseSubnationalCsv(text, valueColumn) {
    const rows = String(text || "").trim().split(/\r?\n/);
    if (rows.length < 2) return [];
    const headers = rows[0].split(",");
    const nameIndex = headers.indexOf("nom");
    const dateIndex = headers.indexOf("date");
    const valueIndex = headers.indexOf(valueColumn);
    if (nameIndex < 0 || dateIndex < 0 || valueIndex < 0) return [];
    return rows.slice(1).map(row => {
      const cells = row.split(",");
      const value = Number(cells[valueIndex]);
      return { name: String(cells[nameIndex] || "").trim(), date: cells[dateIndex], value };
    }).filter(row => row.name && !/^(na|drc)$/i.test(row.name) && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.value));
  }

  function latestSubnationalValues(rows) {
    const latest = new Map();
    rows.forEach(row => {
      const current = latest.get(normalizeBoundaryName(row.name));
      if (!current || row.date >= current.date) latest.set(normalizeBoundaryName(row.name), row);
    });
    return latest;
  }

  async function loadSubnationalData(force = false) {
    if (!runtimeSources.subnational?.drcHealthZonesConfirmed || !runtimeSources.subnational?.drcHealthZonesDeaths) return [];
    if (force || (subnationalLoadedAt && Date.now() - subnationalLoadedAt >= HISTORY_REFRESH_MS)) subnationalPromise = null;
    if (subnationalPromise) return subnationalPromise;
    subnationalPromise = Promise.all([
      fetch(runtimeSources.subnational.drcHealthZonesConfirmed, { cache: force ? "reload" : "default" }).then(response => {
        if (!response.ok) throw new Error(`DRC health-zone cases returned ${response.status}`);
        return response.text();
      }),
      fetch(runtimeSources.subnational.drcHealthZonesDeaths, { cache: force ? "reload" : "default" }).then(response => {
        if (!response.ok) throw new Error(`DRC health-zone deaths returned ${response.status}`);
        return response.text();
      })
    ]).then(([caseCsv, deathCsv]) => {
      const cases = latestSubnationalValues(parseSubnationalCsv(caseCsv, "cumulative_confirmed_cases"));
      const deaths = latestSubnationalValues(parseSubnationalCsv(deathCsv, "cumulative_confirmed_deaths"));
      const records = Array.from(new Set([...cases.keys(), ...deaths.keys()])).map(key => {
        const caseRow = cases.get(key), deathRow = deaths.get(key);
        const confirmed = Number(caseRow?.value) || 0;
        const deathCount = Number(deathRow?.value) || 0;
        return {
          name: caseRow?.name || deathRow?.name || key,
          country: "Democratic Republic of the Congo",
          levelHint: "health-zone",
          confirmed,
          suspected: 0,
          deaths: deathCount,
          recovered: 0,
          caseTotal: confirmed,
          lastUpdated: [caseRow?.date, deathRow?.date].filter(Boolean).sort().pop() || "",
          source: "INSP/INRB daily health-zone situation reports"
        };
      }).filter(record => record.caseTotal > 0 || record.deaths > 0);
      subnationalLoadedAt = Date.now();
      return records.sort((a, b) => b.confirmed - a.confirmed);
    }).catch(error => {
      console.warn("Subnational data unavailable:", error);
      subnationalPromise = null;
      return [];
    });
    return subnationalPromise;
  }

  function mergeSubnationalData(data, records) {
    if (!data || !records.length) return data;
    const known = new Map([...(data.zones || []), ...(data.boundaryStats || [])]
      .filter(item => item?.name)
      .map(item => [normalizeBoundaryName(item.name), item]));
    const enriched = records.map(record => ({ ...known.get(normalizeBoundaryName(record.name)), ...record }));
    data.subnationalByCountry = {
      ...(data.subnationalByCountry || {}),
      [normalizeCountryName("Democratic Republic of the Congo")]: enriched
    };
    return data;
  }

  async function enrichDashboardSubnational(data, force = false, backend = cachedDashboardMeta) {
    const records = await loadSubnationalData(force);
    if (!records.length || !data) return;
    mergeSubnationalData(data, records);
    if (currentDashboardData === data) renderFilteredDashboard();
    cacheDashboardData(data, backend);
  }

  function mergeDailyHistory(data, history) {
    if (!history.length) return data;
    const byDate = new Map(history.map(point => [point.date, point]));
    (data.timeline || []).forEach(point => {
      const existing = byDate.get(point.date);
      byDate.set(point.date, existing ? {
        ...existing,
        ...point,
        confirmed: Math.max(Number(existing.confirmed) || 0, Number(point.confirmed) || 0),
        deaths: Math.max(Number(existing.deaths) || 0, Number(point.deaths) || 0),
        source: point.source || "WHO / INSP consolidated report"
      } : point);
    });
    data.timeline = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    return data;
  }

  function renderDashboardView(data, sourceData = data) {
    document.getElementById("hdr-total").textContent = ((Number(data.totals.confirmed) || 0) + (Number(data.totals.suspected) || 0) + (Number(data.totals.probable) || 0)).toLocaleString();
    document.getElementById("resetCountrySelection").setAttribute('aria-pressed', String(!data.geographyFilter?.country && !data.geographyFilter?.province));
    document.getElementById("hdr-confirmed").innerText = (data.totals.confirmed || 0).toLocaleString();
    document.getElementById("hdr-suspected").innerText = (data.totals.suspected || 0).toLocaleString();
    document.getElementById("hdr-deaths").innerText = (data.totals.deaths || 0).toLocaleString();
    document.getElementById("hdr-recovered").innerText = (data.totals.recovered || 0).toLocaleString();
    const confirmedDeaths = data.totals.deathsConfirmed !== undefined ? data.totals.deathsConfirmed : data.totals.deaths;
    const cfr = data.totals.confirmed > 0 ? ((confirmedDeaths / data.totals.confirmed) * 100).toFixed(1) : 0;
    const recRate = data.totals.confirmed > 0 ? ((data.totals.recovered / data.totals.confirmed) * 100).toFixed(1) : 0;
    document.getElementById("risk-cfr").innerText = cfr + "%";
    document.getElementById("risk-recovery").innerText = recRate + "%";
    updateCountrySelection();
    renderCharts(data);
    document.getElementById("dataSource").textContent = sourceData.totals.source
      ? `Source: ${sourceData.totals.source}`
      : "Source: Cases sheet";
    const sourceDate = sourceData.totals.sourceDate || 'Not reported';
    const dateBadge = document.getElementById('dataAsOfBadge');
    dateBadge.textContent = `Data as of: ${sourceDate}`;
    dateBadge.title = `Reporting date supplied by the source: ${sourceDate}. This is separate from the last successful dashboard check.`;
    document.getElementById('dataSource').title = sourceData.totals.source || 'Cases sheet';
  }

  function renderDashboardSummary(data) {
    currentDashboardData = data;
    populateGeographyFilters(data);
    renderDashboardView(getFilteredDashboardData(data), data);
  }

  function displayLastChecked(value) {
    const date = value ? new Date(value) : null;
    const valid = date && !Number.isNaN(date.getTime());
    lastCheckedAt = valid ? date.getTime() : null;
    const element = document.getElementById('lastSync');
    element.textContent = valid
      ? `Last checked: ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`
      : 'Last checked: —';
    element.title = valid ? `Last successful check: ${date.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})` : 'No successful check recorded yet.';
    element.setAttribute('aria-label', element.title);
  }

  function cacheDashboardData(data, backend = cachedDashboardMeta) {
    try {
      cachedDashboardMeta = {
        version: backend?.version || data.apiVersion || "",
        dataRevision: String(backend?.dataRevision || "0")
      };
      localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), checkedAt: lastCheckedAt, ...cachedDashboardMeta, data }));
    } catch (err) {
      console.warn("Dashboard cache unavailable:", err);
    }
  }

  function renderCachedDashboard() {
    try {
      const cached = JSON.parse(localStorage.getItem(DASHBOARD_STORAGE_KEY) || "null");
      if (!cached?.data?.totals) return false;
      cachedDashboardMeta = {
        version: cached.version || cached.data.apiVersion || "",
        dataRevision: String(cached.dataRevision || "")
      };
      renderDashboardSummary(cached.data);
      displayLastChecked(cached.checkedAt);
      const mode = document.getElementById("dataModeBadge");
      mode.textContent = "Cached data";
      mode.className = "status-badge cached";
      return true;
    } catch (err) {
      return false;
    }
  }

  function applyBackendConfig(backend) {
    const sources = backend?.sources || {};
    runtimeSources = {
      ...runtimeSources,
      ...sources,
      dailyHistory: { ...runtimeSources.dailyHistory, ...(sources.dailyHistory || {}) },
      subnational: { ...runtimeSources.subnational, ...(sources.subnational || {}) }
    };
    if (!runtimeSources.mapStyle || !runtimeSources.boundaryManifest || !runtimeSources.dailyHistory.confirmed || !runtimeSources.dailyHistory.deaths) {
      throw new Error("No complete dashboard source registry is available");
    }
    const backendInterval = Number(backend?.refreshIntervalMs);
    if (backendInterval >= 10000) AUTO_REFRESH_MS = backendInterval;
  }

  async function confirmBackend() {
    if (!API_BASE) throw new Error("API endpoint is not configured");
    const separator = API_BASE.includes("?") ? "&" : "?";
    const backend = await fetchJsonWithRetry(`${API_BASE}${separator}action=ping&_request=${Date.now()}`, 2);
    if (backend?.status !== "ok") throw new Error(backend?.error || "Backend health check failed");
    applyBackendConfig(backend);
    return backend;
  }

  function prepareMapScope(data) {
    const scope = data.geographyFilter || {};
    const key = JSON.stringify([scope.country || '', scope.province || '']);
    if (key !== mapGeographyKey) {
      mapGeographyKey = key;
      hasInitialFit = false;
      renderedAdminLevel = -1;
    }
    // Refresh the available extent without changing the current camera.
    mapExtentBounds = null;
  }

  async function renderMapData(data, manifestPromise, mapPromise) {
    pendingMapData = data;
    if (mapRenderInProgress) return;
    mapRenderInProgress = true;
    try {
      if (!(await manifestPromise)) throw new Error("Boundary manifest is unavailable");
      await mapPromise;
      while (pendingMapData) {
        const latestData = pendingMapData;
        pendingMapData = null;
        prepareMapScope(latestData);
        hydrateCountryCodes(latestData);
        await renderBoundaryLayer(latestData);
        await renderMap(latestData.map?.points || latestData.zones);
        flushCountryBoundaries();
        updateCountrySelection();
        applyMapMode();
      }
    } catch (err) {
      console.error("Map update failed:", err);
    } finally {
      mapRenderInProgress = false;
    }
  }

  async function loadData(options = {}) {
    const forceRefresh = options === true || options.force === true;
    if (dataLoadInProgress) {
      pendingForceRefresh = pendingForceRefresh || forceRefresh;
      return;
    }
    const refreshButton = document.getElementById("refreshNow");
    dataLoadInProgress = true;
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = "Refreshing…";
    }
    // The basemap and local boundary catalog are independent of the API.
    // Start them immediately, and render saved overlays while data is checked.
    const mapPromise = ensureMap();
    const manifestPromise = loadBoundaryManifest().catch(err => {
      console.error("Boundary manifest failed:", err);
      return null;
    });
    if (currentDashboardData) void renderMapData(currentDashboardData, manifestPromise, mapPromise);
    let dataLoaded = false;
    try {
      const mode = document.getElementById("dataModeBadge");
      mode.textContent = "Checking";
      mode.className = "status-badge";
      const backend = await confirmBackend();
      const cacheIsCurrent = !forceRefresh && currentDashboardData && cachedDashboardMeta &&
        cachedDashboardMeta.version === backend.version &&
        cachedDashboardMeta.dataRevision === String(backend.dataRevision || "0");

      if (cacheIsCurrent) {
        displayLastChecked(Date.now());
        cacheDashboardData(currentDashboardData, backend);
        mode.textContent = "Live";
        mode.className = "status-badge live";
        void loadDailyHistory().then(history => {
          if (!history.length || !currentDashboardData) return;
          mergeDailyHistory(currentDashboardData, history);
          renderCharts(getFilteredDashboardData(currentDashboardData));
        });
        void enrichDashboardSubnational(currentDashboardData, false, backend);
        return;
      }

      const dataUrl = `${API_BASE}?action=getData${forceRefresh ? `&fresh=1&_request=${Date.now()}` : ""}`;
      const data = await fetchJsonWithRetry(dataUrl);
      if (data.error) throw new Error(data.error);
      renderDashboardSummary(data);
      displayLastChecked(Date.now());
      cacheDashboardData(data, backend);
      dataLoaded = true;
      mode.textContent = "Live";
      mode.className = "status-badge live";
      // Map geometry is substantially heavier than the statistics payload. It
      // continues in the background and never blocks refresh controls/charts.
      void renderMapData(data, manifestPromise, mapPromise);
      // Historical daily reports enrich the curve independently and do not
      // delay headline figures, controls, or map startup.
      void loadDailyHistory(forceRefresh).then(history => {
        if (!history.length) return;
        mergeDailyHistory(data, history);
        renderCharts(getFilteredDashboardData(data));
        cacheDashboardData(data, backend);
      });
      void enrichDashboardSubnational(data, forceRefresh, backend);
    } catch (err) {
      console.error("Load failed:", err);
      if (!dataLoaded) {
        // Preserve the last successful check; the status badge reports the failure.
        const mode = document.getElementById("dataModeBadge");
        mode.textContent = currentDashboardData ? "Backend unavailable" : "Unavailable";
        mode.className = currentDashboardData ? "status-badge cached" : "status-badge error";
      }
    } finally {
      dataLoadInProgress = false;
      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.textContent = "Refresh now";
      }
      if (pendingForceRefresh) {
        pendingForceRefresh = false;
        setTimeout(() => loadData({ force: true }), 0);
      }
    }
  }

  function updateAutoRefreshControl() {
    const button = document.getElementById("autoRefresh");
    if (!button) return;
    button.classList.toggle("active", autoRefreshEnabled);
    button.setAttribute("aria-pressed", String(autoRefreshEnabled));
    button.textContent = autoRefreshEnabled ? "Auto: 30s" : "Auto: off";
  }

  function scheduleAutoRefresh() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = autoRefreshEnabled ? setInterval(() => loadData(), AUTO_REFRESH_MS) : null;
    updateAutoRefreshControl();
  }

  function initializeDashboard() {
    initializeDashboardInteractions();
    renderCachedDashboard();
    loadData();
  }

  function initializeDashboardInteractions() {
    const backdrop = document.getElementById("chartBackdrop");
    const expandButtons = document.querySelectorAll("[data-expand-chart]");
    let expandedPanel = null;

    const resizePanelChart = panel => {
      const canvas = panel?.querySelector("canvas");
      const chart = canvas ? window.Chart?.getChart(canvas) : null;
      requestAnimationFrame(() => chart?.resize());
    };

    const setExpandedChartInteractions = (panel, expanded) => {
      if (!panel?.classList.contains("bar-panel")) return;
      const chart = window.Chart?.getChart(panel.querySelector("canvas"));
      if (!chart) return;
      chart.options.plugins.tooltip.enabled = expanded;
      chart.canvas.style.cursor = "default";
      chart.setActiveElements([]);
      chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
      chart.update("none");
    };

    const closeExpandedChart = () => {
      if (!expandedPanel) return;
      const button = expandedPanel.querySelector("[data-expand-chart]");
      expandedPanel.classList.remove("is-expanded");
      setExpandedChartInteractions(expandedPanel, false);
      button?.setAttribute("aria-expanded", "false");
      if (button) button.setAttribute("aria-label", button.dataset.openLabel || "Enlarge chart");
      document.body.classList.remove("chart-modal-open");
      backdrop.hidden = true;
      resizePanelChart(expandedPanel);
      button?.focus();
      expandedPanel = null;
    };

    expandButtons.forEach(button => button.addEventListener("click", () => {
      const panel = button.closest(".panel");
      if (expandedPanel === panel) {
        closeExpandedChart();
        return;
      }
      closeExpandedChart();
      expandedPanel = panel;
      button.dataset.openLabel = button.getAttribute("aria-label");
      panel.classList.add("is-expanded");
      setExpandedChartInteractions(panel, true);
      button.setAttribute("aria-expanded", "true");
      button.setAttribute("aria-label", "Close enlarged chart");
      document.body.classList.add("chart-modal-open");
      backdrop.hidden = false;
      resizePanelChart(panel);
    }));

    backdrop.addEventListener("click", closeExpandedChart);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") closeExpandedChart();
    });

    document.querySelectorAll(".info-trigger").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        const isOpen = button.getAttribute("aria-expanded") === "true";
        document.querySelectorAll(".info-trigger[aria-expanded='true']").forEach(openButton => openButton.setAttribute("aria-expanded", "false"));
        button.setAttribute("aria-expanded", String(!isOpen));
      });
    });
    document.addEventListener("click", event => {
      if (!event.target.closest(".metric-info")) {
        document.querySelectorAll(".info-trigger[aria-expanded='true']").forEach(button => button.setAttribute("aria-expanded", "false"));
      }
    });
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initializeDashboard); } else { initializeDashboard(); }
  document.querySelectorAll("[data-map-mode]").forEach(btn => btn.addEventListener("click", () => setMapMode(btn.dataset.mapMode)));
  document.getElementById("adminLevel").addEventListener("change", () => {
    renderedAdminLevel = -1;
    if (currentDashboardData) renderAdminDetailLayer(currentDashboardData, true);
  });
  document.getElementById("mapMetric").addEventListener("change", () => {
    applyMapMetricStyling();
    updateCountrySelection();
    if (currentDashboardData) renderCharts(getFilteredDashboardData(currentDashboardData));
  });
  document.getElementById("countryFilter").addEventListener("change", () => {
    document.getElementById("provinceFilter").value = "";
    populateGeographyFilters(currentDashboardData || {});
    renderFilteredDashboard();
  });
  document.getElementById('clearGeographySelection').addEventListener('click', () => {
    document.getElementById('resetCountrySelection').click();
  });
  document.getElementById('resetCountrySelection').addEventListener('click', () => {
    document.getElementById('countryFilter').value = '';
    document.getElementById('info-panel').style.display = 'none';
    document.getElementById('countryFilter').dispatchEvent(new Event('change', { bubbles: true }));
  });
  document.getElementById("provinceFilter").addEventListener("change", renderFilteredDashboard);
  document.getElementById("refreshNow").addEventListener("click", () => loadData({ force: true }));
  document.getElementById("autoRefresh").addEventListener("click", () => {
    autoRefreshEnabled = !autoRefreshEnabled;
    scheduleAutoRefresh();
  });
  document.getElementById("trendWindow").addEventListener("change", () => {
    if (currentDashboardData) renderCharts(getFilteredDashboardData(currentDashboardData));
  });
  document.getElementById("geoLimit").addEventListener("change", () => {
    if (currentDashboardData) renderCharts(getFilteredDashboardData(currentDashboardData));
  });
  window.addEventListener("storage", event => {
    if (event.key === REFRESH_SIGNAL_KEY && event.newValue) loadData({ force: true });
  });
  updateMapLegend();
  scheduleAutoRefresh();
