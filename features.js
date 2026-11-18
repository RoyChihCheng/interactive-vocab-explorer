/* ==========================================================================
   features.js — interactive add-ons for the Vocab Explorer
   (Quiz mode, gamification + spaced review, sentence building, shadowing,
    word-family / collocation games, rapid battle, deep links, sharing,
    flashcard swipe, exam-frequency stars, confusables panel)

   Loaded AFTER the main app <script> in index.html. It wraps a few global
   functions of the main app (selectWord, selectChapter, switchMode, ...)
   instead of editing them, and stores everything in localStorage.
   Optional data fields are feature-detected: examples[i].zh / .sense,
   chinese_sentence_en, exam, and the global CONFUSABLES (data_extras.js).
   Plain ES2017, no libraries.
   ========================================================================== */
(function () {
    'use strict';

    const INTERVALS = [1, 3, 7, 14];          // spaced-review stages D1/D3/D7/D14
    const ROUND_SIZE = 10;
    const RAPID_SECONDS = 60;
    const COLLOC_PAIRS = 6;
    const TYPE_LABELS = { cloze: '克漏字填空', mc: '學測式四選一', listen: '聽音拼字' };
    const POS_BUCKETS = [
        { pos: 'n.', label: '名詞 n.' },
        { pos: 'v.', label: '動詞 v.' },
        { pos: 'adj.', label: '形容詞 adj.' },
        { pos: 'adv.', label: '副詞 adv.' }
    ];
    const BADGE_DEFS = {
        half: { icon: '🥈', label: '掌握 50%' },
        full: { icon: '🏆', label: '全章掌握' },
        perfect: { icon: '💯', label: '完美挑戰' }
    };

    // ------------------------------------------------------------------
    // Small utilities
    // ------------------------------------------------------------------
    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function shuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
    }
    function pad2(n) { return n < 10 ? '0' + n : '' + n; }
    function dateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
    function addDays(n) { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return dateStr(d); }
    function today() { return addDays(0); }
    function lsGet(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
    function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota / private mode */ } }
    function wkey(w) { return String(w.word).toLowerCase(); }
    function levelData() { return getActiveLevelData(); }
    function chapterWords(ch) { const c = ch || currentChapter; return levelData().filter(w => w.chapter === c); }
    function chIndex(ch) { return CHAPTER_ORDER.indexOf(ch || currentChapter); }
    function currentMode() { const b = document.querySelector('.mode-btn.active'); return b ? b.id.replace('mode-', '') : 'codex'; }
    function hasTTS() { return 'speechSynthesis' in window; }
    function SpeechRec() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }
    function normAnswer(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?;:"]+$/, ''); }
    function getConfusables() {
        try { if (typeof CONFUSABLES !== 'undefined' && CONFUSABLES) return CONFUSABLES; } catch (e) { /* not loaded */ }
        return window.CONFUSABLES || null;
    }

    // ------------------------------------------------------------------
    // Headword forms + locating the headword token inside an example
    // ------------------------------------------------------------------
    // "announce(ment)" -> [announce, announcement]; "laboratory/lab" -> [laboratory, lab]
    function headForms(word) {
        const out = [];
        String(word).split('/').forEach(p => {
            p = p.trim();
            const m = p.match(/^(.*?)\((\w+)\)$/);
            if (m) { out.push(m[1].trim()); out.push((m[1] + m[2]).trim()); } else out.push(p);
        });
        return out.map(s => s.toLowerCase()).filter(Boolean);
    }
    function commonPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
    // > 0 if `tok` looks like the headword or a regular inflection/derivation of it
    function tokenScore(tok, forms) {
        const t = tok.toLowerCase();
        let best = 0;
        forms.forEach(f => {
            if (!f || /\s/.test(f)) return;
            if (t === f) { best = Math.max(best, 100); return; }
            const c = commonPrefix(t, f);
            const need = f.length <= 3 ? f.length : Math.min(f.length - 1, 6);
            if (c >= need && t.length <= f.length + 5) best = Math.max(best, c);
        });
        return best;
    }
    // Returns {token, start, end} of the headword-form token (searching ex.target first).
    function findBlank(word, ex) {
        if (!ex || !ex.en) return null;
        const en = ex.en, forms = headForms(word.word);
        const scan = (s, e) => {
            const re = /[A-Za-z]+/g, sub = en.slice(s, e);
            let m, best = null, bs = 0;
            while ((m = re.exec(sub))) {
                const sc = tokenScore(m[0], forms);
                if (sc > bs) { bs = sc; best = { token: m[0], start: s + m.index, end: s + m.index + m[0].length }; }
            }
            return best;
        };
        if (ex.target) {
            const i = en.toLowerCase().indexOf(String(ex.target).toLowerCase());
            if (i >= 0) { const r = scan(i, i + ex.target.length); if (r) return r; }
        }
        return scan(0, en.length);
    }
    // Sentence HTML with the example's target phrase highlighted
    function highlightedSentence(word, ex, cls) {
        cls = cls || 'highlight';
        const en = ex.en || '';
        let s = -1, e = -1;
        if (ex.target) { s = en.toLowerCase().indexOf(String(ex.target).toLowerCase()); if (s >= 0) e = s + ex.target.length; }
        if (s < 0) { const b = findBlank(word, ex); if (b) { s = b.start; e = b.end; } }
        if (s < 0) return esc(en);
        return esc(en.slice(0, s)) + '<span class="' + cls + '">' + esc(en.slice(s, e)) + '</span>' + esc(en.slice(e));
    }
    // Highlight every token of free text that is a form of the headword
    function markHeadword(text, word) {
        const forms = headForms(word.word);
        let used = false;
        const html = esc(text).replace(/[A-Za-z]+/g, t => {
            if (tokenScore(t, forms) > 0) { used = true; return '<mark class="fx-hw">' + t + '</mark>'; }
            return t;
        });
        return { html: html, used: used };
    }

    // ------------------------------------------------------------------
    // Distractors (same level & POS, prefer same chapter) with matching inflection
    // ------------------------------------------------------------------
    function suffixType(ans, forms) {
        const a = ans.toLowerCase();
        if (forms.indexOf(a) >= 0) return '';
        if (/ing$/.test(a) && !forms.some(f => /ing$/.test(f))) return 'ing';
        if (/ed$/.test(a) && !forms.some(f => /ed$/.test(f))) return 'ed';
        if (/ly$/.test(a) && !forms.some(f => /ly$/.test(f))) return 'ly';
        if (/s$/.test(a) && !forms.some(f => /s$/.test(f))) return 's';
        return '';
    }
    function inflect(b, type) {
        const consY = /[^aeiou]y$/;
        switch (type) {
            case 'ing': if (/ie$/.test(b)) return b.slice(0, -2) + 'ying'; if (/[^e]e$/.test(b)) return b.slice(0, -1) + 'ing'; return b + 'ing';
            case 'ed': if (/e$/.test(b)) return b + 'd'; if (consY.test(b)) return b.slice(0, -1) + 'ied'; return b + 'ed';
            case 's': if (/(s|x|z|ch|sh)$/.test(b)) return b + 'es'; if (consY.test(b)) return b.slice(0, -1) + 'ies'; return b + 's';
            case 'ly': if (/le$/.test(b)) return b.slice(0, -1) + 'y'; if (consY.test(b)) return b.slice(0, -1) + 'ily'; return b + 'ly';
            default: return b;
        }
    }
    function matchCase(src, s) { return /^[A-Z]/.test(src) ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
    function primaryPos(p) { return String(p || '').split('/')[0].trim(); }
    function pickDistractors(word, answer, n) {
        const data = levelData(), forms = headForms(word.word), st = suffixType(answer, forms);
        const seen = new Set([answer.toLowerCase()]);
        forms.forEach(f => seen.add(f));
        const tiers = [
            w => w.pos === word.pos && w.chapter === word.chapter,
            w => w.pos === word.pos,
            w => primaryPos(w.pos) === primaryPos(word.pos),
            () => true
        ];
        const out = [];
        for (let ti = 0; ti < tiers.length && out.length < n; ti++) {
            const cands = shuffle(data.filter(w => w !== word && tiers[ti](w)));
            for (let ci = 0; ci < cands.length && out.length < n; ci++) {
                const base = headForms(cands[ci].word)[0];
                if (!base || /[^a-z\-]/.test(base)) continue;
                const opt = matchCase(answer, inflect(base, st));
                const l = opt.toLowerCase();
                if (seen.has(l)) continue;
                seen.add(l);
                out.push(opt);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------
    // Gamification store (per level) + global daily streak
    // ------------------------------------------------------------------
    function gKey() { return 'gami_level_' + currentLevel; }
    function G() {
        const g = lsGet(gKey(), null) || {};
        g.xp = g.xp || 0; g.badges = g.badges || {}; g.srs = g.srs || {};
        g.collocBest = g.collocBest || {}; g.wfDone = g.wfDone || {}; g.sentDone = g.sentDone || {};
        return g;
    }
    function saveG(g) { lsSet(gKey(), g); renderHeader(); }
    function streakData() { return lsGet('gami_streak', { last: null, count: 0 }); }
    function currentStreak() {
        const s = streakData();
        return (s.last === today() || s.last === addDays(-1)) ? s.count : 0;
    }
    function recordActivity() {
        const s = streakData(), t = today();
        if (s.last === t) return;
        s.count = (s.last === addDays(-1)) ? s.count + 1 : 1;
        s.last = t;
        lsSet('gami_streak', s);
        renderHeader();
        if (s.count > 1) toast('🔥 連續學習第 <b>' + s.count + '</b> 天！');
    }
    function addXP(n) {
        if (!n) return;
        const g = G(); g.xp += n; saveG(g);
        recordActivity();
        floatXP(n);
    }
    // Spaced review: correct moves a stage up (D1→D3→D7→D14); wrong → back to D1.
    function srsUpdate(word, correct) {
        const g = G(), k = wkey(word);
        const e = g.srs[k] || { stage: 0, due: null };
        if (correct) {
            // only advance when not scheduled yet or actually due (no early cramming)
            if (!e.due || e.due <= today()) {
                e.stage = Math.min(e.stage + 1, INTERVALS.length);
                e.due = addDays(INTERVALS[e.stage - 1]);
            }
        } else {
            e.stage = 1;
            e.due = addDays(INTERVALS[0]);
        }
        g.srs[k] = e;
        saveG(g);
    }
    function dueWords() {
        const srs = G().srs, t = today();
        return levelData().filter(w => { const e = srs[wkey(w)]; return e && e.due && e.due <= t; });
    }
    function checkBadges(silent) {
        const g = G(), mastered = new Set(getMasteredList()), newly = [];
        CHAPTER_ORDER.forEach(ch => {
            const ws = chapterWords(ch);
            if (!ws.length) return;
            const pct = ws.filter(w => mastered.has(wkey(w))).length / ws.length;
            const b = g.badges[ch] = g.badges[ch] || {};
            if (pct >= 0.5 && !b.half) { b.half = today(); newly.push([ch, 'half']); }
            if (pct >= 1 && !b.full) { b.full = today(); newly.push([ch, 'full']); }
        });
        if (newly.length) {
            saveG(g);
            if (!silent) newly.forEach(x => celebrateBadge(x[0], x[1]));
        }
    }
    function awardBadge(ch, type) {
        const g = G(), b = g.badges[ch] = g.badges[ch] || {};
        if (b[type]) return false;
        b[type] = today(); saveG(g);
        celebrateBadge(ch, type);
        return true;
    }
    function celebrateBadge(ch, type) {
        const d = BADGE_DEFS[type];
        toast(d.icon + ' 獲得徽章：Chapter ' + (chIndex(ch) + 1) + ' ' + esc(CHAPTER_INFO[ch].zh) + '「' + d.label + '」', 3500);
        confetti();
        beep(true);
    }
    function badgeIcons(ch) {
        const b = G().badges[ch] || {};
        return Object.keys(BADGE_DEFS).filter(k => b[k]).map(k => '<span title="' + BADGE_DEFS[k].label + '">' + BADGE_DEFS[k].icon + '</span>').join('');
    }

    function renderHeader() {
        const el = $('gami-header');
        if (!el) return;
        const g = G(), due = dueWords().length;
        el.innerHTML =
            '<button class="gami-chip gami-xp" id="gami-xp-chip" title="Level ' + currentLevel + ' 累積經驗值 (XP)" onclick="FX.openQuiz()">⚡ <b>' + g.xp + '</b> XP</button>' +
            '<span class="gami-chip gami-streak" title="連續學習天數（每天至少完成一次練習）">🔥 <b>' + currentStreak() + '</b> 天</span>' +
            '<button class="gami-chip gami-due' + (due ? ' has-due' : '') + '" title="今日待複習單字" onclick="FX.openQuiz(\'review\')">📅 <span class="gami-label">待複習</span> <b>' + due + '</b></button>';
    }

    // ------------------------------------------------------------------
    // Sound, confetti, toasts
    // ------------------------------------------------------------------
    let actx = null;
    function isMuted() { return localStorage.getItem('fx_muted') === '1'; }
    function beep(ok) {
        if (isMuted()) return;
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            actx = actx || new AC();
            if (actx.state === 'suspended') actx.resume();
            const notes = ok ? [660, 880] : [240, 170];
            notes.forEach((f, i) => {
                const o = actx.createOscillator(), g = actx.createGain();
                o.type = ok ? 'sine' : 'square';
                o.frequency.value = f;
                const t = actx.currentTime + i * 0.11;
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(ok ? 0.18 : 0.06, t + 0.02);
                g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
                o.connect(g); g.connect(actx.destination);
                o.start(t); o.stop(t + 0.2);
            });
        } catch (e) { /* audio not available */ }
    }
    function confetti() {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const c = document.createElement('canvas');
        c.className = 'fx-confetti';
        document.body.appendChild(c);
        const W = c.width = window.innerWidth, H = c.height = window.innerHeight;
        const ctx = c.getContext('2d');
        const colors = ['#1F4E78', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7'];
        const ps = [];
        for (let i = 0; i < 140; i++) {
            ps.push({
                x: W / 2 + (Math.random() - 0.5) * W * 0.4, y: H * 0.3,
                vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 4,
                s: 5 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
                c: colors[i % colors.length]
            });
        }
        const start = performance.now(), DUR = 2600;
        function frame(t) {
            const el = t - start;
            ctx.clearRect(0, 0, W, H);
            ps.forEach(p => {
                p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
                ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
                ctx.globalAlpha = Math.max(0, 1 - el / DUR);
                ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
                ctx.restore();
            });
            if (el < DUR) requestAnimationFrame(frame); else c.remove();
        }
        requestAnimationFrame(frame);
    }
    function toast(html, ms) {
        const t = document.createElement('div');
        t.className = 'fx-toast';
        t.innerHTML = html;
        document.body.appendChild(t);
        requestAnimationFrame(() => t.classList.add('show'));
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 350); }, ms || 2600);
    }
    function floatXP(n) {
        const chip = $('gami-xp-chip');
        const f = document.createElement('div');
        f.className = 'fx-xp-float';
        f.textContent = '+' + n + ' XP';
        if (chip) {
            const r = chip.getBoundingClientRect();
            f.style.left = (r.left + r.width / 2) + 'px';
            f.style.top = (r.bottom + 4) + 'px';
        }
        document.body.appendChild(f);
        setTimeout(() => f.remove(), 1200);
    }

    // ------------------------------------------------------------------
    // Exam frequency stars
    // ------------------------------------------------------------------
    let examCache = { key: null, t1: 0, t2: 0 };
    function examTertiles() {
        const data = levelData();
        if (examCache.key === data) return examCache;
        const counts = data.map(w => (w.exam && w.exam.count) || 0).filter(c => c > 0).sort((a, b) => a - b);
        const q = p => counts.length ? counts[Math.min(counts.length - 1, Math.floor(p * counts.length))] : 0;
        examCache = { key: data, t1: q(1 / 3), t2: q(2 / 3) };
        return examCache;
    }
    function starCount(count, word) {
        // Same rule as the printed workbook: stars by number of past papers (of 45) containing the word
        const ex = word && word.exam;
        if (ex && typeof ex.stars === 'number') return ex.stars;
        if (!count) return 0;
        const t = examTertiles();
        if (count <= t.t1) return 1;
        if (count <= t.t2) return 2;
        return 3;
    }
    function starsText(n) { return '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n); }

    // ------------------------------------------------------------------
    // Codex enhancements (run after the original selectWord)
    // ------------------------------------------------------------------
    function enhanceCodex(word) {
        // 1. Exam stars in header
        const starEl = $('codex-exam-stars');
        if (starEl) {
            if (word.exam && typeof word.exam.count === 'number') {
                const n = word.exam.count;
                starEl.style.display = 'inline-flex';
                starEl.textContent = starsText(starCount(n, word));
                starEl.title = '歷屆學測／指考試卷出現 ' + (word.exam.papers || 0) + ' 份（共 45 份）';
            } else {
                starEl.style.display = 'none';
            }
        }

        // 2. Exam example sentence in meaning pane
        const old = $('fx-exam-section');
        if (old) old.remove();
        if (word.exam && word.exam.example) {
            const sec = document.createElement('div');
            sec.className = 'info-section';
            sec.id = 'fx-exam-section';
            const ex = { en: word.exam.example, target: '' };
            sec.innerHTML =
                '<h4 class="info-section-title">📜 歷屆考題例句 (Past Exam)</h4>' +
                '<div class="fx-exam-card"><p class="example-en">' + highlightedSentence(word, ex) + '</p>' +
                (word.exam.source ? '<span class="fx-exam-source">— ' + esc(word.exam.source) + '</span>' : '') +
                '<span class="fx-exam-count">歷屆考題出現 ' + esc(word.exam.count) + ' 次</span></div>';
            $('pane-meaning').appendChild(sec);
        }

        // 3. Example cards: safe audio binding + 跟讀 (shadowing)
        const cards = document.querySelectorAll('#codex-examples-container .example-card');
        cards.forEach((card, idx) => {
            const ex = (word.examples || [])[idx];
            if (!ex) return;
            const audio = card.querySelector('.example-audio-btn');
            if (audio) { audio.removeAttribute('onclick'); audio.onclick = () => speakSentence(ex.en); }
            const bar = document.createElement('div');
            bar.className = 'fx-shadow-bar';
            bar.innerHTML = '<button class="fx-shadow-btn" type="button" title="跟著唸，語音辨識評分">🎤 <span>跟讀</span></button><div class="fx-shadow-result"></div>';
            const btn = bar.querySelector('button'), res = bar.querySelector('.fx-shadow-result');
            btn.onclick = () => startShadowing(btn, ex.en, res);
            card.appendChild(bar);
        });

        // 4. 造句練習 card
        const oldS = $('fx-sentence-card');
        if (oldS) oldS.remove();
        if (word.chinese_sentence) {
            const drafts = lsGet('sentences_level_' + currentLevel, {});
            const sec = document.createElement('div');
            sec.className = 'info-section';
            sec.id = 'fx-sentence-card';
            sec.innerHTML =
                '<h4 class="info-section-title">✍️ 造句練習 (Sentence Building)</h4>' +
                '<div class="note-card fx-sentence">' +
                '<span class="fx-small-muted">請用「<b>' + esc(word.word) + '</b>」（或其變化形）把下面的中文句子翻成英文：</span>' +
                '<div class="fx-zh-prompt">' + esc(word.chinese_sentence) + '</div>' +
                '<div class="note-input-container"><textarea id="fx-sentence-input" placeholder="在此寫下你的英文句子..."></textarea>' +
                '<button class="save-note-btn" type="button" onclick="FX.checkSentence()">對照參考答案</button></div>' +
                '<div id="fx-sentence-result" class="fx-sentence-result"></div></div>';
            const grammar = $('codex-grammar-section');
            grammar.parentNode.insertBefore(sec, grammar);
            const ta = $('fx-sentence-input');
            ta.value = drafts[wkey(word)] || '';
            ta.addEventListener('input', () => {
                const d = lsGet('sentences_level_' + currentLevel, {});
                d[wkey(word)] = ta.value;
                lsSet('sentences_level_' + currentLevel, d);
            });
        }

        // 5. Word-family drag & drop game
        const oldG = $('fx-wf-game-section');
        if (oldG) oldG.remove();
        const items = usableFamily(word);
        if (items.length >= 2) {
            const sec = document.createElement('div');
            sec.className = 'info-section';
            sec.id = 'fx-wf-game-section';
            $('pane-family').appendChild(sec);
            renderFamilyGame(sec, word);
        }
    }

    function checkSentence() {
        const w = currentWord;
        if (!w) return;
        const ta = $('fx-sentence-input'), out = $('fx-sentence-result');
        const text = ta.value.trim();
        if (!text) { out.innerHTML = '<p class="fx-warn">請先寫下你的英文句子，再對照參考答案。</p>'; return; }
        const r = markHeadword(text, w);
        let html = '<div class="fx-sent-row"><span class="fx-sent-label">你的句子</span><p>' + r.html + '</p></div>';
        html += r.used
            ? '<p class="fx-good">✔ 很好！你有用到目標字「' + esc(w.word) + '」（或其變化形）。</p>'
            : '<p class="fx-bad">✘ 還沒有用到目標字「' + esc(w.word) + '」或其變化形，試著把它放進句子裡吧！</p>';
        if (w.chinese_sentence_en) {
            const ref = markHeadword(w.chinese_sentence_en, w);
            html += '<div class="fx-sent-row fx-ref"><span class="fx-sent-label">參考答案</span><p>' + ref.html + '</p></div>';
        } else {
            html += '<p class="fx-small-muted">（此單字暫無參考答案，可請老師協助批改。）</p>';
        }
        out.innerHTML = html;
        if (r.used) {
            beep(true);
            const g = G();
            if (!g.sentDone[wkey(w)]) { g.sentDone[wkey(w)] = today(); saveG(g); addXP(5); } else recordActivity();
        } else {
            beep(false);
            recordActivity();
        }
    }

    // ------------------------------------------------------------------
    // 跟讀 (shadowing) with SpeechRecognition
    // ------------------------------------------------------------------
    let activeRec = null;
    // hyphens are dropped so "check-out" matches a recognizer's "checkout"
    function speechWords(s) { return (String(s).toLowerCase().replace(/[’‘]/g, "'").replace(/-/g, '').match(/[a-z0-9']+/g) || []); }
    function compareSpeech(expected, said) {
        const a = speechWords(expected), b = speechWords(said);
        const dp = [];
        for (let i = 0; i <= a.length; i++) { dp.push(new Array(b.length + 1).fill(0)); }
        for (let i = a.length - 1; i >= 0; i--) {
            for (let j = b.length - 1; j >= 0; j--) {
                dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        const matched = new Array(a.length).fill(false);
        let i = 0, j = 0;
        while (i < a.length && j < b.length) {
            if (a[i] === b[j]) { matched[i] = true; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
        }
        const n = matched.filter(Boolean).length;
        return { pct: a.length ? Math.round(n / a.length * 100) : 0, missed: a.filter((x, k) => !matched[k]), words: a, matched: matched };
    }
    function renderShadowResult(res, expected, said) {
        const r = compareSpeech(expected, said);
        const cls = r.pct >= 85 ? 'fx-good' : (r.pct >= 60 ? 'fx-mid' : 'fx-bad');
        const wordsHtml = r.words.map((w, k) => '<span class="' + (r.matched[k] ? 'sw-ok' : 'sw-miss') + '">' + esc(w) + '</span>').join(' ');
        res.innerHTML =
            '<div class="fx-shadow-score ' + cls + '">' + r.pct + '%</div>' +
            '<div class="fx-shadow-detail"><div class="fx-small-muted">辨識結果：「' + esc(said) + '」</div>' +
            '<div class="fx-shadow-words">' + wordsHtml + '</div>' +
            (r.missed.length ? '<div class="fx-small-muted">漏讀／不清楚的字：<b>' + esc(r.missed.join(', ')) + '</b></div>' : '<div class="fx-good">完美跟讀！</div>') +
            '</div>';
        beep(r.pct >= 60);
        recordActivity();
        return r;
    }
    function startShadowing(btn, sentence, res) {
        const R = SpeechRec();
        if (!R) {
            res.innerHTML = '<p class="fx-warn">⚠️ 你的瀏覽器不支援語音辨識（Firefox 與 iPhone/iPad 上的瀏覽器多半不支援）。建議改用電腦版或 Android 版的 Chrome / Edge。</p>';
            return;
        }
        if (activeRec) { try { activeRec.abort(); } catch (e) { /* ignore */ } activeRec = null; }
        let rec;
        try { rec = new R(); } catch (e) { res.innerHTML = '<p class="fx-warn">⚠️ 無法啟動語音辨識。</p>'; return; }
        activeRec = rec;
        rec.lang = 'en-US';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        btn.classList.add('listening');
        btn.querySelector('span').textContent = '聆聽中…';
        res.innerHTML = '<p class="fx-small-muted">請對著麥克風唸出這個例句。</p>';
        rec.onresult = e => {
            const said = e.results && e.results[0] && e.results[0][0] ? e.results[0][0].transcript : '';
            renderShadowResult(res, sentence, said);
        };
        rec.onerror = e => {
            const msg = e && (e.error === 'not-allowed' || e.error === 'service-not-allowed')
                ? '麥克風權限被拒絕，請在瀏覽器設定中允許使用麥克風。'
                : (e && e.error === 'no-speech' ? '沒有聽到聲音，請再試一次。' : '語音辨識發生問題，請再試一次。');
            res.innerHTML = '<p class="fx-warn">⚠️ ' + msg + '</p>';
        };
        rec.onend = () => {
            btn.classList.remove('listening');
            btn.querySelector('span').textContent = '跟讀';
            if (activeRec === rec) activeRec = null;
        };
        try { rec.start(); } catch (e) { rec.onend(); }
    }

    // ------------------------------------------------------------------
    // Word-family drag & drop / tap-to-place game
    // ------------------------------------------------------------------
    function parseFamily(str) {
        return String(str || '').split('·').map(s => s.trim()).filter(Boolean).map(item => {
            const m = item.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
            if (!m) return { text: item, pos: [] };
            const pos = (m[2].match(/\b(n|v|adj|adv)\./g) || []);
            return { text: m[1].trim(), pos: Array.from(new Set(pos)) };
        });
    }
    function usableFamily(w) { return parseFamily(w.word_family).filter(i => i.text && i.pos.length); }

    function renderFamilyGame(container, word) {
        const items = shuffle(usableFamily(word));
        container.innerHTML =
            '<h4 class="info-section-title">🧩 字族分類遊戲 (Word Family Sort)</h4>' +
            '<div class="fx-card wfg">' +
            '<p class="fx-small-muted">把衍生字拖到正確的詞性籃（手機：先點一下單字，再點詞性籃）。</p>' +
            '<div class="wfg-pool" data-pos="">' + items.map((it, i) =>
                '<span class="wfg-chip" draggable="true" data-i="' + i + '">' + esc(it.text) + '</span>').join('') + '</div>' +
            '<div class="wfg-buckets">' + POS_BUCKETS.map(b =>
                '<div class="wfg-bucket" data-pos="' + b.pos + '"><div class="wfg-bucket-label">' + b.label + '</div><div class="wfg-bucket-body"></div></div>').join('') + '</div>' +
            '<div class="wfg-actions"><button class="fx-btn" type="button" data-act="check">檢查答案</button><button class="fx-btn fx-btn-ghost" type="button" data-act="reset">重來</button></div>' +
            '<div class="wfg-msg"></div></div>';
        const root = container.querySelector('.wfg'), pool = root.querySelector('.wfg-pool');
        let selected = null;
        const chips = Array.from(root.querySelectorAll('.wfg-chip'));
        const select = chip => {
            chips.forEach(c => c.classList.remove('selected'));
            selected = (selected === chip) ? null : chip;
            if (selected) selected.classList.add('selected');
        };
        const place = (chip, zone) => {
            const body = zone.classList.contains('wfg-pool') ? zone : zone.querySelector('.wfg-bucket-body');
            body.appendChild(chip);
            chip.classList.remove('selected', 'ok', 'bad');
            selected = null;
            root.querySelector('.wfg-msg').innerHTML = '';
        };
        chips.forEach(chip => {
            chip.addEventListener('click', e => { e.stopPropagation(); select(chip); });
            chip.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', chip.dataset.i); e.dataTransfer.effectAllowed = 'move'; chip.classList.add('dragging'); });
            chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
        });
        Array.from(root.querySelectorAll('.wfg-bucket')).concat([pool]).forEach(zone => {
            zone.addEventListener('click', () => { if (selected) place(selected, zone); });
            zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
            zone.addEventListener('dragleave', () => zone.classList.remove('over'));
            zone.addEventListener('drop', e => {
                e.preventDefault(); zone.classList.remove('over');
                const chip = root.querySelector('.wfg-chip[data-i="' + e.dataTransfer.getData('text/plain') + '"]');
                if (chip) place(chip, zone);
            });
        });
        root.querySelector('[data-act="reset"]').onclick = () => renderFamilyGame(container, word);
        root.querySelector('[data-act="check"]').onclick = () => {
            let allOk = true, placed = 0;
            chips.forEach(chip => {
                const bucket = chip.closest('.wfg-bucket');
                chip.classList.remove('ok', 'bad');
                if (!bucket) { allOk = false; return; }
                placed++;
                const ok = items[+chip.dataset.i].pos.indexOf(bucket.dataset.pos) >= 0;
                chip.classList.add(ok ? 'ok' : 'bad');
                if (!ok) allOk = false;
            });
            const msg = root.querySelector('.wfg-msg');
            if (placed < chips.length) { msg.innerHTML = '<span class="fx-warn">還有 ' + (chips.length - placed) + ' 個字沒放進詞性籃喔！</span>'; beep(false); return; }
            if (allOk) {
                msg.innerHTML = '<span class="fx-good">✔ 全部正確！</span>';
                beep(true);
                const g = G();
                if (!g.wfDone[wkey(word)]) { g.wfDone[wkey(word)] = today(); saveG(g); addXP(10); confetti(); } else recordActivity();
            } else {
                msg.innerHTML = '<span class="fx-bad">紅色的字放錯了，點一下或拖曳重新放置。</span>';
                beep(false);
                recordActivity();
            }
        };
    }

    // ------------------------------------------------------------------
    // Quiz / challenge mode
    // ------------------------------------------------------------------
    const Q = {
        scope: 'chapter',
        types: lsGet('quiz_types', { cloze: true, mc: true, listen: true }),
        round: null, rapid: null, colloc: null, timers: []
    };
    function stopTimers() {
        Q.timers.forEach(t => clearInterval(t));
        Q.timers = [];
        if (Q.rapid) Q.rapid.over = true;
    }
    function quizRoot() { return $('quiz-view'); }
    function showQuizView() {
        ['landing-view-container', 'codex-detail-view', 'flashcard-arena-view'].forEach(id => { $(id).style.display = 'none'; });
        $('word-list-panel-element').style.display = 'none';
        $('collapsible-chapter-banner-container').style.display = 'none';
        quizRoot().style.display = 'flex';
    }

    function chapterLabel() {
        const i = chIndex();
        return 'Level ' + currentLevel + ' · Chapter ' + (i + 1) + ' · ' + esc(CHAPTER_INFO[currentChapter] ? CHAPTER_INFO[currentChapter].zh : '');
    }

    function renderHub() {
        stopTimers();
        Q.round = null;
        const due = dueWords().length;
        if (Q.scope === 'review' && !due) Q.scope = 'chapter';
        const chCount = chapterWords().length;
        const famCount = levelData().filter(w => usableFamily(w).length >= 2).length;
        const board = lsGet('rapid_board_level_' + currentLevel, []);
        const g = G();
        const best = g.collocBest[currentChapter];
        const typeChip = t => {
            const disabled = t === 'listen' && !hasTTS();
            return '<button type="button" class="fx-chip ' + (Q.types[t] && !disabled ? 'active' : '') + '" ' + (disabled ? 'disabled title="此瀏覽器不支援語音朗讀"' : '') +
                ' onclick="FX.toggleType(\'' + t + '\')">' + TYPE_LABELS[t] + '</button>';
        };
        quizRoot().innerHTML =
            '<div class="quiz-wrap">' +
            '<div class="quiz-hub-head"><div><div class="quiz-kicker">' + chapterLabel() + '</div><h2 class="quiz-title">⚡ 挑戰模式</h2></div>' +
            '<button class="fx-btn fx-btn-ghost" type="button" onclick="FX.toggleMute()">' + (isMuted() ? '🔇 音效關' : '🔊 音效開') + '</button></div>' +

            '<section class="fx-card"><h3 class="fx-card-title">📝 單字挑戰（每輪 ' + ROUND_SIZE + ' 題）</h3>' +
            '<div class="fx-row"><span class="fx-row-label">範圍</span>' +
            '<button type="button" class="fx-chip ' + (Q.scope === 'chapter' ? 'active' : '') + '" onclick="FX.setScope(\'chapter\')">本章單字（' + chCount + '）</button>' +
            '<button type="button" class="fx-chip ' + (Q.scope === 'review' ? 'active' : '') + '" ' + (due ? '' : 'disabled') + ' onclick="FX.setScope(\'review\')">📅 今日待複習（' + due + '）</button></div>' +
            '<div class="fx-row"><span class="fx-row-label">題型</span>' + typeChip('cloze') + typeChip('mc') + typeChip('listen') + '</div>' +
            '<button class="landing-btn" type="button" id="quiz-start-btn" onclick="FX.startRound()">開始挑戰</button>' +
            '<p class="fx-small-muted">答對 +10 XP（看提示後答對 +5）。答對的字依 D1→D3→D7→D14 排入複習；答錯會回到 D1（明天再複習）。' + (due ? '' : '今天沒有待複習的單字 🎉') + '</p></section>' +

            '<div class="fx-game-grid">' +
            '<section class="fx-card fx-game"><h3 class="fx-card-title">🔗 搭配詞配對</h3><p class="fx-small-muted">本章隨機 ' + COLLOC_PAIRS + ' 組搭配詞，英中配對，計時挑戰。' + (best ? '<br>最佳紀錄：<b>' + best.toFixed(1) + ' 秒</b>' : '') + '</p><button class="fx-btn" type="button" onclick="FX.startColloc()">開始配對</button></section>' +
            '<section class="fx-card fx-game"><h3 class="fx-card-title">⏱️ 單字快閃對戰</h3><p class="fx-small-muted">' + RAPID_SECONDS + ' 秒內看中文選英文，答越多越好！' + (board.length ? '<br>個人最佳：<b>' + board[0].score + ' 題</b>' : '') + '</p><button class="fx-btn" type="button" onclick="FX.startRapid()">開始對戰</button></section>' +
            (famCount ? '<section class="fx-card fx-game"><h3 class="fx-card-title">🧩 字族分類</h3><p class="fx-small-muted">把衍生字拖進正確詞性籃（本級共 ' + famCount + ' 組可玩）。</p><button class="fx-btn" type="button" onclick="FX.startFamily()">來一組</button></section>' : '') +
            '</div>' +

            '<section class="fx-card"><h3 class="fx-card-title">🗺️ 主題地圖</h3>' + themeMapHTML() + '</section>' +
            confusablesHTML() +
            '<section class="fx-card"><h3 class="fx-card-title">🏅 快閃對戰排行榜（Level ' + currentLevel + '，本機）</h3>' + leaderboardHTML(board, -1) + '</section>' +
            '</div>';
    }

    function themeMapHTML() {
        const mastered = new Set(getMasteredList());
        const srs = G().srs, t = today();
        const data = levelData();
        return '<div class="theme-map">' + CHAPTER_ORDER.map((ch, i) => {
            const ws = data.filter(w => w.chapter === ch);
            const n = ws.filter(w => mastered.has(wkey(w))).length;
            const pct = ws.length ? Math.round(n / ws.length * 100) : 0;
            const due = ws.filter(w => { const e = srs[wkey(w)]; return e && e.due && e.due <= t; }).length;
            return '<button type="button" class="tm-tile ' + (ch === currentChapter ? 'active' : '') + (pct >= 100 ? ' done' : '') + '" onclick="FX.gotoChapter(' + i + ')" title="' + esc(ch) + '">' +
                '<span class="tm-top"><span class="tm-num">' + (i + 1) + '</span><span class="tm-badges">' + badgeIcons(ch) + '</span></span>' +
                '<span class="tm-zh">' + esc(CHAPTER_INFO[ch].zh) + '</span>' +
                '<span class="tm-bar"><i style="width:' + pct + '%"></i></span>' +
                '<span class="tm-meta">' + pct + '% 掌握' + (due ? ' · 📅' + due : '') + '</span></button>';
        }).join('') + '</div>';
    }

    function confusablesHTML() {
        const all = getConfusables();
        if (!all) return '';
        const groups = all['L' + currentLevel + '-C' + pad2(chIndex() + 1)];
        if (!groups || !groups.length) return '';
        return '<section class="fx-card fx-confusables"><h3 class="fx-card-title">⚠️ 易混字 (Confusables)</h3>' + groups.map(gr =>
            '<div class="cf-group"><div class="cf-words">' + (gr.words || []).map(w =>
                '<div class="cf-word"><div class="cf-head"><button type="button" class="cf-w" onclick="FX.openWord(\'' + esc(String(w.w || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")) + '\')">' + esc(w.w) + '</button>' +
                '<span class="cf-zh">' + esc(w.zh) + '</span></div>' + (w.ex ? '<p class="cf-ex">' + esc(w.ex) + '</p>' : '') + '</div>').join('') + '</div>' +
            (gr.tip ? '<div class="cf-tip">💡 ' + esc(gr.tip) + '</div>' : '') + '</div>').join('') + '</section>';
    }

    function leaderboardHTML(board, highlight) {
        if (!board.length) return '<p class="fx-small-muted">還沒有紀錄，快來挑戰吧！</p>';
        return '<ol class="fx-board">' + board.map((b, i) =>
            '<li class="' + (i === highlight ? 'me' : '') + '"><span class="fx-rank">' + ['🥇', '🥈', '🥉', '4', '5'][i] + '</span><b>' + b.score + ' 題</b><span class="fx-small-muted">' + esc(b.date) + '</span></li>').join('') + '</ol>';
    }

    // ---- round building
    function makeQuestion(w, type) {
        if (type === 'listen') {
            const forms = headForms(w.word).filter(f => /^[a-z\-]+$/.test(f));
            if (!forms.length) return null;
            const exI = (w.examples || []).findIndex(ex => ex && ex.en);
            return { type: type, word: w, answer: forms[0], accept: forms, ex: exI >= 0 ? w.examples[exI] : null };
        }
        const opts = (w.examples || []).map(ex => ({ ex: ex, b: findBlank(w, ex) })).filter(o => o.b);
        if (!opts.length) return null;
        const o = opts[Math.floor(Math.random() * opts.length)];
        const q = { type: type, word: w, ex: o.ex, blank: o.b, answer: o.b.token, accept: [o.b.token.toLowerCase()] };
        if (type === 'mc') {
            const d = pickDistractors(w, o.b.token, 3);
            if (d.length < 3) return null;
            q.options = shuffle([o.b.token].concat(d));
        }
        return q;
    }
    function buildRound(scope) {
        const pool = scope === 'review' ? dueWords() : chapterWords();
        let types = Object.keys(TYPE_LABELS).filter(t => Q.types[t] && (t !== 'listen' || hasTTS()));
        if (!types.length) types = ['mc'];
        const qs = [];
        const words = shuffle(pool);
        for (let i = 0; i < words.length && qs.length < ROUND_SIZE; i++) {
            const tps = shuffle(types);
            for (let k = 0; k < tps.length; k++) {
                const q = makeQuestion(words[i], tps[k]);
                if (q) { qs.push(q); break; }
            }
        }
        return qs;
    }
    function startRound() {
        stopTimers();
        const qs = buildRound(Q.scope);
        if (!qs.length) { toast('這個範圍沒有可出題的單字。'); return; }
        Q.round = { qs: qs, i: 0, xp: 0, scope: Q.scope, chapter: currentChapter };
        renderQuestion();
    }
    function blankedSentence(q) {
        const en = q.ex.en;
        const n = q.answer.length;
        return esc(en.slice(0, q.blank.start)) + '<span class="q-blank" title="' + n + ' 個字母">' + '＿'.repeat(Math.min(Math.max(n, 4), 10)) + '</span>' + esc(en.slice(q.blank.end));
    }
    function renderQuestion() {
        const r = Q.round, q = r.qs[r.i];
        const pct = Math.round(r.i / r.qs.length * 100);
        const score = r.qs.filter(x => x.done && x.correct).length;
        let body = '';
        if (q.type === 'listen') {
            body =
                '<p class="quiz-instr">聽發音，拼出這個單字：</p>' +
                '<div class="quiz-listen-btns"><button type="button" class="quiz-big-sound" onclick="FX.replay(0.85)" title="再聽一次">🔊</button>' +
                '<button type="button" class="fx-btn fx-btn-ghost" onclick="FX.replay(0.55)">🐢 慢速</button></div>' +
                '<p class="fx-small-muted quiz-meta">' + esc(q.word.pos) + ' · ' + q.answer.length + ' 個字母</p>';
        } else {
            body =
                '<p class="quiz-instr">' + (q.type === 'mc' ? '選出最適合填入空格的字：' : '在空格中填入正確的單字（注意時態／詞形）：') + '</p>' +
                '<p class="quiz-sentence">' + blankedSentence(q) + '</p>' +
                '<p class="fx-small-muted quiz-meta">' + esc(q.word.pos) + (q.type === 'cloze' ? ' · ' + q.answer.length + ' 個字母' : '') +
                (q.type === 'cloze' ? ' · <button type="button" class="fx-link" id="quiz-gloss-btn" onclick="FX.showGloss()">看中文提示（XP 減半）</button>' : '') + '</p>' +
                '<p class="quiz-gloss" id="quiz-gloss" style="display:none;"></p>';
        }
        let answerArea;
        if (q.type === 'mc') {
            answerArea = '<div class="quiz-options">' + q.options.map((o, i) =>
                '<button type="button" class="quiz-opt" data-opt="' + esc(o) + '" onclick="FX.answerMC(this)"><span class="quiz-opt-key">(' + 'ABCD'[i] + ')</span> ' + esc(o) + '</button>').join('') + '</div>';
        } else {
            answerArea = '<div class="quiz-input-row"><input type="text" id="quiz-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="輸入答案後按 Enter">' +
                '<button type="button" class="fx-btn" onclick="FX.submitTyped()">送出</button></div><p class="quiz-hint" id="quiz-hint"></p>';
        }
        quizRoot().innerHTML =
            '<div class="quiz-wrap quiz-play">' +
            '<div class="quiz-play-head"><span>' + (r.scope === 'review' ? '📅 今日複習' : chapterLabel()) + '</span>' +
            '<span class="quiz-type-tag">' + TYPE_LABELS[q.type] + '</span>' +
            '<button type="button" class="fx-link" onclick="FX.quitRound()">離開</button></div>' +
            '<div class="quiz-progress"><div class="progress-bar-bg"><div class="progress-bar-fill" style="width:' + pct + '%"></div></div>' +
            '<span>第 ' + (r.i + 1) + ' / ' + r.qs.length + ' 題 · 答對 ' + score + '</span></div>' +
            '<div class="fx-card quiz-card" id="quiz-card">' + body + answerArea + '<div class="quiz-feedback" id="quiz-feedback"></div></div></div>';
        const inp = $('quiz-input');
        if (inp) setTimeout(() => inp.focus(), 30);
        if (q.type === 'listen') setTimeout(() => speakWord(q.answer), 250);
    }
    function showGloss() {
        const r = Q.round; if (!r) return;
        const q = r.qs[r.i];
        q.usedGloss = true;
        const el = $('quiz-gloss');
        el.style.display = 'block';
        el.innerHTML = '中文提示：' + esc(q.word.chinese);
        const b = $('quiz-gloss-btn'); if (b) b.remove();
        const inp = $('quiz-input'); if (inp) inp.focus();
    }
    function submitTyped() {
        const inp = $('quiz-input');
        if (inp) submitAnswer(inp.value);
    }
    function answerMC(btn) { submitAnswer(btn.getAttribute('data-opt'), btn); }
    function submitAnswer(val, btn) {
        const r = Q.round; if (!r) return;
        const q = r.qs[r.i];
        if (q.done) return;
        if (q.type !== 'mc' && !normAnswer(val)) return;
        const ok = q.accept.indexOf(normAnswer(val)) >= 0;
        if (!ok && q.type !== 'mc' && !q.missed) {
            // one more try with the first letter shown
            q.missed = true;
            beep(false);
            const card = $('quiz-card');
            card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
            $('quiz-hint').innerHTML = '再試一次！提示：第一個字母是 <b>' + esc(q.answer.charAt(0)) + '</b>';
            const inp = $('quiz-input'); inp.value = ''; inp.focus();
            return;
        }
        q.done = true; q.correct = ok; q.given = val;
        q.firstTry = ok && !q.missed && !q.usedGloss;
        const xp = ok ? (q.firstTry ? 10 : 5) : 0;
        r.xp += xp;
        srsUpdate(q.word, q.firstTry);
        if (xp) addXP(xp); else recordActivity();
        beep(ok);
        // visual states
        const card = $('quiz-card');
        card.classList.add(ok ? 'is-correct' : 'is-wrong');
        if (q.type === 'mc') {
            document.querySelectorAll('.quiz-opt').forEach(b => {
                b.disabled = true;
                if (b.getAttribute('data-opt') === q.answer) b.classList.add('correct');
                else if (b === btn) b.classList.add('wrong');
            });
        } else {
            const inp = $('quiz-input'); inp.disabled = true;
            inp.classList.add(ok ? 'correct' : 'wrong');
        }
        const w = q.word;
        let fb = '<div class="quiz-verdict ' + (ok ? 'fx-good' : 'fx-bad') + '">' +
            (ok ? '✔ 答對了！' + (xp ? ' +' + xp + ' XP' : '') : '✘ 答錯了，正確答案是 <b>' + esc(q.answer) + '</b>') + '</div>';
        fb += '<div class="quiz-word-line"><b>' + esc(w.word) + '</b> <i>' + esc(w.pos) + '</i> ' + esc(w.kk || '') +
            ' <button type="button" class="fx-link" onclick="FX.say(\'' + esc(headForms(w.word)[0].replace(/'/g, "\\'")) + '\')">🔊</button> — ' + esc(w.chinese) + '</div>';
        if (q.ex) {
            fb += '<p class="quiz-full-sentence">' + highlightedSentence(w, q.ex) + '</p>';
            if (q.ex.zh) fb += '<p class="quiz-ex-zh">' + (q.ex.sense ? '<span class="example-sense-label">' + esc(q.ex.sense) + '</span> ' : '') + esc(q.ex.zh) + '</p>';
        }
        const last = r.i >= r.qs.length - 1;
        fb += '<button type="button" class="landing-btn quiz-next" id="quiz-next-btn" onclick="FX.nextQuestion()">' + (last ? '查看成績 ➜' : '下一題 ➜') + '</button>';
        const fbEl = $('quiz-feedback');
        fbEl.innerHTML = fb;
        fbEl.classList.add('show');
        setTimeout(() => { const n = $('quiz-next-btn'); if (n) n.focus(); }, 30);
    }
    function nextQuestion() {
        const r = Q.round; if (!r) return;
        if (r.i >= r.qs.length - 1) { renderSummary(); return; }
        r.i++;
        renderQuestion();
    }
    function renderSummary() {
        const r = Q.round;
        const correct = r.qs.filter(q => q.correct).length;
        const perfect = r.qs.every(q => q.firstTry);
        const wrong = r.qs.filter(q => !q.firstTry);
        let badgeMsg = '';
        if (perfect) {
            const awarded = r.scope === 'chapter' && r.qs.length >= 5 && awardBadge(r.chapter, 'perfect');
            if (awarded) badgeMsg = '<p class="fx-good">💯 獲得本章「完美挑戰」徽章！</p>';
            else confetti();   // awardBadge already fires confetti
        }
        quizRoot().innerHTML =
            '<div class="quiz-wrap"><div class="fx-card quiz-summary">' +
            '<div class="quiz-score-ring" style="--p:' + Math.round(correct / r.qs.length * 100) + '"><span>' + correct + '<small>/' + r.qs.length + '</small></span></div>' +
            '<h2 class="quiz-title">' + (perfect ? '🎉 完美！全部一次答對！' : (correct >= r.qs.length * 0.7 ? '👍 表現不錯！' : '💪 再接再厲！')) + '</h2>' +
            '<p class="fx-small-muted">本輪獲得 <b>' + r.xp + ' XP</b>　·　連續學習 <b>' + currentStreak() + '</b> 天</p>' + badgeMsg +
            (wrong.length ? '<h3 class="fx-card-title" style="margin-top:14px;">📒 錯題與提示後答對（已排入明天複習）</h3><ul class="quiz-mistakes">' + wrong.map(q =>
                '<li><div><b>' + esc(q.answer) + '</b> <i>' + esc(q.word.pos) + '</i> ' + esc(q.word.chinese) +
                '<div class="fx-small-muted">' + TYPE_LABELS[q.type] + '　你的答案：' + esc(q.given || '—') + '</div></div>' +
                '<button type="button" class="fx-link" onclick="FX.openWord(\'' + esc(q.word.word.replace(/'/g, "\\'")) + '\')">查看單字</button></li>').join('') + '</ul>' : '') +
            '<div class="fx-row" style="justify-content:center; margin-top:16px;"><button type="button" class="landing-btn" onclick="FX.startRound()">再來一輪</button>' +
            '<button type="button" class="fx-btn fx-btn-ghost" onclick="FX.renderHub()">返回挑戰首頁</button></div></div></div>';
        Q.round = null;
    }

    // ---- 單字快閃對戰 (rapid battle)
    function rapidQuestion() {
        const data = levelData();
        const w = data[Math.floor(Math.random() * data.length)];
        const others = shuffle(data.filter(x => x !== w && x.chinese !== w.chinese && primaryPos(x.pos) === primaryPos(w.pos)));
        const pool = others.length >= 3 ? others : shuffle(data.filter(x => x !== w && x.chinese !== w.chinese));
        const opts = shuffle([w].concat(pool.slice(0, 3)));
        return { word: w, options: opts };
    }
    function startRapid() {
        stopTimers();
        Q.rapid = { score: 0, combo: 0, answered: 0, end: Date.now() + RAPID_SECONDS * 1000, over: false, q: null, lock: false };
        quizRoot().innerHTML =
            '<div class="quiz-wrap quiz-play"><div class="quiz-play-head"><span>⏱️ 單字快閃對戰 · Level ' + currentLevel + '</span>' +
            '<span class="quiz-type-tag" id="rapid-score">0 題</span><button type="button" class="fx-link" onclick="FX.renderHub()">離開</button></div>' +
            '<div class="rapid-timer"><div class="rapid-timer-fill" id="rapid-fill"></div><span id="rapid-sec">' + RAPID_SECONDS + '</span></div>' +
            '<div class="fx-card quiz-card rapid-card"><p class="quiz-instr">選出符合中文意思的英文單字：</p>' +
            '<p class="rapid-gloss" id="rapid-gloss"></p><div class="quiz-options" id="rapid-opts"></div><p class="rapid-combo" id="rapid-combo"></p></div></div>';
        nextRapid();
        const tick = setInterval(() => {
            const R = Q.rapid; if (!R || R.over) { clearInterval(tick); return; }
            const left = Math.max(0, R.end - Date.now());
            const fill = $('rapid-fill'), sec = $('rapid-sec');
            if (!fill) { clearInterval(tick); return; }
            fill.style.width = (left / (RAPID_SECONDS * 1000) * 100) + '%';
            sec.textContent = Math.ceil(left / 1000);
            if (left <= 0) { clearInterval(tick); endRapid(); }
        }, 100);
        Q.timers.push(tick);
    }
    function nextRapid() {
        const R = Q.rapid; if (!R || R.over) return;
        R.q = rapidQuestion(); R.lock = false;
        const hasPos = /[（(]\s*(n|v|adj|adv|prep|conj)\./.test(R.q.word.chinese);
        $('rapid-gloss').innerHTML = esc(R.q.word.chinese) + (hasPos ? '' : ' <span class="fx-small-muted">(' + esc(R.q.word.pos) + ')</span>');
        $('rapid-opts').innerHTML = R.q.options.map((w, i) =>
            '<button type="button" class="quiz-opt" data-i="' + i + '" onclick="FX.answerRapid(this)"><span class="quiz-opt-key">(' + 'ABCD'[i] + ')</span> ' + esc(w.word) + '</button>').join('');
    }
    function answerRapid(btn) {
        const R = Q.rapid; if (!R || R.over || R.lock) return;
        R.lock = true;
        const chosen = R.q.options[+btn.getAttribute('data-i')];
        const ok = chosen === R.q.word;
        R.answered++;
        if (ok) { R.score++; R.combo++; btn.classList.add('correct'); }
        else {
            R.combo = 0; btn.classList.add('wrong');
            document.querySelectorAll('#rapid-opts .quiz-opt').forEach(b => { if (R.q.options[+b.getAttribute('data-i')] === R.q.word) b.classList.add('correct'); });
        }
        beep(ok);
        $('rapid-score').textContent = R.score + ' 題';
        $('rapid-combo').textContent = R.combo >= 3 ? '🔥 ' + R.combo + ' 連擊！' : '';
        setTimeout(nextRapid, ok ? 250 : 700);
    }
    function endRapid() {
        const R = Q.rapid; if (!R || R.over) return;
        R.over = true;
        const key = 'rapid_board_level_' + currentLevel;
        const board = lsGet(key, []);
        const entry = { score: R.score, date: today(), t: Date.now() };
        board.push(entry);
        board.sort((a, b) => b.score - a.score || a.t - b.t);
        const top = board.slice(0, 5);
        lsSet(key, top);
        const rank = top.indexOf(entry);
        if (R.score) addXP(R.score * 2); else recordActivity();
        if (rank === 0 && R.score > 0) confetti();
        quizRoot().innerHTML =
            '<div class="quiz-wrap"><div class="fx-card quiz-summary"><h2 class="quiz-title">⏱️ 時間到！</h2>' +
            '<div class="quiz-score-ring" style="--p:' + (R.answered ? Math.round(R.score / R.answered * 100) : 0) + '"><span>' + R.score + '<small> 題</small></span></div>' +
            '<p class="fx-small-muted">作答 ' + R.answered + ' 題，答對 ' + R.score + ' 題，獲得 ' + (R.score * 2) + ' XP</p>' +
            (rank === 0 && R.score > 0 ? '<p class="fx-good">🏆 新的個人最佳紀錄！</p>' : (rank > 0 ? '<p class="fx-good">進入個人排行榜第 ' + (rank + 1) + ' 名！</p>' : '')) +
            '<h3 class="fx-card-title" style="margin-top:12px;">🏅 個人排行榜（前 5 名）</h3>' + leaderboardHTML(top, rank) +
            '<div class="fx-row" style="justify-content:center; margin-top:16px;"><button type="button" class="landing-btn" onclick="FX.startRapid()">再戰一次</button>' +
            '<button type="button" class="fx-btn fx-btn-ghost" onclick="FX.renderHub()">返回挑戰首頁</button></div></div></div>';
    }

    // ---- 搭配詞配對 (collocation matching, timed)
    function startColloc() {
        stopTimers();
        const seenEn = new Set(), seenZh = new Set(), all = [];
        chapterWords().forEach(w => (w.collocations || []).forEach(c => {
            if (!c || !c.en || !c.zh) return;
            const e = c.en.toLowerCase(), z = c.zh;
            if (seenEn.has(e) || seenZh.has(z)) return;
            seenEn.add(e); seenZh.add(z);
            all.push({ en: c.en, zh: c.zh });
        }));
        const pairs = shuffle(all).slice(0, COLLOC_PAIRS);
        if (pairs.length < 3) { toast('本章搭配詞不足，無法進行配對。'); return; }
        pairs.forEach((p, i) => { p.id = i; });
        Q.colloc = { pairs: pairs, start: Date.now(), matched: 0, mistakes: 0, sel: null, done: false };
        const left = shuffle(pairs), right = shuffle(pairs);
        quizRoot().innerHTML =
            '<div class="quiz-wrap quiz-play"><div class="quiz-play-head"><span>🔗 搭配詞配對 · ' + chapterLabel() + '</span>' +
            '<span class="quiz-type-tag" id="colloc-time">0.0 秒</span><button type="button" class="fx-link" onclick="FX.renderHub()">離開</button></div>' +
            '<div class="fx-card"><p class="quiz-instr">先點左邊的英文搭配詞，再點右邊對應的中文。</p><div class="colloc-board">' +
            '<div class="colloc-col">' + left.map(p => '<button type="button" class="colloc-item" data-side="en" data-id="' + p.id + '" onclick="FX.pickColloc(this)">' + esc(p.en) + '</button>').join('') + '</div>' +
            '<div class="colloc-col">' + right.map(p => '<button type="button" class="colloc-item" data-side="zh" data-id="' + p.id + '" onclick="FX.pickColloc(this)">' + esc(p.zh) + '</button>').join('') + '</div>' +
            '</div><p class="fx-small-muted" id="colloc-status">已配對 0 / ' + pairs.length + '　·　錯誤 0</p></div></div>';
        const tick = setInterval(() => {
            const C = Q.colloc; const el = $('colloc-time');
            if (!C || C.done || !el) { clearInterval(tick); return; }
            el.textContent = ((Date.now() - C.start) / 1000).toFixed(1) + ' 秒';
        }, 100);
        Q.timers.push(tick);
    }
    function pickColloc(btn) {
        const C = Q.colloc; if (!C || C.done || btn.classList.contains('matched')) return;
        if (!C.sel || C.sel.getAttribute('data-side') === btn.getAttribute('data-side')) {
            if (C.sel) C.sel.classList.remove('selected');
            C.sel = (C.sel === btn) ? null : btn;
            if (C.sel) C.sel.classList.add('selected');
            return;
        }
        const a = C.sel; C.sel = null; a.classList.remove('selected');
        if (a.getAttribute('data-id') === btn.getAttribute('data-id')) {
            a.classList.add('matched'); btn.classList.add('matched');
            a.disabled = btn.disabled = true;
            C.matched++; beep(true);
        } else {
            C.mistakes++; beep(false);
            [a, btn].forEach(b => { b.classList.add('wrong'); setTimeout(() => b.classList.remove('wrong'), 450); });
        }
        $('colloc-status').textContent = '已配對 ' + C.matched + ' / ' + C.pairs.length + '　·　錯誤 ' + C.mistakes;
        if (C.matched === C.pairs.length) finishColloc();
    }
    function finishColloc() {
        const C = Q.colloc; C.done = true;
        stopTimers();
        const secs = (Date.now() - C.start) / 1000;
        const g = G(), prev = g.collocBest[currentChapter];
        const isBest = C.pairs.length >= COLLOC_PAIRS && (!prev || secs < prev);
        if (isBest) { g.collocBest[currentChapter] = Math.round(secs * 10) / 10; saveG(g); }
        const xp = 20 + (C.mistakes ? 0 : 10);
        addXP(xp);
        if (isBest || !C.mistakes) confetti();
        quizRoot().innerHTML =
            '<div class="quiz-wrap"><div class="fx-card quiz-summary"><h2 class="quiz-title">🔗 配對完成！</h2>' +
            '<p class="quiz-big-num">' + secs.toFixed(1) + ' 秒</p>' +
            '<p class="fx-small-muted">錯誤 ' + C.mistakes + ' 次 · 獲得 ' + xp + ' XP' + (prev ? ' · 先前最佳 ' + prev.toFixed(1) + ' 秒' : '') + '</p>' +
            (isBest ? '<p class="fx-good">🏆 本章新紀錄！</p>' : '') +
            '<ul class="quiz-mistakes">' + C.pairs.map(p => '<li><div><b>' + esc(p.en) + '</b>　' + esc(p.zh) + '</div></li>').join('') + '</ul>' +
            '<div class="fx-row" style="justify-content:center; margin-top:16px;"><button type="button" class="landing-btn" onclick="FX.startColloc()">再玩一次</button>' +
            '<button type="button" class="fx-btn fx-btn-ghost" onclick="FX.renderHub()">返回挑戰首頁</button></div></div></div>';
    }

    // ---- 字族分類 from the hub (random eligible word, current chapter first)
    function startFamily() {
        stopTimers();
        const elig = levelData().filter(w => usableFamily(w).length >= 2);
        if (!elig.length) return;
        const inCh = elig.filter(w => w.chapter === currentChapter);
        const pool = inCh.length ? inCh : elig;
        const w = pool[Math.floor(Math.random() * pool.length)];
        quizRoot().innerHTML =
            '<div class="quiz-wrap quiz-play"><div class="quiz-play-head"><span>🧩 字族分類 · <b>' + esc(w.word) + '</b> ' + esc(w.chinese) + '</span>' +
            '<button type="button" class="fx-link" onclick="FX.startFamily()">換一組</button><button type="button" class="fx-link" onclick="FX.renderHub()">離開</button></div>' +
            '<div class="info-section" id="fx-hub-family"></div></div>';
        renderFamilyGame($('fx-hub-family'), w);
    }

    // ------------------------------------------------------------------
    // Landing view (chapter) extras: title, confusables, theme map
    // ------------------------------------------------------------------
    function updateLanding() {
        if (!currentChapter || !CHAPTER_INFO[currentChapter]) return;
        const i = chIndex();
        $('landing-chapter-name').textContent = 'Chapter ' + (i + 1) + ' · ' + CHAPTER_INFO[currentChapter].zh;
        $('landing-chapter-desc').textContent = CHAPTER_INFO[currentChapter].desc;
        $('landing-start-btn').style.display = 'inline-block';
        const ex = $('landing-extras');
        if (ex) ex.innerHTML = '<button type="button" class="fx-btn fx-btn-ghost fx-landing-back" onclick="goBackToWordList()">← 返回單字列表</button>' +
            confusablesHTML() + '<section class="fx-card"><h3 class="fx-card-title">🗺️ 主題地圖</h3>' + themeMapHTML() + '</section>';
        // Entry point above the word list (the landing view is otherwise skipped on chapter select)
        let btn = $('fx-overview-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'fx-overview-btn';
            btn.className = 'fx-overview-btn';
            btn.onclick = showChapterOverview;
            const sc = document.querySelector('#word-list-panel-element .search-container');
            if (sc) sc.appendChild(btn);
        }
        const all = getConfusables();
        const groups = all ? (all['L' + currentLevel + '-C' + pad2(i + 1)] || []) : [];
        btn.innerHTML = '🗺️ 本章總覽' + (groups.length ? '　·　<b>⚠️ 易混字 ' + groups.length + ' 組</b>' : '');
    }
    function showChapterOverview() {
        updateLanding();
        $('codex-detail-view').style.display = 'none';
        $('flashcard-arena-view').style.display = 'none';
        $('landing-view-container').style.display = 'flex';
        document.querySelectorAll('.word-row').forEach(el => el.classList.remove('active'));
        const app = document.querySelector('.app-container');
        if (app) app.classList.add('mobile-show-details');
        $('main-display-panel-element').scrollTop = 0;
        setHash(hashForChapter());
    }

    // ------------------------------------------------------------------
    // Deep links: #L{level}/ch{n}  and  #L{level}/w/{word}
    // ------------------------------------------------------------------
    // Capture the deep link now: the main app's own DOMContentLoaded init runs
    // before ours and would otherwise overwrite the hash via the wrappers below.
    const INITIAL_HASH = location.hash;
    let suppressHash = true;   // released in init()
    function setHash(h) {
        if (suppressHash || location.hash === h) return;
        try { history.replaceState(null, '', h); } catch (e) { /* file:// in some browsers */ }
    }
    function hashForWord(w) { return '#L' + currentLevel + '/w/' + encodeURIComponent(w.word); }
    function hashForChapter() { return '#L' + currentLevel + '/ch' + (chIndex() + 1); }
    function applyHash() {
        const m = location.hash.match(/^#L([3-6])(?:\/(?:ch(\d{1,2})|w\/(.+)))?\/?$/i);
        if (!m) return false;
        suppressHash = true;
        try {
            const lv = parseInt(m[1], 10);
            if (lv !== currentLevel) selectLevel(lv);
            if (m[3]) {
                let name;
                try { name = decodeURIComponent(m[3]).toLowerCase(); } catch (e) { name = m[3].toLowerCase(); }
                const w = levelData().find(x => x.word.toLowerCase() === name);
                if (w) {
                    if (currentMode() !== 'codex') switchMode('codex');
                    if (currentChapter !== w.chapter) selectChapter(w.chapter);
                    selectWord(w);
                }
            } else if (m[2]) {
                const ch = CHAPTER_ORDER[parseInt(m[2], 10) - 1];
                if (ch) {
                    selectChapter(ch);
                    if (currentMode() === 'codex') showChapterOverview();
                }
            }
        } finally { suppressHash = false; }
        return true;
    }

    // ------------------------------------------------------------------
    // Share
    // ------------------------------------------------------------------
    function closeSharePop() { const p = $('fx-share-pop'); if (p) p.remove(); }
    function copyText(text) {
        const fallback = () => {
            const ta = document.createElement('textarea');
            ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            ta.remove();
            return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
        };
        if (navigator.clipboard && window.isSecureContext) {
            // writeText can stay pending (e.g. document not focused) — fall back after 1.2 s
            const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1200));
            return Promise.race([navigator.clipboard.writeText(text), timeout]).catch(fallback);
        }
        return fallback();
    }
    function shareCurrentWord(ev) {
        if (ev) ev.stopPropagation();
        if (!currentWord) return;
        if ($('fx-share-pop')) { closeSharePop(); return; }
        const w = currentWord;
        const url = location.href.split('#')[0] + hashForWord(w);
        const text = w.word + '（' + w.chinese + '）— 台灣高中英文 6000 單字互動學習館';
        const pop = document.createElement('div');
        pop.id = 'fx-share-pop';
        pop.className = 'fx-share-pop';
        pop.innerHTML =
            '<div class="fx-share-title">分享「' + esc(w.word) + '」</div>' +
            (navigator.share ? '<button type="button" class="fx-share-item" data-act="native">📤 分享到…</button>' : '') +
            '<button type="button" class="fx-share-item" data-act="copy">🔗 複製連結</button>' +
            '<a class="fx-share-item fx-line" target="_blank" rel="noopener" href="https://social-plugins.line.me/lineit/share?url=' + encodeURIComponent(url) + '">💬 LINE 分享</a>' +
            '<input class="fx-share-url" readonly value="' + esc(url) + '">';
        document.body.appendChild(pop);
        const b = $('codex-share-btn').getBoundingClientRect();
        const pw = pop.offsetWidth;
        pop.style.top = (b.bottom + 8 + window.scrollY) + 'px';
        pop.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, b.right - pw)) + 'px';
        pop.addEventListener('click', e => e.stopPropagation());
        const nat = pop.querySelector('[data-act="native"]');
        if (nat) nat.onclick = () => {
            navigator.share({ title: w.word, text: text, url: url }).then(closeSharePop).catch(() => { /* cancelled */ });
        };
        pop.querySelector('[data-act="copy"]').onclick = () => {
            copyText(url).then(() => { toast('🔗 已複製連結'); closeSharePop(); })
                .catch(() => { const i = pop.querySelector('.fx-share-url'); i.select(); toast('請手動複製連結'); });
        };
        pop.querySelector('.fx-line').addEventListener('click', () => setTimeout(closeSharePop, 100));
    }
    document.addEventListener('click', closeSharePop);

    // ------------------------------------------------------------------
    // Flashcard swipe (touch): right = 已掌握 (pass), left = 仍需複習 (fail)
    // ------------------------------------------------------------------
    function initSwipe() {
        const card = $('arena-card');
        if (!card) return;
        let sx = 0, sy = 0, dx = 0, tracking = false, horizontal = false, suppressClick = false;
        card.addEventListener('touchstart', e => {
            if (e.touches.length !== 1) return;
            sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; tracking = true; horizontal = false;
            card.style.transition = 'none';
        }, { passive: true });
        card.addEventListener('touchmove', e => {
            if (!tracking) return;
            dx = e.touches[0].clientX - sx;
            const dy = e.touches[0].clientY - sy;
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) horizontal = true;
            if (horizontal) {
                card.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 25) + 'deg)';
                card.classList.toggle('swipe-right', dx > 50);
                card.classList.toggle('swipe-left', dx < -50);
            }
        }, { passive: true });
        const end = () => {
            if (!tracking) return;
            tracking = false;
            card.style.transition = '';
            card.style.transform = '';
            card.classList.remove('swipe-left', 'swipe-right');
            if (horizontal && Math.abs(dx) > 70) {
                suppressClick = true;
                setTimeout(() => { suppressClick = false; }, 450);
                if (dx > 0) passFlashcard(); else failFlashcard();
            }
        };
        card.addEventListener('touchend', end);
        card.addEventListener('touchcancel', end);
        card.addEventListener('click', e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
        const hint = document.createElement('p');
        hint.className = 'fx-swipe-hint';
        hint.textContent = '👈 左滑：仍需複習　　右滑：已掌握 👉';
        card.parentNode.insertBefore(hint, $('arena-controls-panel'));
    }

    // ------------------------------------------------------------------
    // Wrap main-app functions (keeps original behaviour, adds hooks)
    // ------------------------------------------------------------------
    const orig = {
        selectWord: window.selectWord,
        selectChapter: window.selectChapter,
        selectLevel: window.selectLevel,
        switchMode: window.switchMode,
        saveMasteredList: window.saveMasteredList,
        toggleCurrentWordMastery: window.toggleCurrentWordMastery,
        passFlashcard: window.passFlashcard,
        failFlashcard: window.failFlashcard
    };

    window.selectWord = function (w) {
        orig.selectWord.apply(this, arguments);
        try { enhanceCodex(w); } catch (e) { console.error('[features] enhanceCodex', e); }
        if (currentMode() === 'codex') setHash(hashForWord(w));
    };

    window.selectChapter = function (ch) {
        const mode = currentMode();
        orig.selectChapter.apply(this, arguments);
        updateLanding();
        if (mode === 'quiz') {
            const app = document.querySelector('.app-container');
            app.classList.remove('mobile-show-details');
            showQuizView();
            renderHub();
            setHash(hashForChapter());
        } else if (mode === 'arena') {
            // original jumps into the codex view; keep the arena visible and reload its deck
            $('landing-view-container').style.display = 'none';
            $('codex-detail-view').style.display = 'none';
            $('collapsible-chapter-banner-container').style.display = 'none';
            $('flashcard-arena-view').style.display = 'flex';
            initArenaDeck();
            setHash(hashForChapter());
        } else if ($('landing-view-container').style.display !== 'none' || !currentWord) {
            setHash(hashForChapter());
        }
    };

    window.selectLevel = function () {
        orig.selectLevel.apply(this, arguments);
        checkBadges(true);
        renderHeader();
    };

    window.switchMode = function (mode) {
        closeSharePop();
        if (mode === 'quiz') {
            stopTimers();
            document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
            $('mode-quiz').classList.add('active');
            const app = document.querySelector('.app-container');
            app.classList.add('arena-mode', 'quiz-mode');
            showQuizView();
            renderHub();
            setHash(hashForChapter());
            return;
        }
        stopTimers();
        Q.round = null;
        quizRoot().style.display = 'none';
        document.querySelector('.app-container').classList.remove('quiz-mode');
        orig.switchMode.apply(this, arguments);
        if (mode === 'codex' && currentWord) setHash(hashForWord(currentWord)); else setHash(hashForChapter());
    };

    window.saveMasteredList = function () {
        orig.saveMasteredList.apply(this, arguments);
        checkBadges(false);
    };
    window.toggleCurrentWordMastery = function () {
        orig.toggleCurrentWordMastery.apply(this, arguments);
        recordActivity();
    };
    window.passFlashcard = function () {
        const w = arenaDeck[arenaIndex];
        orig.passFlashcard.apply(this, arguments);
        if (w) { srsUpdate(w, true); addXP(2); }
    };
    window.failFlashcard = function () {
        const w = arenaDeck[arenaIndex];
        orig.failFlashcard.apply(this, arguments);
        if (w) { srsUpdate(w, false); recordActivity(); }
    };

    // Keyboard: Enter submits / goes next; 1-4 picks options in quiz & rapid
    document.addEventListener('keydown', e => {
        if (quizRoot().style.display === 'none') return;
        if (Q.round) {
            const q = Q.round.qs[Q.round.i];
            if (e.key === 'Enter') {
                e.preventDefault();
                if (q.done) nextQuestion(); else if (q.type !== 'mc') submitTyped();
            } else if (q.type === 'mc' && !q.done && /^[1-4]$/.test(e.key)) {
                const b = document.querySelectorAll('.quiz-opt')[+e.key - 1]; if (b) answerMC(b);
            }
        } else if (Q.rapid && !Q.rapid.over && /^[1-4]$/.test(e.key)) {
            const b = document.querySelectorAll('#rapid-opts .quiz-opt')[+e.key - 1]; if (b) answerRapid(b);
        }
    });

    // ------------------------------------------------------------------
    // Public API used by inline handlers
    // ------------------------------------------------------------------
    window.shareCurrentWord = shareCurrentWord;
    window.FX = {
        openQuiz: function (scope) {
            if (scope === 'review' && dueWords().length) Q.scope = 'review';
            if (currentMode() !== 'quiz') switchMode('quiz'); else renderHub();
        },
        renderHub: renderHub,
        setScope: function (s) { Q.scope = s; renderHub(); },
        toggleType: function (t) {
            Q.types[t] = !Q.types[t];
            if (!Object.keys(TYPE_LABELS).some(k => Q.types[k] && (k !== 'listen' || hasTTS()))) Q.types[t] = true;
            lsSet('quiz_types', Q.types);
            renderHub();
        },
        toggleMute: function () { localStorage.setItem('fx_muted', isMuted() ? '0' : '1'); renderHub(); },
        startRound: startRound,
        quitRound: function () { Q.round = null; renderHub(); },
        showGloss: showGloss,
        submitTyped: submitTyped,
        answerMC: answerMC,
        nextQuestion: nextQuestion,
        replay: function (rate) { const r = Q.round; if (r) speakRawText(r.qs[r.i].answer, rate || 0.85); },
        say: function (t) { speakWord(t); },
        startRapid: startRapid,
        answerRapid: answerRapid,
        startColloc: startColloc,
        pickColloc: pickColloc,
        startFamily: startFamily,
        gotoChapter: function (i) { selectChapter(CHAPTER_ORDER[i]); },
        openWord: function (name) {
            const w = levelData().find(x => x.word.toLowerCase() === String(name).toLowerCase())
                || levelData().find(x => headForms(x.word).indexOf(String(name).toLowerCase()) >= 0);
            if (!w) { toast('「' + esc(name) + '」不在 Level ' + currentLevel + ' 的單字表中。'); return; }
            if (currentMode() !== 'codex') switchMode('codex');
            if (currentChapter !== w.chapter) selectChapter(w.chapter);
            selectWord(w);
        },
        checkSentence: checkSentence,
        // exposed for testing / debugging
        _internals: { findBlank: findBlank, headForms: headForms, pickDistractors: pickDistractors, compareSpeech: compareSpeech,
            renderShadowResult: renderShadowResult, parseFamily: parseFamily, buildRound: buildRound, dueWords: dueWords,
            srsUpdate: srsUpdate, G: G, starCount: starCount, applyHash: applyHash, state: Q }
    };

    // ------------------------------------------------------------------
    // Init (runs after the main app's DOMContentLoaded handler)
    // ------------------------------------------------------------------
    function init() {
        initSwipe();
        checkBadges(true);
        renderHeader();
        updateLanding();
        suppressHash = false;
        if (INITIAL_HASH && location.hash !== INITIAL_HASH) {
            try { history.replaceState(null, '', INITIAL_HASH); } catch (e) { /* ignore */ }
        }
        if (!applyHash()) {
            if (currentWord && currentMode() === 'codex') setHash(hashForWord(currentWord)); else setHash(hashForChapter());
        }
        window.addEventListener('hashchange', applyHash);
        // re-render streak/due counters when the tab regains focus on another day
        document.addEventListener('visibilitychange', () => { if (!document.hidden) renderHeader(); });
    }
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', init);
    else init();
})();
