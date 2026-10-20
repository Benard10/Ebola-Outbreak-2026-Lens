/*
 * dashboard-charts.js — interactive chart layer for the Ebola surveillance dashboard.
 *
 * Loads AFTER dashboard.js and replaces only the front-end `renderCharts(data)`
 * function. Nothing in the data layer is touched: loadData, API calls, caching,
 * history/subnational merging, filtering and the map code all stay exactly as
 * they are in dashboard.js. This file only reads the data those functions
 * already produce.
 *
 * What it adds
 *  Growth curve : 7-report average, growth-rate tooltip, crosshair, gradient fill,
 *                 latest-value + peak markers, drag-to-zoom / shift-drag pan /
 *                 pinch / double-click reset, log-scale toggle, doubling time.
 *  Geo bars     : bars coloured with the same thresholds as the map legend, inline
 *                 value labels, hover focus, click-to-drill (country → province),
 *                 sort modes, "clear filter" chip.
 *  Doughnut     : exclusive case classifications, separate deaths reporting,
 *                 centre read-out, legend toggles and keyboard slice controls.
 *  All charts   : ⋯ menu (PNG / CSV export), keyboard/ARIA labels, reduced-motion
 *                 support, and no needless rebuilds on the 30 s auto-refresh
 *                 (zoom, legend toggles and hover state now survive refreshes).
 */
