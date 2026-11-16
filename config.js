// Free public services used by Common Ground. Swap these for your own servers if you outgrow them.
window.CG_CONFIG = {
  // OSRM routing. The public demo server is free for light use; please be kind to it.
  osrmUrl: 'https://router.project-osrm.org',
  // UK postcode lookups (free, no key).
  postcodesUrl: 'https://api.postcodes.io',
  // OpenStreetMap address search (free, max 1 request per second).
  nominatimUrl: 'https://nominatim.openstreetmap.org',
  // Map tiles.
  tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxPeople: 30,
  // Minimum gap between requests to each shared free service (ms).
  osrmGapMs: 350,
  nominatimGapMs: 1100,
};
