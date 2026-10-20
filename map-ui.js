/* Map presentation controls share the existing filters, bounds and map state. */
(() => {
  const toolbar = document.querySelector('.map-mode-toggle');
  const options = document.getElementById('mapOptions');
  const content = options.querySelector('.map-options-content');
  const panel = document.querySelector('.map-panel');
  const info = document.getElementById('info-panel');
  const surface = document.createElement('div');
  surface.className = 'map-surface';
  ['map', 'mapActionStatus', 'info-panel'].forEach(id => surface.appendChild(document.getElementById(id)));
  surface.appendChild(panel.querySelector('.map-legend'));
  panel.appendChild(surface);
  const syncToolbar = () => panel.style.setProperty('--map-toolbar-bottom', `${toolbar.getBoundingClientRect().bottom + 6}px`);
  new ResizeObserver(syncToolbar).observe(toolbar);
  const footer = document.querySelector('.update-bar');
  const syncFooter = () => panel.style.setProperty('--map-footer-height', `${footer.offsetHeight}px`);
  new ResizeObserver(syncFooter).observe(footer);
  syncFooter();
  window.addEventListener('resize', syncToolbar);
  syncToolbar();
  const closeInfo = () => { info.style.display = 'none'; };
  options.addEventListener('toggle', () => { if (options.open) closeInfo(); });
  const detailLabel = content.querySelector('.map-admin-label');
  detailLabel.appendChild(document.getElementById('adminLevel'));
  toolbar.querySelectorAll('[data-map-mode]').forEach(button => content.querySelector('.map-display-modes').appendChild(button));
  const playback = toolbar.querySelector('button[disabled]');
  if (playback) {
    const note = document.createElement('p');
    note.className = 'map-options-note';
    note.textContent = 'Historical map playback is unavailable for this dataset.';
    content.appendChild(note);
    playback.remove();
  }
  const originals = new Map();
  // Only these background layers are adjusted; surveillance layers are untouched.
  const country = /^place_country_/;
  const local = /^(place_(other|suburb|village|town|city|city_large|state)|water_name|highway_name_other|highway_name_motorway)$/;
  window.applyMapPresentation = (styleReloaded = false) => {
    if (!map) return;
    if (styleReloaded) originals.clear();
    const detailed = document.getElementById('mapDetailedLabels').checked;
    (map.getStyle()?.layers || []).forEach(layer => {
      let property, cleaned;
      if (layer.type === 'symbol' && (country.test(layer.id) || local.test(layer.id))) {
        property = 'text-opacity';
        cleaned = country.test(layer.id)
          ? ['interpolate', ['linear'], ['zoom'], 3, .45, 7, .8, 11, 1]
          : ['interpolate', ['linear'], ['zoom'], 5, 0, 7, .45, 11, .85];
      } else if (layer.id === 'boundary_state' && layer.type === 'line') {
        property = 'line-opacity';
        cleaned = ['interpolate', ['linear'], ['zoom'], 3, .12, 8, .4];
      } else return;
      if (!originals.has(layer.id)) originals.set(layer.id, map.getPaintProperty(layer.id, property) ?? null);
      map.setPaintProperty(layer.id, property, detailed ? originals.get(layer.id) : cleaned);
    });
  };
  document.getElementById('mapDetailedLabels').addEventListener('change', () => window.applyMapPresentation());
  if (map?.isStyleLoaded()) window.applyMapPresentation();
  function announce(text) { document.getElementById('mapActionStatus').textContent = text; }
  document.getElementById('fitAffectedAreas').addEventListener('click', () => {
    if (!map || !mapExtentBounds || mapExtentBounds.isEmpty()) {
      announce('Affected-area boundaries are still loading.'); return;
    }
    fitOutbreakExtent();
    announce('Showing affected areas for the current geography selection.');
  });
  document.getElementById('resetMapView').addEventListener('click', () => {
    if (map) {
      map.easeTo({ center: [25, 0], zoom: 4, bearing: 0, pitch: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 },
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 600 });
      announce('Overview restored. Geography filters are unchanged.');
    }
    options.open = false;
    options.querySelector('summary').focus();
  });
  document.addEventListener('click', event => {
    if (!options.contains(event.target)) options.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && options.open) {
      options.open = false;
      options.querySelector('summary').focus();
      event.preventDefault();
    } else if (event.key === 'Escape' && info.style.display === 'block') {
      closeInfo();
      document.getElementById('map').querySelector('canvas')?.focus();
    }
  });
})();
