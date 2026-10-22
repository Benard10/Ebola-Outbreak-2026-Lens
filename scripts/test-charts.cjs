const { chromium } = require('../.qa/node_modules/playwright');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0]);
  const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file)];
    res.setHeader('Content-Type', type || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const pluginBlocked of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      // Deterministic chart tests: suppress live API/map startup, retain real DOM and Chart.js.
      await page.route('**/dashboard.js*', route => {
        const original = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
        const isolated = original.replace(/    loadData\(\);\r?\n  }/, '    /* live startup disabled in chart test */\n  }');
        assert.notEqual(original, isolated, 'Live startup must be disabled for deterministic fixtures');
        return route.fulfill({ contentType: 'text/javascript', body: isolated });
      });
      if (pluginBlocked) await page.route('**/chartjs-plugin-zoom@*/**', route => route.abort());
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
      await page.evaluate(async () => {
        clearInterval(autoRefreshTimer);
        runtimeSources.mapStyle = {
          version: 8,
          glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
          sources: { fixture: { type: 'geojson', data: { type: 'FeatureCollection', features: [
            { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[20,-10],[36,-10],[36,6],[20,6],[20,-10]]] } }
          ] } } },
          layers: [
            { id: 'background', type: 'background', paint: { 'background-color': '#1e2326' } },
            { id: 'boundary_state', type: 'line', source: 'fixture', paint: { 'line-opacity': .6 } },
            { id: 'place_country_major', type: 'symbol', source: 'fixture', layout: { 'text-field': '' }, paint: { 'text-opacity': .9 } },
            { id: 'place_city', type: 'symbol', source: 'fixture', layout: { 'text-field': '' }, paint: { 'text-opacity': .8 } },
            { id: 'cases-fill-fixture', type: 'fill', source: 'fixture', paint: { 'fill-color': '#ef4444', 'fill-opacity': .7 } }
          ]
        };
        await Promise.race([ensureMap(), new Promise((_, reject) => setTimeout(() => reject(new Error('Map startup timed out: ' + JSON.stringify(window.__mapErrors))), 20000))]);
        window.realRenderFilteredDashboard = renderFilteredDashboard;
        mapExtentBounds = new maplibregl.LngLatBounds([20, -10], [36, 6]);
        document.getElementById('adminLevel').value = '0';
        // Geographic interaction still uses production filters/rendering; isolate map networking.
        renderMapData = async () => {};
        ensureMap = () => null;
        loadBoundaryManifest = async () => null;
        const countries = [
          { name: 'Uganda', country: 'Uganda', confirmed: 120, suspected: 10, probable: 3, deaths: 20, recovered: 25 },
          { name: 'Kenya', country: 'Kenya', confirmed: 20, suspected: 5, probable: 2, deaths: 2, recovered: 3 }
        ];
        currentDashboardData = {
          totals: { confirmed: 140, suspected: 15, probable: 5, deaths: 22, recovered: 28, sourceDate: '2026-10-18', source: 'WHO Alert and Response / national surveillance reports' },
          timeline: Array.from({ length: 35 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, confirmed: 20 + i * 3, suspected: 0, deaths: i })),
          provinces: [{ name: 'Central', country: 'Uganda', confirmed: 120, suspected: 10, deaths: 20 }],
          zones: [], map: { nationalStats: countries, adminStats: [], points: [] }
        };
        currentDashboardData.timeline = currentDashboardData.timeline.map((r, i) => ({ ...r, date: new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10) }));
        populateGeographyFilters(currentDashboardData);
        renderDashboardView(currentDashboardData, currentDashboardData);
      });
      const countrySelection = await page.evaluate(() => {
        const renders = [];
        renderMapData = async data => { renders.push(data === currentDashboardData); };
        selectMapCountry({ country: 'Uganda' });
        const first = { country: document.getElementById('countryFilter').value, total: document.getElementById('hdr-total').textContent };
        selectMapCountry({ country: 'Kenya' });
        const next = { country: document.getElementById('countryFilter').value, total: document.getElementById('hdr-total').textContent };
        selectMapCountry({ country: 'Kenya' });
        const cleared = { country: document.getElementById('countryFilter').value, total: document.getElementById('hdr-total').textContent };
        selectMapCountry({ country: 'Uganda' });
        document.getElementById('clearGeographySelection').click();
        return { first, next, cleared, reset: document.getElementById('countryFilter').value, renders };
      });
      assert.equal(countrySelection.first.country, 'Uganda');
      assert.equal(countrySelection.next.country, 'Kenya');
      assert.notEqual(countrySelection.first.total, countrySelection.next.total);
      assert.equal(countrySelection.cleared.country, '');
      assert.equal(countrySelection.cleared.total, '160');
      assert.equal(countrySelection.reset, '');
      assert.ok(countrySelection.renders.length >= 5 && countrySelection.renders.every(Boolean), 'Every selection must retain full map data');
      for (const closeWith of ['button', 'escape']) {
        await page.evaluate(() => {
          selectMapCountry({ country: 'Uganda' });
          showInfoPanel({ name: 'Uganda', country: 'Uganda', confirmed: 120 });
        });
        assert.equal(await page.locator('#countryFilter').inputValue(), 'Uganda');
        if (closeWith === 'button') await page.getByRole('button', { name: 'Close location details' }).click();
        else await page.keyboard.press('Escape');
        assert.equal(await page.locator('#countryFilter').inputValue(), '');
        assert.equal(await page.locator('#provinceFilter').inputValue(), '');
        assert.equal(await page.locator('#hdr-total').textContent(), '160');
        assert.equal(await page.locator('#selectionStatus').textContent(), 'Viewing: All countries');
        assert.equal(await page.locator('#info-panel').isVisible(), false);
      }
      const reportingDates = await page.evaluate(async () => {
        confirmBackend = async () => ({ version: 'date-fixture', dataRevision: '1' });
        loadDailyHistory = async () => [];
        enrichDashboardSubnational = async () => {};
        cachedDashboardMeta = { version: 'date-fixture', dataRevision: '1' };
        await loadData();
        const checked = document.getElementById('lastSync').textContent;
        const sourceDate = document.getElementById('dataAsOfBadge').textContent;
        const stamp = lastCheckedAt;
        confirmBackend = async () => { throw new Error('Expected offline fixture'); };
        await loadData();
        const failurePreserved = checked === document.getElementById('lastSync').textContent && stamp === lastCheckedAt;
        const cacheRestored = renderCachedDashboard() && stamp === lastCheckedAt;
        return { checked, sourceDate, failurePreserved, cacheRestored };
      });
      assert.match(reportingDates.checked, /^Last checked: \d\d:\d\d:\d\d$/);
      assert.equal(reportingDates.sourceDate, 'Data as of: 2026-10-18');
      assert.equal(reportingDates.failurePreserved, true);
      assert.equal(reportingDates.cacheRestored, true);
      assert.equal(await page.locator('.map-mode-toggle > [data-map-mode]').count(), 0);
      await page.locator('#mapOptions summary').click();
      assert.equal(await page.locator('#adminLevel').isVisible(), true);
      assert.equal(await page.evaluate(() => map.getPaintProperty('cases-fill-fixture', 'fill-opacity')), .7);
      assert.ok(Array.isArray(await page.evaluate(() => map.getPaintProperty('place_city', 'text-opacity'))));
      assert.equal(await page.locator('#mapDetailedLabels').count(), 0);
      await page.locator('#resetMapView').click();
      assert.equal(await page.evaluate(() => map.getZoom()), 4);
      await page.locator('#fitAffectedAreas').click();
      assert.equal(await page.evaluate(() => {
        const a = map.project([20,-10]), b = map.project([36,6]);
        const { clientWidth: w, clientHeight: h } = map.getContainer();
        return a.x >= 0 && a.x <= w && a.y >= 0 && a.y <= h && b.x >= 0 && b.x <= w && b.y >= 0 && b.y <= h;
      }), true);
      await page.evaluate(() => {
        const geojson = structuredClone(map.getStyle().sources.fixture.data);
        geojson.features[0].properties = { name: 'Uganda', country_name: 'Uganda', country_iso: 'UGA', label_primary: true, confirmed: 120, caseTotal: 130 };
        window.labelFixture = geojson;
        pendingCountryBoundaries = new Map([['UGA', geojson]]);
        flushCountryBoundaries();
      });
      await page.waitForTimeout(250);
      assert.equal(await page.locator('.map-country-label').count(), 0);
      const refreshCamera = await page.evaluate(() => {
        prepareMapScope(currentDashboardData);
        hasInitialFit = true;
        map.jumpTo({ center: [30, 1], zoom: 5.5 });
        const before = JSON.stringify([map.getCenter().toArray(), map.getZoom()]);
        window.realRenderFilteredDashboard();
        const keptFitFlag = hasInitialFit;
        prepareMapScope(currentDashboardData);
        const sameScopeKeptFit = hasInitialFit;
        const after = JSON.stringify([map.getCenter().toArray(), map.getZoom()]);
        prepareMapScope({ geographyFilter: { country: 'Uganda' } });
        const newScopeNeedsFit = !hasInitialFit;
        prepareMapScope(currentDashboardData);
        mapExtentBounds = new maplibregl.LngLatBounds([20,-10],[36,6]);
        fitOutbreakExtent(0);
        return { keptFitFlag, sameScopeKeptFit, newScopeNeedsFit, cameraUnchanged: before === after };
      });
      assert.deepEqual(refreshCamera, { keptFitFlag: true, sameScopeKeptFit: true, newScopeNeedsFit: true, cameraUnchanged: true });
      const mapClick = await page.evaluate(() => {
        const p = map.project(interiorPoint(window.labelFixture.features[0]));
        const r = map.getCanvas().getBoundingClientRect();
        return { x: r.left + p.x, y: r.top + p.y };
      });
      await page.mouse.move(mapClick.x, mapClick.y);
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.maplibregl-popup').count(), 0);
      await page.mouse.click(mapClick.x, mapClick.y);
      assert.equal(await page.locator('#info-panel').isVisible(), true);
      assert.equal(await page.locator('#info-title').textContent(), 'Uganda');
      assert.equal(await page.locator('#countryFilter').inputValue(), 'Uganda');
      assert.deepEqual(await page.evaluate(() => chartInstances.doughnut.data.datasets[0].data), [120, 10, 3]);
      assert.equal(await page.locator('#hdr-confirmed').textContent(), '120');
      assert.deepEqual(await page.evaluate(() => chartInstances.trend.data.datasets.find(dataset => dataset.label === 'Cumulative reported cases').data), await page.evaluate(() => {
        const count = document.getElementById('trendWindow').value;
        const rows = count === 'all' ? currentDashboardData.timeline : currentDashboardData.timeline.slice(-Number(count));
        return rows.map(row => (row.confirmed || 0) + (row.suspected || 0) + (row.probable || 0));
      }));
      assert.match(await page.locator('#trendRange').textContent(), /All countries/);
      await page.getByRole('button', { name: 'Total cases: reset to all countries' }).click();
      assert.equal(await page.locator('#countryFilter').inputValue(), '');
      assert.deepEqual(await page.evaluate(() => chartInstances.doughnut.data.datasets[0].data), [140, 15, 5]);
      assert.ok(await page.evaluate(() => chartInstances.trend.data.labels.length > 0));
      assert.equal(await page.locator('#info-panel').isVisible(), false);
      await page.evaluate(() => { setMapMode('points'); });
      assert.equal(await page.locator('.map-country-label').count(), 0);
      await page.evaluate(() => {
        setMapMode('choropleth'); pendingCountryBoundaries.clear(); flushCountryBoundaries();
      });
      assert.equal(await page.locator('.map-country-label').count(), 0);
      await page.evaluate(() => { pendingCountryBoundaries.set('UGA', window.labelFixture); flushCountryBoundaries(); });
      await page.evaluate(() => showInfoPanel({ name: 'Democratic Republic of the Congo', country_name: 'Democratic Republic of the Congo', confirmed: 9415, suspected: 513, deaths: 4536, recovered: 2530, status: 'WHO SNAPSHOT' }));
      assert.equal(await page.locator('#info-panel').isVisible(), true);
      assert.equal(await page.evaluate(() => document.getElementById('info-panel').getBoundingClientRect().top >= document.querySelector('.map-mode-toggle').getBoundingClientRect().bottom), true);
      await page.locator('.map-panel').screenshot({ path: path.join(root, '.qa/map-details-desktop.png') });
      await page.locator('#mapOptions summary').click();
      await page.waitForTimeout(50);
      assert.equal(await page.locator('#info-panel').isVisible(), false);
      await page.evaluate(() => showInfoPanel({ name: 'Kenya', confirmed: 20 }));
      assert.equal(await page.locator('#mapOptions').getAttribute('open'), null);
      await page.getByRole('button', { name: 'Close location details' }).click();
      assert.equal(await page.locator('#info-panel').isVisible(), false);
      assert.deepEqual(await page.evaluate(() => chartInstances.doughnut.data.datasets[0].data), [140, 15, 5]);
      assert.match(await page.locator('#caseloadDeaths').textContent(), /22 reported deaths/);
      await page.getByRole('button', { name: 'Suspected', exact: true }).click();
      await page.evaluate(() => {
        window.beforeIds = Object.fromEntries(Object.entries(chartInstances).map(([k, c]) => [k, c.id]));
        if (chartInstances.trend.zoomScale) chartInstances.trend.zoomScale('x', { min: 2, max: 7 }, 'none');
        chartInstances.trend.setDatasetVisibility(2, true);
        renderCharts(currentDashboardData);
        currentDashboardData.totals.confirmed += 1;
        currentDashboardData.timeline[34].confirmed += 1;
        renderCharts(currentDashboardData);
      });
      const state = await page.evaluate(() => ({
        same: Object.entries(chartInstances).every(([k, c]) => c.id === beforeIds[k]),
        suspectedHidden: !chartInstances.doughnut.getDataVisibility(1),
        deathsVisible: chartInstances.trend.isDatasetVisible(2),
        zoom: [chartInstances.trend.options.scales.x.min, chartInstances.trend.options.scales.x.max]
      }));
      assert.ok(state.same); assert.ok(state.suspectedHidden); assert.ok(state.deathsVisible);
      if (!pluginBlocked) assert.deepEqual(state.zoom, [2, 7]);
      // Correct an older report outside the visible window; averages must update.
      assert.ok(await page.evaluate(() => {
        const c = chartInstances.trend;
        const old = c.data.datasets[3].data[0];
        currentDashboardData.timeline[14].confirmed += 2;
        renderCharts(currentDashboardData);
        return old !== c.data.datasets[3].data[0];
      }));
      await page.locator('.bar-panel [data-expand-chart]').click();
      assert.equal(await page.evaluate(() => chartInstances.bar.options.plugins.tooltip.enabled), true);
      await page.locator('.bar-panel [data-expand-chart]').click();
      await page.locator('.trend-panel .chart-tools-btn').click();
      await page.getByRole('menuitemcheckbox', { name: 'Log scale' }).click();
      assert.equal(await page.evaluate(() => chartInstances.trend.options.scales.y.type), 'logarithmic');
      await page.locator('.bar-panel .chart-tools-btn').click();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.bar-panel .chart-tools-btn').getAttribute('aria-expanded'), 'false');
      await page.locator('.bar-panel .chart-tools-btn').click();
      const csvPromise = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: 'Export CSV' }).click();
      const csv = await csvPromise;
      assert.match(csv.suggestedFilename(), /geographic-impact.*\.csv$/);
      const csvText = fs.readFileSync(await csv.path(), 'utf8'); assert.match(csvText, /Uganda/);
      await page.locator('.trend-panel .chart-tools-btn').click();
      const pngPromise = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: 'Export PNG' }).click();
      assert.ok(fs.statSync(await (await pngPromise).path()).size > 1000);
      // Drill using the same callback as clicking a bar, then step up via the chip.
      await page.evaluate(() => chartInstances.bar.options.onClick({}, [{ index: 0 }]));
      assert.equal(await page.locator('#countryFilter').inputValue(), 'Uganda');
      await page.locator('#geoDrillPill').click();
      assert.equal(await page.locator('#countryFilter').inputValue(), '');
      await page.locator('#caseloadMapDeaths').click();
      assert.equal(await page.locator('#mapMetric').inputValue(), 'deaths');
      await page.locator('#autoRefresh').click();
      assert.equal(await page.locator('#autoRefresh').getAttribute('aria-pressed'), 'false');
      await page.locator('#chartsViewToggle').click();
      assert.equal(await page.locator('#chartsViewToggle').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.map-panel').isVisible(), false);
      assert.equal(await page.locator('#chartsViewFilters #countryFilter').count(), 1);
      await page.waitForTimeout(250);
      assert.ok(await page.evaluate(() => document.querySelector('.trend-panel').getBoundingClientRect().width > innerWidth / 2));
      await page.screenshot({ path: path.join(root, '.qa/charts-whole-view.png'), fullPage: true });
      await page.locator('.trend-panel [data-expand-chart]').click();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#chartsViewToggle').getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#chartsViewToggle').getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('.map-panel').isVisible(), true);
      assert.equal(await page.locator('.map-mode-toggle #countryFilter').count(), 1);
      await page.screenshot({ path: path.join(root, '.qa/chart-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 1366, height: 650 });
      await page.waitForTimeout(250);
      const compact = await page.evaluate(() => {
        const plot = document.querySelector('.caseload-chart-area').getBoundingClientRect();
        const controls = document.querySelector('#caseloadControls').getBoundingClientRect();
        return {
          plotHeight: plot.height,
          separated: controls.height === 0 || plot.bottom <= controls.top,
          trendPlotHeight: chartInstances.trend.chartArea.bottom - chartInstances.trend.chartArea.top,
          overflow: document.documentElement.scrollWidth > innerWidth
        };
      });
      assert.ok(compact.plotHeight >= 55, JSON.stringify(compact));
      assert.ok(compact.separated, JSON.stringify(compact));
      assert.ok(compact.trendPlotHeight >= 60, JSON.stringify(compact));
      assert.equal(compact.overflow, false);
      await page.screenshot({ path: path.join(root, '.qa/chart-laptop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(root, '.qa/chart-mobile.png'), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), true);
      assert.ok(await page.evaluate(() => chartInstances.trend.chartArea.bottom - chartInstances.trend.chartArea.top >= 40));
      await page.setViewportSize({ width: 360, height: 640 });
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), true);
      assert.ok(await page.evaluate(() => chartInstances.trend.chartArea.bottom - chartInstances.trend.chartArea.top >= 25));
      await page.screenshot({ path: path.join(root, '.qa/chart-small-phone.png'), fullPage: true });
      await page.locator('#chartsViewToggle').click();
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('#chartsViewFilters #mapMetric').isVisible(), true);
      await page.screenshot({ path: path.join(root, '.qa/charts-whole-view-phone.png'), fullPage: true });
      await page.locator('#chartsViewToggle').click();
      await page.locator('#fitAffectedAreas').click();
      await page.locator('#mapOptions summary').click();
      assert.equal(await page.locator('[data-map-mode="points"]').isVisible(), true);
      await page.locator('[data-map-mode="points"]').click();
      assert.equal(await page.evaluate(() => mapMode), 'points');
      await page.locator('[data-map-mode="choropleth"]').click();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#mapOptions').getAttribute('open'), null);
      assert.deepEqual(await page.evaluate(() => window.__mapErrors), []);
      await page.evaluate(() => showInfoPanel({ name: 'Democratic Republic of the Congo', confirmed: 9415, suspected: 513, deaths: 4536 }));
      assert.equal(await page.evaluate(() => {
        const r = document.getElementById('info-panel').getBoundingClientRect();
        return r.top >= document.querySelector('.map-mode-toggle').getBoundingClientRect().bottom && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
      }), true);
      await page.screenshot({ path: path.join(root, '.qa/map-details-phone.png'), fullPage: true });
      await page.getByRole('button', { name: 'Close location details' }).click();
      assert.deepEqual(errors, []);
      for (const [width, height] of [[320,568],[360,640],[390,844],[412,915],[568,320]]) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(250);
        const layout = await page.evaluate(() => {
          const rect = id => { const e = document.getElementById(id), r = e.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, clipped:e.scrollWidth > e.clientWidth }; };
          return { date: rect('dataAsOfBadge'), checked: rect('lastSync'),
            overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight + 1,
            trendHeight: chartInstances.trend.chartArea.bottom - chartInstances.trend.chartArea.top,
            doughnutRadius: chartInstances.doughnut.getDatasetMeta(0).data[0]?.outerRadius || 0 };
        });
        console.log('SCREEN', width, height, JSON.stringify(layout));
        assert.equal(layout.overflow, false);
        for (const r of [layout.date, layout.checked]) { assert.ok(r.left >= 0 && r.right <= width && r.bottom <= height); assert.equal(r.clipped, false); }
        assert.ok(layout.trendHeight >= 20, JSON.stringify(layout));
        assert.ok(layout.doughnutRadius >= 15, JSON.stringify(layout));
        await page.evaluate(() => { currentDashboardData.timeline[34].confirmed += 1; renderCharts(getFilteredDashboardData(currentDashboardData)); });
        assert.ok(await page.evaluate(() => chartInstances.trend.chartArea.bottom - chartInstances.trend.chartArea.top >= 20));
        await page.screenshot({ path: path.join(root, `.qa/reporting-${width}x${height}.png`), fullPage: true });
      }
      console.log(`PASS: real Chart.js, ${pluginBlocked ? 'zoom CDN blocked' : 'zoom enabled'}; refresh, prior corrections, legend state, filters, menus, exports, expansion, mobile.`);
      await context.close();
    }
  } finally { await browser.close(); server.close(); }
})().catch(err => { console.error(err); server.close(); process.exitCode = 1; });