(function () {
  'use strict';
  if (!window.Chart) return;

  const $ = id => document.getElementById(id);
  const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const PREF_KEY = 'ebola-dashboard-chart-prefs-v1';
  const PANEL_BG = '#2a3135';
  const SORT_ORDER = ['desc', 'asc', 'alpha'];
  const SORT_LABELS = { desc: 'High → Low', asc: 'Low → High', alpha: 'A → Z' };

  /* ---------- preferences (remembered between visits) ---------- */
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; }
  }
  const prefs = Object.assign({ trendLog: false, barSort: 'desc' }, loadPrefs());
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* storage unavailable */ }
  }
  function rerender() {
    if (typeof currentDashboardData !== 'undefined' && currentDashboardData) {
      window.renderCharts(getFilteredDashboardData(currentDashboardData));
    }
  }

  /* ---------- zoom plugin (optional CDN script) ---------- */
  try {
    if (window.ChartZoom && !(Chart.registry && Chart.registry.plugins.get('zoom'))) Chart.register(window.ChartZoom);
  } catch (e) { /* already registered */ }
  const ZOOM_AVAILABLE = (function () {
    try { return !!(Chart.registry && Chart.registry.plugins.get('zoom')); } catch (e) { return false; }
  })();

  /* ---------- small helpers ---------- */
  function hexA(hex, alpha) {
    const n = parseInt(String(hex).slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  function movingAverage(values, span) {
    return values.map((_, i) => {
      const win = values.slice(Math.max(0, i - span + 1), i + 1).filter(v => v != null);
      return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
    });
  }
  function fmt(n, digits) {
    return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: digits || 0 });
  }
  function growthSummary(timeline, cum) {
    if (timeline.length < 2) return '';
    const first = cum[0], last = cum[cum.length - 1];
    const days = (Date.parse(timeline[timeline.length - 1].date) - Date.parse(timeline[0].date)) / 864e5;
    if (!(days > 0) || !(first > 0)) return '';
    if (last === first) return 'Reported counts unchanged in window';
    if (last < first) return 'Reported counts decreased in window (possible reporting corrections)';
    const rate = Math.pow(last / first, 1 / days) - 1;
    return `Reported-count change: +${(rate * 100).toFixed(1)}%/day · extrapolated doubling ≈ ${(Math.LN2 / Math.log(1 + rate)).toFixed(1)}d (reporting delays/corrections may affect this)`;
  }
  function destroyChart(key) {
    const c = chartInstances[key];
    if (c) { try { c.destroy(); } catch (e) { /* noop */ } delete chartInstances[key]; }
  }
  function setLabel(canvas, text) {
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', text);
  }

  /*
   * Build a chart only when its inputs changed. The original code destroyed and
   * rebuilt every chart on every refresh tick, which wiped zoom, legend toggles
   * and replayed the intro animation every 30 s.
   */
  function mountChart(key, canvas, signature, build, kind) {
    const prev = chartInstances[key];
    if (prev && prev.canvas === canvas && prev.$sig === signature) return prev;
    const config = build();
    if (prev && prev.canvas === canvas) {
      const zoomed = kind === 'lines' && prev.isZoomedOrPanned?.();
      const oldScale = prev.options.scales?.x;
      const oldLabels = prev.data.labels || [];
      const oldMin = oldScale?.min, oldMax = oldScale?.max;
      const hiddenSets = new Map(prev.data.datasets.map((d, i) => [d.label, !prev.isDatasetVisible(i)]));
      prev.data.labels = config.data.labels;
      config.data.datasets.forEach((dataset, i) => {
        Object.assign(prev.data.datasets[i] || (prev.data.datasets[i] = {}), dataset);
      });
      prev.data.datasets.length = config.data.datasets.length;
      if (zoomed && config.options.scales?.x) {
        const minLabel = oldLabels[oldMin], maxLabel = oldLabels[oldMax];
        const min = config.data.labels.indexOf(minLabel), max = config.data.labels.indexOf(maxLabel);
        if (min >= 0 && max > min) Object.assign(config.options.scales.x, { min, max });
      }
      prev.options = config.options;
      if (kind === 'lines') prev.data.datasets.forEach((d, i) => {
        if (hiddenSets.has(d.label)) prev.setDatasetVisibility(i, !hiddenSets.get(d.label));
      });
      prev.$sig = signature;
      prev.update('none');
      return prev;
    }
    if (prev) prev.destroy();
    const stray = Chart.getChart?.(canvas);
    if (stray) stray.destroy();
    const chart = new Chart(canvas.getContext('2d'), config);
    chart.$sig = signature;
    chartInstances[key] = chart;
    return chart;
  }

  /* ---------- shared tooltip styling ---------- */
  const tooltipBase = {
    backgroundColor: 'rgba(20, 27, 30, 0.96)',
    borderColor: colors.teal,
    borderWidth: 1,
    cornerRadius: 6,
    titleColor: '#ffffff',
    bodyColor: '#dce7e5',
    footerColor: colors.teal
  };

  /* ---------- custom plugins ---------- */
  const crosshairPlugin = {
    id: 'crosshair',
    afterDatasetsDraw(chart) {
      const active = chart.tooltip && chart.tooltip.getActiveElements ? chart.tooltip.getActiveElements() : [];
      if (!active.length || !chart.chartArea) return;
      const { ctx, chartArea } = chart;
      const x = active[0].element.x;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(224, 230, 237, 0.35)';
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    }
  };

  const trendMarkersPlugin = {
    id: 'trendMarkers',
    afterDatasetsDraw(chart, args, opts) {
      const area = chart.chartArea;
      if (!area) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.font = '600 9px "IBM Plex Mono", monospace';
      ctx.textBaseline = 'middle';
      // latest cumulative value
      const cumMeta = chart.getDatasetMeta(1);
      if (chart.isDatasetVisible(1) && cumMeta.data.length) {
        const i = cumMeta.data.length - 1;
        const pt = cumMeta.data[i];
        const v = chart.data.datasets[1].data[i];
        if (pt && Number.isFinite(pt.y) && v != null) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = colors.teal;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = PANEL_BG;
          ctx.stroke();
          ctx.fillStyle = '#e0e6ed';
          ctx.textAlign = 'right';
          ctx.fillText(fmt(v), pt.x - 7, Math.min(area.bottom - 8, pt.y + 14));
        }
      }
      // peak of "new since prior report"
      const peak = opts && opts.peak;
      if (peak != null && chart.isDatasetVisible(0)) {
        const bar = chart.getDatasetMeta(0).data[peak];
        const v = chart.data.datasets[0].data[peak];
        if (bar && v != null) {
          ctx.fillStyle = colors.yellow;
          ctx.textAlign = 'center';
          ctx.fillText(`▲ ${fmt(v)}`, Math.min(area.right - 18, Math.max(area.left + 18, bar.x)), Math.max(area.top + 8, bar.y - 8));
        }
      }
      ctx.restore();
    }
  };

  const barLabelsPlugin = {
    id: 'barLabels',
    afterDatasetsDraw(chart, args, opts) {
      const meta = chart.getDatasetMeta(0);
      const values = chart.data.datasets[0].data;
      const area = chart.chartArea;
      if (!area || !meta.data.length) return;
      const total = (opts && opts.total) || 0;
      const roomy = !!(chart.canvas.closest && chart.canvas.closest('.is-expanded'));
      const ctx = chart.ctx;
      ctx.save();
      ctx.textBaseline = 'middle';
      meta.data.forEach((bar, i) => {
        const hovered = chart.$hover === i;
        if (bar.height < 11 && !hovered) return;
        const v = values[i];
        const share = total > 0 ? ` · ${(v / total * 100).toFixed(0)}%` : '';
        const text = (hovered || roomy) ? `${fmt(v)}${share}` : fmt(v);
        ctx.font = `${hovered ? 700 : 600} 10px "IBM Plex Mono", monospace`;
        const w = ctx.measureText(text).width;
        const outside = bar.x + 6 + w <= area.right + 34;
        ctx.textAlign = outside ? 'left' : 'right';
        ctx.fillStyle = outside ? (hovered ? '#ffffff' : '#c3cdd6') : '#10201d';
        ctx.fillText(text, outside ? bar.x + 6 : bar.x - 6, bar.y);
      });
      ctx.restore();
    }
  };

  const centerTextPlugin = {
    id: 'centerText',
    afterDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      const arc = meta.data[0];
      if (!arc || !(arc.innerRadius >= 10)) return;
      const vals = chart.data.datasets[0].data;
      const visTotal = vals.reduce((s, v, k) => s + (chart.getDataVisibility(k) ? v : 0), 0);
      const active = chart.getActiveElements ? chart.getActiveElements() : [];
      const i = active.length ? active[0].index : null;
      let big, small, hint = '';
      if (i != null && chart.getDataVisibility(i)) {
        big = fmt(vals[i]);
        small = String(chart.data.labels[i]).toUpperCase();
        hint = visTotal > 0 ? `${(vals[i] / visTotal * 100).toFixed(1)}%` : '';
      } else {
        big = fmt(visTotal);
        small = 'TOTAL';
      }
      const ctx = chart.ctx;
      let size = Math.max(11, Math.min(22, arc.innerRadius * 0.42));
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${size}px "IBM Plex Mono", monospace`;
      while (ctx.measureText(big).width > arc.innerRadius * 1.6 && size > 9) {
        size -= 1;
        ctx.font = `700 ${size}px "IBM Plex Mono", monospace`;
      }
      const dy = hint ? size * 0.35 : size * 0.15;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(big, arc.x, arc.y + dy);
      ctx.font = `600 ${Math.max(7, size * 0.42)}px "IBM Plex Sans", sans-serif`;
      ctx.fillStyle = colors.text;
      ctx.fillText(small, arc.x, arc.y + dy - size * 0.95);
      if (hint) {
        ctx.fillStyle = colors.teal;
        ctx.font = `600 ${Math.max(8, size * 0.5)}px "IBM Plex Mono", monospace`;
        ctx.fillText(hint, arc.x, arc.y + dy + size * 0.95);
      }
      ctx.restore();
    }
  };

  /* ---------- cross-filtering helpers ---------- */
  function drillTo(scope, name) {
    const select = scope === 'Countries' ? $('countryFilter') : scope === 'Provinces' ? $('provinceFilter') : null;
    if (!select || select.disabled) return false;
    const want = normalizeBoundaryName(name);
    const option = Array.from(select.options).find(o => o.value && normalizeBoundaryName(o.value) === want);
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event('change'));
    return true;
  }
  function toggleMapMetric(key) {
    const select = $('mapMetric');
    if (!select) return;
    select.value = select.value === key ? 'total' : key;
    select.dispatchEvent(new Event('change'));
  }

  /* ---------- 1. growth curve ---------- */
  function renderTrend(data) {
    const canvas = $('trendChart');
    if (!canvas || !data.timeline) return;
    const full = [...data.timeline].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const selected = $('trendWindow') ? $('trendWindow').value : '14';
    const count = selected === 'all' ? full.length : (Number(selected) || 14);
    const start = Math.max(0, full.length - count);

    const fullCum = full.map(t => (Number(t.confirmed) || 0) + (Number(t.suspected) || 0) + (Number(t.probable) || 0));
    const fullNew = fullCum.map((v, i) => i === 0 ? null : Math.max(0, v - fullCum[i - 1]));
    const fullAvg = movingAverage(fullNew, 7);
    const fullGrowth = fullCum.map((v, i) => (i > 0 && fullCum[i - 1] > 0) ? (v - fullCum[i - 1]) / fullCum[i - 1] * 100 : null);

    const timeline = full.slice(start);
    const cum = fullCum.slice(start);
    const fresh = fullNew.slice(start);
    const avg = fullAvg.slice(start);
    const growth = fullGrowth.slice(start);
    const deaths = timeline.map(t => Number(t.deaths) || 0);

    const range = $('trendRange');
    if (range) {
      let text = timeline.length > 1
        ? `${timeline[0].date} → ${timeline[timeline.length - 1].date} · ${timeline.length}/${full.length} reports`
        : timeline.length === 1 ? `${timeline[0].date} · more snapshots needed` : 'No dated snapshots';
      const g = growthSummary(timeline, cum);
      if (g) text += ` · ${g}`;
      if (data.geographyFilter) text += ' · national history';
      range.textContent = text;
      range.title = text;
    }

    let peak = -1, peakValue = 0;
    fresh.forEach((v, i) => { if (v != null && v > peakValue) { peakValue = v; peak = i; } });
    const peakIndex = timeline.length > 3 && peakValue > 0 ? peak : null;

    const areaFill = ctx => {
      const chart = ctx.chart;
      const area = chart.chartArea;
      if (!area) return 'rgba(84,183,166,0.13)';
      const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
      g.addColorStop(0, 'rgba(84,183,166,0.38)');
      g.addColorStop(1, 'rgba(84,183,166,0.02)');
      return g;
    };
    const shortNames = ['New', 'Cases', 'Deaths', '7-rpt avg'];

    const signature = JSON.stringify([timeline.map(t => t.date), cum, fresh, avg, growth, deaths, prefs.trendLog, ZOOM_AVAILABLE]);
    const chart = mountChart('trend', canvas, signature, () => ({
      type: 'line',
      data: {
        labels: timeline.map(t => t.date),
        datasets: [
          {
            type: 'bar', label: 'New since prior report', data: fresh,
            backgroundColor: 'rgba(233,196,106,0.26)', hoverBackgroundColor: 'rgba(233,196,106,0.55)',
            borderWidth: 0, borderRadius: 2, maxBarThickness: 18, yAxisID: 'yDaily', order: 3
          },
          {
            type: 'line', label: 'Cumulative reported cases', data: cum,
            borderColor: colors.teal, backgroundColor: areaFill, borderWidth: 2.5,
            pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: colors.teal,
            pointHoverBorderColor: PANEL_BG, pointHoverBorderWidth: 2,
            tension: 0.25, fill: true, yAxisID: 'y', order: 2
          },
          {
            type: 'line', label: 'Cumulative deaths', data: deaths,
            borderColor: colors.red, borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 4,
            tension: 0.25, fill: false, yAxisID: 'y', order: 1, hidden: true
          },
          {
            type: 'line', label: '7-report avg (new)', data: avg,
            borderColor: colors.yellow, borderWidth: 1.6, borderDash: [4, 3],
            pointRadius: 0, pointHoverRadius: 3, tension: 0.35, fill: false,
            yAxisID: 'yDaily', order: 0
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        onResize: (chart, size) => { chart.options.plugins.legend.display = size.width >= 250 || size.height >= 130; },
        animation: REDUCED ? false : { duration: 650, easing: 'easeOutQuart' },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 7, maxRotation: 0 } },
          y: {
            type: prefs.trendLog ? 'logarithmic' : 'linear',
            beginAtZero: false, position: 'left',
            grid: { color: 'rgba(54,65,70,0.7)' },
            ticks: { precision: 0, maxTicksLimit: 5, callback: v => fmt(v) }
          },
          yDaily: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { precision: 0, maxTicksLimit: 4 } }
        },
        plugins: {
          legend: { display: canvas.parentElement.clientWidth >= 250 || canvas.parentElement.clientHeight >= 130, position: 'top', align: 'start', labels: {
            boxWidth: 8, boxHeight: 8, usePointStyle: true, padding: 6, font: { size: 9 },
            generateLabels: c => Chart.defaults.plugins.legend.labels.generateLabels(c).map(item => ({
              ...item, text: c.width < 650 ? shortNames[item.datasetIndex] : item.text
            }))
          } },
          trendMarkers: { peak: peakIndex },
          tooltip: Object.assign({}, tooltipBase, {
            position: 'growthLine', xAlign: 'left', yAlign: 'bottom', caretPadding: 20,
            padding: 8, titleMarginBottom: 3, bodySpacing: 2, footerMarginTop: 4,
            boxWidth: 7, boxHeight: 7, usePointStyle: true,
            titleFont: { size: 10, weight: '600' }, bodyFont: { size: 9 }, footerFont: { size: 9, weight: '600' },
            callbacks: {
              title: items => items.length ? `Report date: ${items[0].label}` : '',
              label: item => {
                const name = shortNames[item.datasetIndex] || item.dataset.label;
                return item.raw == null ? ` ${name}: —` : ` ${name}: ${fmt(item.raw, item.datasetIndex === 3 ? 1 : 0)}`;
              },
              footer: items => {
                const g = items.length ? growth[items[0].dataIndex] : null;
                return g == null ? '' : `Growth: ${g >= 0 ? '+' : ''}${g.toFixed(1)}% vs prior report`;
              }
            }
          }),
          zoom: ZOOM_AVAILABLE ? {
            limits: { x: { min: 'original', max: 'original', minRange: 3 } },
            pan: { enabled: true, mode: 'x', modifierKey: 'shift', onPanComplete: ({ chart }) => syncZoomPill(chart) },
            zoom: {
              mode: 'x',
              drag: { enabled: true, backgroundColor: 'rgba(84,183,166,0.18)', borderColor: colors.teal, borderWidth: 1 },
              pinch: { enabled: true },
              onZoomComplete: ({ chart }) => syncZoomPill(chart)
            }
          } : undefined
        }
      },
      plugins: [crosshairPlugin, trendMarkersPlugin]
    }), 'lines');

    setLabel(canvas, timeline.length
      ? `Growth curve. ${fmt(cum[cum.length - 1])} reported cases as of ${timeline[timeline.length - 1].date}.`
      : 'Growth curve. No dated snapshots available.');
    syncZoomPill(chart);
  }

  function syncZoomPill(chart) {
    const pill = $('trendZoomPill');
    if (!pill) return;
    const zoomed = !!(chart && chart.isZoomedOrPanned && chart.isZoomedOrPanned());
    pill.classList.toggle('show', zoomed);
  }

  /* ---------- 2. geographic bars ---------- */
  function renderBar(data) {
    const canvas = $('barChart');
    if (!canvas || !data.provinces) return;
    const geography = geographicRanking(data);
    const stats = geography.records;
    $('geoTitle').textContent = `Geographic Impact — ${geography.scope}`;
    const metric = activeMapMetric();
    const geoEmpty = $('geoEmpty');
    const metricAvailable = !geography.availableMetrics || geography.availableMetrics.includes(metric.key);
    const hasGeography = stats.length > 0 && metricAvailable;
    canvas.hidden = !hasGeography;
    geoEmpty.hidden = hasGeography;
    geoEmpty.textContent = hasGeography ? '' : metricAvailable
      ? 'No structured public subnational dataset is available for this country.'
      : `${metric.label} is not reported in the available health-zone dataset.`;
    syncDrillPill(data);
    if (!hasGeography) { destroyChart('bar'); return; }

    const limit = $('geoLimit') ? $('geoLimit').value : 'all';
    const byValueDesc = (a, b) => mapMetricValue(b, metric) - mapMetricValue(a, metric);
    const ranked = [...stats].sort(byValueDesc);
    const limitCount = Number(limit);
    const picked = (limit === 'all' || !(limitCount > 0)) ? ranked : ranked.slice(0, limitCount);
    const labelOf = p => geographicLabel(p, geography.scope);
    const sorters = {
      desc: byValueDesc,
      asc: (a, b) => -byValueDesc(a, b),
      alpha: (a, b) => labelOf(a).localeCompare(labelOf(b))
    };
    const shown = [...picked].sort(sorters[prefs.barSort] || sorters.desc);
    const labels = shown.map(labelOf);
    const values = shown.map(p => mapMetricValue(p, metric));
    const ranks = shown.map(p => ranked.indexOf(p) + 1);
    const total = ranked.reduce((s, p) => s + mapMetricValue(p, metric), 0);
    const baseColors = values.map(v => getRiskColor(v));
    const drillable = geography.scope === 'Countries' || geography.scope === 'Provinces';

    const signature = JSON.stringify([labels, values, ranks, total, metric.key, prefs.barSort, limit, geography.scope, data.geographyFilter]);
    const chart = mountChart('bar', canvas, signature, () => ({
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: metric.label,
          data: values,
          backgroundColor: ctx => {
            const base = baseColors[ctx.dataIndex];
            const h = ctx.chart.$hover;
            return (h == null || h === ctx.dataIndex) ? base : hexA(base, 0.38);
          },
          borderRadius: 3,
          borderSkipped: false,
          barPercentage: 0.82,
          categoryPercentage: 0.9
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: REDUCED ? false : { duration: 600, easing: 'easeOutQuart' },
        layout: { padding: { right: 38 } },
        interaction: { mode: 'nearest', axis: 'y', intersect: false },
        onHover: (event, elements, c) => {
          const idx = elements.length ? elements[0].index : null;
          c.canvas.style.cursor = drillable && elements.length ? 'pointer' : 'default';
          if (c.$hover !== idx) { c.$hover = idx; c.update('none'); }
        },
        onClick: (event, elements) => {
          if (!elements.length || !drillable) return;
          drillTo(geography.scope, labels[elements[0].index]);
        },
        plugins: {
          legend: { display: false },
          barLabels: { total },
          // Tooltips stay off in the compact panel (as before) and switch on when
          // the panel is enlarged; hover focus + inline labels cover the compact view.
          tooltip: Object.assign({}, tooltipBase, {
            enabled: !!(document.querySelector('.bar-panel') && document.querySelector('.bar-panel').classList.contains('is-expanded')),
            displayColors: false, caretPadding: 8, padding: 10,
            titleFont: { size: 12, weight: '600' }, bodyFont: { size: 11 }, footerFont: { size: 10 },
            callbacks: {
              title: items => items.length ? items[0].label : '',
              label: item => `${metric.label}: ${fmt(item.parsed.x)}`,
              afterLabel: item => `${total > 0 ? `Share: ${(item.parsed.x / total * 100).toFixed(1)}%  ·  ` : ''}Rank #${ranks[item.dataIndex]}`,
              footer: () => drillable ? 'Click to drill down' : ''
            }
          })
        },
        scales: {
          x: { grid: { color: 'rgba(54,65,70,0.7)' }, ticks: { callback: v => fmt(v) } },
          y: { grid: { display: false } }
        }
      },
      plugins: [barLabelsPlugin]
    }));

    chart.$clearHover = () => { if (chart.$hover != null) { chart.$hover = null; chart.update('none'); } };
    if (!canvas.$hoverBound) {
      canvas.$hoverBound = true;
      canvas.addEventListener('mouseleave', () => {
        const c = chartInstances.bar;
        if (c && c.$clearHover) c.$clearHover();
      });
    }
    setLabel(canvas, `Use the country and province selectors to drill down with the keyboard. ${metric.label} by ${geography.scope.toLowerCase()}. Highest: ${labels[values.indexOf(Math.max(...values))] || 'none'}.`);
  }

  function syncDrillPill(data) {
    const pill = $('geoDrillPill');
    if (!pill) return;
    const f = data.geographyFilter || {};
    const active = f.province || f.country;
    pill.classList.toggle('show', !!active);
    pill.textContent = active ? `✕ ${active}` : '';
    pill.title = active ? 'Clear this filter and go back up a level' : '';
  }

  /* ---------- 3. caseload doughnut ---------- */
  function renderDoughnut(data) {
    const canvas = $('doughnutChart');
    if (!canvas || !data.totals) return;
    const t = data.totals;
    const values = [Number(t.confirmed) || 0, Number(t.suspected) || 0, Number(t.probable) || 0];
    $('caseloadDeaths').textContent = `${fmt(t.deaths)} reported deaths · included in case classifications`;
    syncSliceControls();
    const names = ['Confirmed', 'Suspected', 'Probable'];
    const palette = [colors.teal, colors.yellow, colors.blue];
    const mapKeys = ['confirmed', null, null];
    const visibleTotal = chart => values.reduce((s, v, i) => s + (chart.getDataVisibility(i) ? v : 0), 0);

    const signature = JSON.stringify([values]);
    const chart = mountChart('doughnut', canvas, signature, () => ({
      type: 'doughnut',
      data: {
        labels: names,
        datasets: [{
          label: 'Cases', data: values, backgroundColor: palette,
          borderColor: PANEL_BG, borderWidth: 2, hoverBorderColor: PANEL_BG,
          hoverOffset: 7, borderRadius: 3, spacing: 1
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '64%',
        onResize: (chart, size) => {
          chart.options.plugins.legend.display = size.width >= 240;
          chart.options.layout.padding = size.height < 100 ? 2 : 8;
        },
        layout: { padding: canvas.parentElement.clientHeight < 100 ? 2 : 8 },
        animation: REDUCED ? false : { animateRotate: true, animateScale: true, duration: 700, easing: 'easeOutQuart' },
        onHover: (event, elements, c) => {
          const key = elements.length ? mapKeys[elements[0].index] : null;
          c.canvas.style.cursor = key ? 'pointer' : 'default';
        },
        onClick: (event, elements) => {
          if (!elements.length) return;
          const key = mapKeys[elements[0].index];
          if (key) toggleMapMetric(key);
        },
        plugins: {
          tooltip: Object.assign({}, tooltipBase, {
            padding: 8, displayColors: true, usePointStyle: true,
            titleFont: { size: 11, weight: '600' }, bodyFont: { size: 10 }, footerFont: { size: 9 },
            callbacks: {
              label: c => {
                const tot = visibleTotal(c.chart);
                return ` ${c.label}: ${fmt(c.raw)} (${tot > 0 ? (c.raw / tot * 100).toFixed(1) : 0}%)`;
              },
              footer: items => items.length && mapKeys[items[0].dataIndex] ? 'Click to colour the map by this' : ''
            }
          }),
          legend: {
            display: canvas.parentElement.clientWidth >= 240,
            position: 'right', align: 'center',
            labels: {
              boxWidth: 10, boxHeight: 10, padding: 8, color: '#fff', font: { size: 11, weight: '600' },
              generateLabels: c => names.map((name, i) => {
                const vis = c.getDataVisibility(i);
                const tot = visibleTotal(c);
                return {
                  text: `${name}: ${vis ? (tot > 0 ? (values[i] / tot * 100).toFixed(1) : '0.0') + '%' : 'hidden'}`,
                  fillStyle: palette[i], strokeStyle: palette[i], lineWidth: 0,
                  hidden: !vis, index: i, fontColor: vis ? '#fff' : '#6b7785'
                };
              })
            }
          }
        }
      },
      plugins: [centerTextPlugin]
    }), 'slices');

    setLabel(canvas, `Caseload breakdown: ${names.map((n, i) => `${n} ${fmt(values[i])}`).join(', ')}.`);
    return chart;
  }

  /* ---------- the replacement renderCharts ---------- */
  function renderCharts(data) {
    if (!window.Chart || !data) return;
    renderTrend(data);
    renderBar(data);
    renderDoughnut(data);
  }
  window.renderCharts = renderCharts;

  /* ---------- export helpers ---------- */
  function stamp() { return new Date().toISOString().slice(0, 10); }
  function download(href, filename) {
    const a = document.createElement('a');
    a.href = href; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function exportPng(chart, name) {
    const src = chart.canvas;
    const out = document.createElement('canvas');
    out.width = src.width; out.height = src.height;
    const c = out.getContext('2d');
    c.fillStyle = PANEL_BG; c.fillRect(0, 0, out.width, out.height);
    c.drawImage(src, 0, 0);
    download(out.toDataURL('image/png'), `ebola-${name}-${stamp()}.png`);
  }
  function exportCsv(chart, name, firstColumn) {
    const sets = chart.data.datasets;
    const rows = [[firstColumn, ...sets.map(d => d.label || 'value')]];
    chart.data.labels.forEach((label, i) => rows.push([label, ...sets.map(d => (d.data[i] == null ? '' : d.data[i]))]));
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    download(url, `ebola-${name}-${stamp()}.csv`);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /* ---------- ⋯ menus, chips, double-click reset ---------- */
  const openMenus = [];
  function closeMenus(restoreFocus = false) {
    openMenus.splice(0).forEach(({ menu, button }) => { menu.classList.remove('open'); button.setAttribute('aria-expanded', 'false'); if (restoreFocus) button.focus(); });
  }

  function setupTools() {
    if (document.querySelector('.chart-tools-btn')) return;
    const specs = [
      {
        panel: '.trend-panel', key: 'trend', file: 'growth-curve', column: 'date',
        hint: ZOOM_AVAILABLE ? 'Drag to zoom · Shift+drag to pan · double-click to reset' : 'Pick a range with the selector above',
        extra: () => [
          { label: 'Log scale', checked: prefs.trendLog, run: () => { prefs.trendLog = !prefs.trendLog; savePrefs(); rerender(); } }
        ].concat(ZOOM_AVAILABLE ? [{ label: 'Reset zoom', run: c => { c?.resetZoom('none'); syncZoomPill(c); }, needsChart: true }] : [])
      },
      {
        panel: '.bar-panel', key: 'bar', file: 'geographic-impact', column: 'area',
        hint: 'Click a bar to drill into that area',
        extra: () => [{
          label: `Sort: ${SORT_LABELS[prefs.barSort]}`,
          run: () => { prefs.barSort = SORT_ORDER[(SORT_ORDER.indexOf(prefs.barSort) + 1) % SORT_ORDER.length]; savePrefs(); rerender(); }
        }]
      },
      {
        panel: '.doughnut-panel', key: 'doughnut', file: 'caseload-breakdown', column: 'status',
        hint: 'Click Confirmed to colour the map · legend toggles slices',
        extra: () => ['Confirmed', 'Suspected', 'Probable'].map((label, i) => ({
          label: `Show ${label} (${fmt(chartInstances.doughnut?.data.datasets[0].data[i])})`, checked: chartInstances.doughnut?.getDataVisibility(i) ?? true,
          needsChart: true,
          run: c => { c.toggleDataVisibility(i); c.update('none'); }
        })).concat([{ label: 'Toggle deaths on map', run: () => toggleMapMetric('deaths') }])
      }
    ];

    specs.forEach(spec => {
      const panel = document.querySelector(spec.panel);
      const expandBtn = panel && panel.querySelector('[data-expand-chart]');
      if (!panel || !expandBtn) return;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chart-expand-btn chart-tools-btn';
      button.setAttribute('aria-label', 'Chart options');
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4"></circle><circle cx="12" cy="12" r="1.4"></circle><circle cx="19" cy="12" r="1.4"></circle></svg>';

      const host = expandBtn.parentElement;
      if (host && host.classList.contains('trend-controls')) {
        host.insertBefore(button, expandBtn);
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'chart-actions';
        expandBtn.replaceWith(wrap);
        wrap.append(button, expandBtn);
      }

      const menu = document.createElement('div');
      menu.className = 'chart-menu';
      menu.setAttribute('role', 'menu');
      panel.appendChild(menu);

      const build = () => {
        menu.textContent = '';
        const chart = chartInstances[spec.key];
        const items = spec.extra().concat([
          { label: 'Export PNG', run: c => exportPng(c, spec.file), needsChart: true },
          { label: 'Export CSV', run: c => exportCsv(c, spec.file, spec.column), needsChart: true }
        ]);
        items.forEach(item => {
          const b = document.createElement('button');
          b.type = 'button';
          b.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
          if (item.checked !== undefined) b.setAttribute('aria-checked', String(item.checked));
          const label = document.createElement('span');
          label.textContent = item.label;
          b.appendChild(label);
          if (item.checked !== undefined) {
            const mark = document.createElement('span');
            mark.className = 'check';
            mark.textContent = item.checked ? '✓' : '';
            b.appendChild(mark);
          }
          if (item.needsChart && !chart) b.disabled = true;
          b.addEventListener('click', () => { closeMenus(true); item.run(chartInstances[spec.key]); syncSliceControls(); });
          menu.appendChild(b);
        });
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = spec.hint;
        menu.appendChild(hint);
      };

      button.addEventListener('click', event => {
        event.stopPropagation();
        const wasOpen = menu.classList.contains('open');
        closeMenus();
        if (wasOpen) return;
        build();
        menu.classList.add('open');
        button.setAttribute('aria-expanded', 'true');
        openMenus.push({ menu, button });
        const first = menu.querySelector('button:not(:disabled)');
        if (first) first.focus();
      });
      menu.addEventListener('click', event => event.stopPropagation());
      menu.addEventListener('keydown', event => {
        const buttons = Array.from(menu.querySelectorAll('button:not(:disabled)'));
        const index = buttons.indexOf(document.activeElement);
        const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length
          : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
        if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenus(true); }
        if (event.key === 'Tab') closeMenus();
      });
    });

    document.addEventListener('click', closeMenus);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenus(true); });

    // zoom reset chip + double-click on the growth curve
    const trendControls = document.querySelector('.trend-panel .trend-controls');
    if (trendControls && ZOOM_AVAILABLE) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.id = 'trendZoomPill';
      pill.className = 'chart-pill';
      pill.textContent = 'Reset zoom';
      pill.addEventListener('click', () => {
        const c = chartInstances.trend;
        if (c) { c.resetZoom('none'); syncZoomPill(c); }
      });
      trendControls.insertBefore(pill, trendControls.firstChild);
      const canvas = $('trendChart');
      if (canvas) {
        canvas.addEventListener('dblclick', () => {
          const c = chartInstances.trend;
          if (c) { c.resetZoom('none'); syncZoomPill(c); }
        });
      }
    }

    // drill-up chip on the geographic chart
    const barControls = document.querySelector('.bar-panel .trend-controls');
    if (barControls) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.id = 'geoDrillPill';
      pill.className = 'chart-pill';
      pill.addEventListener('click', () => {
        const province = $('provinceFilter');
        const country = $('countryFilter');
        const target = province && province.value ? province : country;
        if (!target) return;
        target.value = '';
        target.dispatchEvent(new Event('change'));
      });
      barControls.insertBefore(pill, barControls.firstChild);
    }
  }

  function syncSliceControls() {
    const host = $('caseloadControls');
    if (!host || host.childElementCount) return;
    ['Confirmed', 'Suspected', 'Probable'].forEach((label, i) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = label; button.setAttribute('aria-pressed', 'true');
      button.addEventListener('click', () => {
        const c = chartInstances.doughnut;
        if (!c) return;
        c.toggleDataVisibility(i); c.update('none');
      });
      host.appendChild(button);
    });
  }
  Chart.register({ id: 'accessibleSliceState', afterUpdate(chart) {
    if (chart.canvas.id !== 'doughnutChart') return;
    document.querySelectorAll('#caseloadControls button').forEach((b, i) => b.setAttribute('aria-pressed', String(chart.getDataVisibility(i))));
  }});
  setupTools();
  // If dashboard.js already rendered before this file loaded, redraw with the new layer.
  if (typeof currentDashboardData !== 'undefined' && currentDashboardData) rerender();
})();

