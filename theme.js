/* theme.js — light / dark / auto theme switch.
   Loaded synchronously in <head> (before the stylesheets) so the right theme
   is applied before first paint. Setting: localStorage 'fx_theme' =
   'auto' | 'light' | 'dark' (default 'auto'). Dark styles: theme-dark.css. */
(function () {
    'use strict';
    var KEY = 'fx_theme';
    var MODES = ['auto', 'light', 'dark'];
    var ICONS = { auto: '🌓', light: '☀️', dark: '🌙' };
    var LABELS = { auto: '自動', light: '淺色', dark: '深色' };
    var META = { light: '#1F4E78', dark: '#0b1424' };
    var root = document.documentElement;
    var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

    function get() {
        var m = null;
        try { m = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
        return MODES.indexOf(m) >= 0 ? m : 'auto';
    }

    function resolved(mode) {
        if (mode === 'light' || mode === 'dark') return mode;
        return mq && mq.matches ? 'dark' : 'light';
    }

    function setMeta(theme) {
        var meta = document.querySelector('meta[name="theme-color"]');
        if (!meta) {
            meta = document.createElement('meta');
            meta.name = 'theme-color';
            (document.head || root).appendChild(meta);
        }
        meta.setAttribute('content', META[theme]);
    }

    function updateButton(mode) {
        var btn = document.querySelector('.fx-theme-btn');
        if (!btn) return;
        btn.textContent = ICONS[mode];
        btn.title = '主題：' + LABELS[mode] + '（點擊切換：自動／淺色／深色）';
        btn.setAttribute('aria-label', '主題：' + LABELS[mode]);
    }

    function apply() {
        var mode = get();
        var theme = resolved(mode);
        var changed = root.dataset.theme && root.dataset.theme !== theme;
        // Switch instantly: many elements have `transition: all`, which would
        // otherwise animate every colour for 250 ms after a theme change.
        if (changed) root.classList.add('fx-theme-switching');
        root.dataset.theme = theme;
        root.style.colorScheme = theme;
        setMeta(theme);
        updateButton(mode);
        if (changed) {
            if (document.body) void getComputedStyle(document.body).color; // flush styles
            var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
            raf(function () { raf(function () { root.classList.remove('fx-theme-switching'); }); });
        }
    }

    function set(mode) {
        if (MODES.indexOf(mode) < 0) mode = 'auto';
        try { localStorage.setItem(KEY, mode); } catch (e) { /* ignore */ }
        apply();
        return mode;
    }

    function cycle() {
        return set(MODES[(MODES.indexOf(get()) + 1) % MODES.length]);
    }

    apply();

    if (mq) {
        var onChange = function () { if (get() === 'auto') apply(); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    }
    // keep several open tabs in sync
    window.addEventListener('storage', function (e) { if (e.key === KEY) apply(); });

    // base style for the header button (both themes; dark tweaks live in theme-dark.css)
    var css = '.fx-theme-btn{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;' +
        'width:36px;height:36px;padding:0;border-radius:50%;border:1px solid var(--border-color);' +
        'background:#f1f5f9;font-size:17px;line-height:1;cursor:pointer;-webkit-tap-highlight-color:transparent}' +
        '.fx-theme-btn:hover{background:var(--secondary)}' +
        '.fx-theme-btn:focus-visible{outline:2px solid var(--highlight-neon);outline-offset:2px}' +
        '@media (max-width:768px){.fx-theme-btn{width:34px;height:34px;font-size:16px;border-radius:10px}}' +
        '.fx-theme-btn.fx-nofit{display:none}' +
        'html.fx-theme-switching *,html.fx-theme-switching *::before,html.fx-theme-switching *::after{transition:none!important}';
    var st = document.createElement('style');
    st.id = 'fx-theme-style';
    st.textContent = css;
    (document.head || root).appendChild(st);

    function injectButton() {
        if (document.querySelector('.fx-theme-btn')) return;
        var header = document.querySelector('header');
        if (!header) return;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fx-theme-btn';
        btn.addEventListener('click', function () { cycle(); });
        var anchor = document.getElementById('gami-header');
        if (anchor && anchor.parentNode === header) header.insertBefore(btn, anchor);
        else header.appendChild(btn);
        updateButton(get());
        fitButton();
        window.addEventListener('resize', fitButton);
        if (anchor && window.MutationObserver) {
            new MutationObserver(fitButton).observe(anchor, { childList: true, subtree: true, characterData: true });
        }
    }

    // The one-row mobile header (☰ · 6000 單 · 3|4|5|6 · 🔥) has no spare room on
    // narrow phones. If adding the button would squeeze the title, hide it there;
    // the setting stays reachable through window.FXTheme (e.g. from the 我的 page).
    var fitQueued = false;
    function fitButton() {
        if (fitQueued) return;
        fitQueued = true;
        (window.requestAnimationFrame || setTimeout)(function () {
            fitQueued = false;
            var btn = document.querySelector('.fx-theme-btn');
            var h1 = document.querySelector('.header-logo h1');
            var header = document.querySelector('header');
            if (!btn || !h1 || !header) return;
            btn.classList.remove('fx-nofit');
            if (!window.matchMedia('(max-width: 768px)').matches) return;
            var logo = h1.closest('.header-logo') || h1.parentElement;
            if (h1.scrollWidth > logo.clientWidth + 1 || header.scrollWidth > header.clientWidth + 1) {
                btn.classList.add('fx-nofit');
            }
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButton);
    else injectButton();

    window.FXTheme = { get: get, set: set, cycle: cycle, resolved: function () { return resolved(get()); } };
})();
