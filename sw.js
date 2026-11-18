/* ==========================================================================
   sw.js — offline support for the Vocab Explorer (no build step)
   - App shell (index.html, features.js/css, data_extras.js, manifest, icons):
     cache-first, precached on install.
   - data_level_N.js (~1.7 MB each): stale-while-revalidate, cached as they are
     used (or all at once via 「下載全部離線使用」 on the 我的 page).
   - Google Fonts: cache-first runtime cache.
   DEPLOYING AN UPDATE: bump VERSION below. Browsers re-check sw.js on every
   visit; the new worker precaches the new shell, the page then shows
   「有新版本，點此更新」 and reloads once after the user taps it.
   ========================================================================== */
const VERSION = 'b-f292403fdf';
const SHELL_CACHE = 'vx-shell-' + VERSION;
const DATA_CACHE = 'vx-data-v1';        // keep in sync with features.js (DATA_CACHE)
const FONT_CACHE = 'vx-fonts-v1';
const KEEP = [SHELL_CACHE, DATA_CACHE, FONT_CACHE];
const SHELL = [
    './',
    'index.html',
    'features.js',
    'features.css',
    'data_extras.js',
    'manifest.webmanifest',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/icon-maskable-512.png',
    'icons/apple-touch-icon.png'
];
const DATA_RE = /\/data_level_[3-6]\.js$/;

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then(cache => Promise.all(SHELL.map(u =>
                // data_extras.js is optional: one missing file must not break the install
                cache.add(new Request(u, { cache: 'reload' })).catch(err => {
                    if (u !== 'data_extras.js') throw err;
                }))))
            .then(() => {
                // First install: take over right away so offline works on the next reload.
                // Updates wait until the page asks (SKIP_WAITING) — see features.js.
                if (!self.registration.active) return self.skipWaiting();
            })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k.indexOf('vx-') === 0 && KEEP.indexOf(k) < 0).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function staleWhileRevalidate(event, cacheName) {
    const req = event.request;
    return caches.open(cacheName).then(cache => cache.match(req, { ignoreSearch: true }).then(cached => {
        const network = fetch(req).then(res => {
            if (res && res.ok) return cache.put(req, res.clone()).then(() => res);
            return res;
        });
        if (cached) {
            event.waitUntil(network.catch(() => { /* offline: keep the cached copy */ }));
            return cached;
        }
        return network;
    }));
}

function cacheFirst(req, cacheName, opts) {
    return caches.match(req, opts).then(cached => cached || fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(cacheName).then(c => c.put(req, copy));
        }
        return res;
    }));
}

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    if (url.origin !== self.location.origin) {
        if (/(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
            event.respondWith(cacheFirst(req, FONT_CACHE));
        }
        return;
    }
    if (DATA_RE.test(url.pathname)) {
        event.respondWith(staleWhileRevalidate(event, DATA_CACHE));
        return;
    }
    const scopePath = new URL(self.registration.scope).pathname;
    if (req.mode === 'navigate' && (url.pathname === scopePath || url.pathname === scopePath + 'index.html')) {
        // the app is a single page: serve the cached shell (works offline, ignores ?query/#hash)
        event.respondWith(
            caches.match('index.html', { ignoreSearch: true })
                .then(cached => cached || fetch(req))
                .catch(() => caches.match('./'))
        );
        return;
    }
    if (req.mode === 'navigate') return;   // any other page: plain network
    // other same-origin files (shell assets, icons, manifest): cache-first
    event.respondWith(cacheFirst(req, SHELL_CACHE, { ignoreSearch: true }));
});
