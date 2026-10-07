(function (global) {
  "use strict";

  // Deployment settings shared by the dashboard and the admin form.
  // A new Apps Script deployment URL only needs to be changed here.
  global.EBOLA_APP_CONFIG = Object.freeze({
    apiBase: "https://script.google.com/macros/s/AKfycbzj3Iex_lOKh7Rg6Z2aov50usBaGwvUhm5t3AbxAOE6ggg156U57fc3NBSmkNxmkxht_g/exec",
    autoRefreshMs: 30000,
    historyRefreshMs: 300000,
    dashboardStorageKey: "ebola-dashboard-last-data-v2",
    refreshSignalKey: "ebola-dashboard-refresh-request",
    mapThresholds: {
      total: { moderate: 15, high: 50 },
      confirmed: { moderate: 15, high: 50 },
      deaths: { moderate: 5, high: 15 },
      recovered: { moderate: 10, high: 30 }
    },
    // Rollout fallback. Once the current backend is deployed, its source
    // registry overrides these values automatically.
    sources: {
      mapStyle: "https://tiles.openfreemap.org/styles/dark?v=20261006",
      boundaryManifest: "data/gis/world/manifest.json?v=20261007",
      dailyHistory: {
        confirmed: "https://raw.githubusercontent.com/INRB-UMIE/BDBV2026-Data/main/data/insp_sitrep/processed/insp_sitrep__national_cumulative_confirmed_cases__daily.csv",
        deaths: "https://raw.githubusercontent.com/INRB-UMIE/BDBV2026-Data/main/data/insp_sitrep/processed/insp_sitrep__national_cumulative_confirmed_deaths__daily.csv"
      },
      subnational: {
        drcHealthZonesConfirmed: "https://raw.githubusercontent.com/INRB-UMIE/BDBV2026-Data/main/data/insp_sitrep/processed/insp_sitrep__cumulative_confirmed_cases__daily.csv",
        drcHealthZonesDeaths: "https://raw.githubusercontent.com/INRB-UMIE/BDBV2026-Data/main/data/insp_sitrep/processed/insp_sitrep__cumulative_confirmed_deaths__daily.csv"
      }
    }
  });
})(window);