document.getElementById('caseloadMapDeaths').addEventListener('click', () => {
  const select = document.getElementById('mapMetric');
  select.value = select.value === 'deaths' ? 'total' : 'deaths';
  select.dispatchEvent(new Event('change'));
});

// Share the original filter controls so chart view uses the same state/events.
(() => {
  const button = document.getElementById('chartsViewToggle');
  const toolbar = document.getElementById('chartsViewFilters');
  const controls = ['mapMetric', 'countryFilter', 'provinceFilter'].map(id => {
    const element = document.getElementById(id);
    const home = document.createComment(`${id} home`);
    element.before(home);
    return { element, home };
  });
  function setChartsView(enabled) {
    document.body.classList.toggle('charts-view', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    button.textContent = enabled ? 'Back to map' : 'Charts view';
    toolbar.hidden = !enabled;
    controls.forEach(({ element, home }) => enabled ? toolbar.appendChild(element) : home.after(element));
    requestAnimationFrame(() => {
      Object.values(chartInstances).forEach(chart => chart.resize());
      if (!enabled && map) map.resize();
    });
  }
  button.addEventListener('click', () => setChartsView(!document.body.classList.contains('charts-view')));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !document.body.classList.contains('charts-view')) return;
    if (document.body.classList.contains('chart-modal-open') || document.querySelector('.chart-menu.open')) return;
    setChartsView(false);
    button.focus();
  }, true);
})();
