/* ===== 빠른 메모 (quick-memo) — 100% 브라우저 저장 · 서버 전송 없음 ===== */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------------- 저장소 (IndexedDB → LocalStorage 폴백) ---------------- */
  const DB_NAME = 'quick-memo';
  const DB_VER = 1;
  const LS_KEY = 'quick-memo.state.v1';
  const IMG_MAX = 1600;
  const UNDO_MS = 6000;
  const TRASH_DAYS = 30;

  let db = null;
  let fallback = false;
  const imageCache = new Map();

  function openDB() {
    return new Promise((resolve) => {
      if (!('indexedDB' in window)) return resolve(null);
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { return resolve(null); }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('img')) d.createObjectStore('img', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  async function idbGet(store, key) {
    return reqP(db.transaction(store).objectStore(store).get(key));
  }
  async function idbPut(store, val) {
    return reqP(db.transaction(store, 'readwrite').objectStore(store).put(val));
  }
  async function idbDel(store, key) {
    return reqP(db.transaction(store, 'readwrite').objectStore(store).delete(key));
  }
  async function idbAll(store) {
    return reqP(db.transaction(store).objectStore(store).getAll());
  }

  const Store = {
    async init() {
      db = await openDB();
      fallback = !db;
    },
    async load() {
      if (fallback) {
        try { return JSON.parse(localStorage.getItem(LS_KEY) || '') || null; } catch (e) { return null; }
      }
      try {
        const rec = await idbGet('kv', 'state');
        return rec ? rec.v : null;
      } catch (e) { return null; }
    },
    async save(state) {
      if (fallback) {
        try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { console.warn('저장 실패', e); }
        return;
      }
      try { await idbPut('kv', { k: 'state', v: state, at: Date.now() }); } catch (e) { console.warn('저장 실패', e); }
    },
    async putImage(id, data) {
      imageCache.set(id, data);
      if (fallback) return;
      try { await idbPut('img', { id, data, at: Date.now() }); } catch (e) { console.warn('이미지 저장 실패', e); }
    },
    async getImage(id) {
      if (imageCache.has(id)) return imageCache.get(id);
      if (fallback) return null;
      try {
        const rec = await idbGet('img', id);
        if (rec) { imageCache.set(id, rec.data); return rec.data; }
      } catch (e) { /* ignore */ }
      return null;
    },
    async delImage(id) {
      imageCache.delete(id);
      if (fallback) return;
      try { await idbDel('img', id); } catch (e) { /* ignore */ }
    },
    async allImages() {
      if (fallback) {
        const out = {};
        notes.forEach((n) => { if (n.img && n.img.data) out[n.img.id] = n.img.data; });
        return out;
      }
      try {
        const rows = await idbAll('img');
        const out = {};
        rows.forEach((r) => { out[r.id] = r.data; });
        return out;
      } catch (e) { return {}; }
    },
  };

  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      Store.save({ notes, prefs, savedAt: Date.now() });
    }, 220);
  }

  /* ---------------- 상태 ---------------- */
  let notes = [];
  let prefs = { theme: 'dark' };
  let query = '';
  let filter = 'all';
  let activeTag = '';
  let trashView = false;
  let editId = null;
  let pendingImage = null; // {data,w,h}
  let undoStack = null;

  const listEl = $('#list');
  const inputEl = $('#input');
  const qEl = $('#q');
  const chipsEl = $('#chips');
  const qcountEl = $('#qcount');

  /* ---------------- 유틸 ---------------- */
  const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s);

  function fmtTime(t) {
    const d = new Date(t);
    let h = d.getHours();
    const ap = h < 12 ? '오전' : '오후';
    h = h % 12 || 12;
    return `${ap} ${h}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  function dayKey(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function dayLabel(t) {
    const d = new Date(t);
    const now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    const wd = WD[d.getDay()];
    if (diff === 0) return `오늘 · ${d.getMonth() + 1}월 ${d.getDate()}일 (${wd})`;
    if (diff === 1) return `어제 · ${d.getMonth() + 1}월 ${d.getDate()}일 (${wd})`;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일 (${wd})`;
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${wd})`;
  }

  const URL_RE = /https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+/gi;
  const TAG_RE = /#[0-9A-Za-z가-힣_]{1,30}/g;
  const TODO_RE = /^\s*(?:[-*]\s*)?\[( |x|X)\]\s?(.*)$/;

  function tagsOf(text) {
    const out = [];
    (text.match(TAG_RE) || []).forEach((m) => {
      const t = m.slice(1);
      if (t && !out.includes(t)) out.push(t);
    });
    return out;
  }
  function urlsOf(text) { return text.match(URL_RE) || []; }
  function hasOpenTodo(text) {
    return text.split('\n').some((l) => { const m = l.match(TODO_RE); return m && m[1] === ' '; });
  }
  function normalizeUrl(u) { return /^www\./i.test(u) ? 'https://' + u : u; }
  function hostOf(u) {
    try { return new URL(normalizeUrl(u)).hostname.replace(/^www\./, ''); } catch (e) { return 'link'; }
  }
  function iconOf(host) {
    const h = host.toLowerCase();
    if (h.includes('youtube') || h === 'youtu.be') return '▶️';
    if (h.includes('instagram')) return '📸';
    if (h.includes('threads')) return '🧵';
    if (h.includes('tiktok')) return '🎵';
    if (h.includes('coupang')) return '🛒';
    if (h.includes('github')) return '🐙';
    if (h.includes('notion')) return '📄';
    if (h.includes('naver')) return '🟢';
    if (h.includes('kakao')) return '💛';
    if (h.includes('google')) return '🔎';
    if (h.includes('open.kakao')) return '💬';
    return '🔗';
  }
  function linkLabel(u) {
    try {
      const url = new URL(normalizeUrl(u));
      const p = decodeURIComponent(url.pathname + url.search);
      return p === '/' ? url.hostname : p.slice(0, 80);
    } catch (e) { return u; }
  }

  /* ---------------- 검색 ---------------- */
  function terms() {
    return query.trim().toLowerCase().split(/\s+/).filter(Boolean).map((t) => t.replace(/^#/, ''));
  }
  function matches(n) {
    const ts = terms();
    if (!ts.length) return true;
    const hay = (n.text + ' ' + tagsOf(n.text).join(' ')).toLowerCase();
    return ts.every((t) => hay.includes(t));
  }
  function inFilter(n) {
    if (trashView) return !!n.deleted;
    if (n.deleted) return false;
    if (filter === 'pin') return !!n.pinned;
    if (filter === 'link') return urlsOf(n.text).length > 0;
    if (filter === 'img') return !!n.img;
    if (filter === 'todo') return hasOpenTodo(n.text);
    return true;
  }
  function pass(n) {
    if (!inFilter(n)) return false;
    if (activeTag && !tagsOf(n.text).some((t) => t.toLowerCase() === activeTag.toLowerCase())) return false;
    return matches(n);
  }

  /* ---------------- 렌더 ---------------- */
  function highlight(root, ts) {
    if (!ts.length) return;
    const pats = ts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
    if (!pats.length) return;
    const scanRe = new RegExp('(' + pats.join('|') + ')', 'gi');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement && node.parentElement.closest('mark')) continue;
      scanRe.lastIndex = 0;
      if (scanRe.test(node.nodeValue)) targets.push(node);
    }
    targets.forEach((tn) => {
      const text = tn.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      scanRe.lastIndex = 0;
      while ((m = scanRe.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const low = m[0].toLowerCase();
        let idx = pats.findIndex((p) => p.toLowerCase() === low);
        if (idx < 0) idx = 0;
        const mark = document.createElement('mark');
        mark.className = 'hl' + (idx % 4);
        mark.textContent = m[0];
        frag.appendChild(mark);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      tn.replaceWith(frag);
    });
  }

  function inlineNodes(text) {
    const frag = document.createDocumentFragment();
    const re = new RegExp(`${URL_RE.source}|${TAG_RE.source}`, 'gi');
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tok = m[0];
      if (tok[0] === '#') {
        const b = document.createElement('button');
        b.className = 'tagchip';
        b.type = 'button';
        b.textContent = tok;
        b.title = tok + ' 태그만 보기';
        b.addEventListener('click', (e) => { e.stopPropagation(); setTag(tok.slice(1)); });
        frag.appendChild(b);
      } else {
        const a = document.createElement('a');
        a.href = normalizeUrl(tok);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = tok;
        frag.appendChild(a);
      }
      last = m.index + tok.length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function bodyEl(n, ts) {
    const body = document.createElement('div');
    body.className = 'txt';
    const lines = n.text.split('\n');
    let p = null;
    const flush = () => { if (p) { body.appendChild(p); p = null; } };
    lines.forEach((line, lineIdx) => {
      const tm = line.match(TODO_RE);
      if (tm) {
        flush();
        const row = document.createElement('label');
        row.className = 'todo' + (tm[1] === ' ' ? '' : ' done');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = tm[1] !== ' ';
        cb.addEventListener('change', () => toggleTodo(n.id, lineIdx, cb.checked));
        const span = document.createElement('span');
        span.className = 'tlabel';
        span.appendChild(inlineNodes(tm[2]));
        row.appendChild(cb);
        row.appendChild(span);
        body.appendChild(row);
        return;
      }
      if (!line.trim()) { flush(); return; }
      if (!p) p = document.createElement('p');
      else p.appendChild(document.createElement('br'));
      p.appendChild(inlineNodes(line));
    });
    flush();
    if (!body.childNodes.length) body.appendChild(document.createElement('p'));
    highlight(body, ts);
    return body;
  }

  function thumbEl(n) {
    const wrap = document.createElement('div');
    wrap.className = 'thumb';
    const img = document.createElement('img');
    img.alt = '첨부 사진';
    img.loading = 'lazy';
    const cached = imageCache.get(n.img.id) || n.img.data;
    if (cached) img.src = cached;
    else {
      img.style.minHeight = '110px';
      img.style.background = 'var(--line)';
      Store.getImage(n.img.id).then((d) => { if (d) img.src = d; });
    }
    img.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(img.src); });
    wrap.appendChild(img);
    return wrap;
  }

  function linkCardEl(u) {
    const host = hostOf(u);
    const a = document.createElement('a');
    a.className = 'linkcard';
    a.href = normalizeUrl(u);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.innerHTML = '';
    const ic = document.createElement('div');
    ic.className = 'ic';
    ic.textContent = iconOf(host);
    const info = document.createElement('div');
    info.className = 'lcinfo';
    const h = document.createElement('div');
    h.className = 'lchost';
    h.textContent = host;
    const p = document.createElement('div');
    p.className = 'lcpath';
    p.textContent = linkLabel(u);
    info.append(h, p);
    a.append(ic, info);
    return a;
  }

  function toolsEl(n) {
    const tools = document.createElement('div');
    tools.className = 'tools';
    const mk = (label, fn, cls, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (cls) b.className = cls;
      if (title) b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    if (trashView) {
      tools.append(
        mk('↩ 복원', () => restoreNote(n.id)),
        mk('🗑 완전삭제', () => purgeNote(n.id), 'danger'),
      );
      return tools;
    }
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.append(
      mk(n.pinned ? '고정해제' : '📌 고정', () => togglePin(n.id)),
      mk('수정', () => startEdit(n.id)),
      mk('삭제', () => deleteNote(n.id), 'danger'),
    );
    tools.append(
      mk('복사', () => copyText(n.text), null, '한 번에 복사'),
      mk('⋯', () => tools.classList.toggle('open'), 'more', '고정·수정·삭제'),
      acts,
    );
    return tools;
  }

  function msgEl(n, ts) {
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    wrap.dataset.id = n.id;

    const bubbleWrap = document.createElement('div');
    bubbleWrap.className = 'bubblewrap';

    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (n.pinned && !trashView ? ' pinned' : '');
    bubble.appendChild(bodyEl(n, ts));
    const urls = urlsOf(n.text);
    if (urls.length) bubble.appendChild(linkCardEl(urls[0]));
    if (n.img) bubble.appendChild(thumbEl(n));
    bubbleWrap.appendChild(bubble);
    bubbleWrap.appendChild(toolsEl(n));

    const time = document.createElement('div');
    time.className = 'time';
    const t1 = document.createElement('span');
    t1.textContent = fmtTime(n.t);
    time.appendChild(t1);
    const flags = document.createElement('span');
    flags.className = 'flags';
    const fl = [];
    if (n.pinned && !trashView) fl.push('📌');
    if (n.edited) fl.push('수정됨');
    if (trashView) fl.push('🗑');
    flags.textContent = fl.join(' ');
    if (fl.length) time.appendChild(flags);

    wrap.append(time, bubbleWrap);
    wrap.addEventListener('click', (e) => {
      if (e.target.closest('a,button,input,label,img')) return;
      const t = wrap.querySelector('.tools');
      if (t) t.classList.toggle('open');
    });
    return wrap;
  }

  function chipDefs() {
    const live = notes.filter((n) => !n.deleted);
    return [
      { id: 'all', label: '전체', n: live.length },
      { id: 'pin', label: '📌 고정', n: live.filter((x) => x.pinned).length },
      { id: 'link', label: '🔗 링크', n: live.filter((x) => urlsOf(x.text).length).length },
      { id: 'img', label: '🖼️ 사진', n: live.filter((x) => !!x.img).length },
      { id: 'todo', label: '☑️ 할일', n: live.filter((x) => hasOpenTodo(x.text)).length },
    ];
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    if (trashView) {
      const c = document.createElement('button');
      c.className = 'chip on';
      c.textContent = '🗑 휴지통';
      c.addEventListener('click', () => { trashView = false; render(); });
      const back = document.createElement('button');
      back.className = 'chip';
      back.textContent = '← 메모로 돌아가기';
      back.addEventListener('click', () => { trashView = false; render(); });
      chipsEl.append(c, back);
      return;
    }
    chipDefs().forEach((d) => {
      const b = document.createElement('button');
      b.className = 'chip' + (filter === d.id ? ' on' : '');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', filter === d.id ? 'true' : 'false');
      b.innerHTML = `${d.label} <span class="n">${d.n}</span>`;
      b.addEventListener('click', () => { filter = d.id; render(); });
      chipsEl.appendChild(b);
    });
    if (activeTag) {
      const b = document.createElement('button');
      b.className = 'chip on';
      b.textContent = `#${activeTag} ✕`;
      b.addEventListener('click', () => setTag(''));
      chipsEl.appendChild(b);
    }
    if (notes.some((n) => n.deleted)) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = `🗑 휴지통 ${notes.filter((n) => n.deleted).length}`;
      b.addEventListener('click', () => { trashView = true; editId = null; render(); });
      chipsEl.appendChild(b);
    }
  }

  function render() {
    const ts = terms();
    const scroller = listEl;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;

    listEl.innerHTML = '';
    renderChips();
    $('#totalBadge').textContent = notes.filter((n) => !n.deleted).length;
    composerVisible(!trashView);

    const shown = notes.filter(pass);

    if (!shown.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      if (!notes.filter((n) => !n.deleted).length) {
        empty.innerHTML =
          '<div class="big">💬</div><b>첫 메모를 남겨 보세요</b>' +
          '<small>아래 입력창에 톡 치고 Enter — 날짜·시간이 찍혀서 쌓입니다.</small>' +
          '<div class="tips"><span>#태그 로 묶고, 태그를 눌러 바로 필터</span>' +
          '<span>- [ ] 장보기 처럼 쓰면 체크리스트</span>' +
          '<span>링크는 자동으로 카드가 되고, 🖼️ 로 사진 첨부</span></div>';
      } else if (trashView) {
        empty.innerHTML = '<div class="big">🗑️</div><b>휴지통이 비어 있어요</b>';
      } else {
        empty.innerHTML =
          '<div class="big">🔍</div><b>검색 결과가 없어요</b>' +
          `<small>${query ? `"${escapeHtml(query)}"` : '이 필터'}에 맞는 메모가 없습니다.</small>`;
        const reset = document.createElement('button');
        reset.className = 'chip on';
        reset.style.marginTop = '8px';
        reset.textContent = '필터 초기화';
        reset.addEventListener('click', () => { query = ''; qEl.value = ''; filter = 'all'; activeTag = ''; render(); });
        empty.appendChild(reset);
      }
      listEl.appendChild(empty);
      updateQcount(0, shown.length);
      return;
    }

    if (trashView) {
      shown.sort((a, b) => (b.delAt || 0) - (a.delAt || 0));
      shown.forEach((n) => listEl.appendChild(msgEl(n, ts)));
      updateQcount(shown.length, shown.length);
      return;
    }

    const pinned = shown.filter((n) => n.pinned).sort((a, b) => b.t - a.t);
    const rest = shown.filter((n) => !n.pinned).sort((a, b) => a.t - b.t);

    if (pinned.length) {
      const head = document.createElement('div');
      head.className = 'sectionhead';
      head.textContent = '📌 고정한 메모';
      listEl.appendChild(head);
      pinned.forEach((n) => listEl.appendChild(msgEl(n, ts)));
    }

    let lastDay = null;
    rest.forEach((n) => {
      const k = dayKey(n.t);
      if (k !== lastDay) {
        lastDay = k;
        const sep = document.createElement('div');
        sep.className = 'daysep';
        sep.textContent = dayLabel(n.t);
        listEl.appendChild(sep);
      }
      listEl.appendChild(msgEl(n, ts));
    });

    updateQcount(shown.length, notes.filter((n) => !n.deleted).length);

    if (atBottom || shown.length === 1) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function updateQcount(shownN, total) {
    const active = query.trim() || filter !== 'all' || activeTag;
    if (!active) { qcountEl.textContent = ''; return; }
    qcountEl.textContent = filter === 'all' && query.trim() && !activeTag
      ? `${shownN}개 일치`
      : `${shownN}개 / ${total}`;
  }

  function composerVisible(v) {
    $('#composer').hidden = !v;
  }

  /* ---------------- 동작 ---------------- */
  function setTag(tag) {
    activeTag = activeTag === tag ? '' : tag;
    if (activeTag) { filter = 'all'; }
    render();
    listEl.scrollTop = 0;
  }

  function addNote(text, img) {
    const clean = text.replace(/\s+$/, '');
    if (!clean && !img) return;
    const n = {
      id: uid(),
      t: Date.now(),
      text: clean,
      pinned: false,
      deleted: false,
    };
    if (img) {
      const id = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      n.img = { id, w: img.w, h: img.h };
      if (fallback) n.img.data = img.data;
      Store.putImage(id, img.data);
    }
    notes.push(n);
    persist();
    filter = 'all';
    query = '';
    qEl.value = '';
    activeTag = '';
    render();
    requestAnimationFrame(() => { listEl.scrollTop = listEl.scrollHeight; });
  }

  function toggleTodo(id, lineIdx, checked) {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    const lines = n.text.split('\n');
    if (!lines[lineIdx] || !TODO_RE.test(lines[lineIdx])) return;
    lines[lineIdx] = lines[lineIdx].replace(/\[( |x|X)\]/, checked ? '[x]' : '[ ]');
    n.text = lines.join('\n');
    n.edited = true;
    persist();
    render();
  }

  function togglePin(id) {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    n.pinned = !n.pinned;
    persist();
    render();
    showToast(n.pinned ? '📌 위에 고정했어요' : '고정을 풀었어요');
  }

  function deleteNote(id) {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    n.deleted = true;
    n.delAt = Date.now();
    persist();
    render();
    showToast('휴지통으로 옮겼어요', '실행취소', () => {
      n.deleted = false;
      delete n.delAt;
      persist();
      render();
    }, UNDO_MS);
  }

  function restoreNote(id) {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    n.deleted = false;
    delete n.delAt;
    persist();
    render();
    showToast('메모를 복원했어요');
  }

  function purgeNote(id) {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    notes = notes.filter((x) => x.id !== id);
    if (n.img) Store.delImage(n.img.id);
    persist();
    render();
    showToast('완전히 삭제했어요');
  }

  function startEdit(id) {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    editId = id;
    inputEl.value = n.text;
    pendingImage = null;
    hideAttach();
    $('#editbar').hidden = false;
    autosize();
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    listEl.scrollTop = listEl.scrollHeight;
  }

  function cancelEdit() {
    editId = null;
    inputEl.value = '';
    $('#editbar').hidden = true;
    autosize();
  }

  function saveEdit() {
    const n = notes.find((x) => x.id === editId);
    if (!n) return cancelEdit();
    const text = inputEl.value.replace(/\s+$/, '');
    if (!text) return;
    n.text = text;
    n.edited = true;
    if (pendingImage) {
      const id = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if (n.img) Store.delImage(n.img.id);
      n.img = { id, w: pendingImage.w, h: pendingImage.h };
      if (fallback) n.img.data = pendingImage.data;
      Store.putImage(id, pendingImage.data);
      pendingImage = null;
      hideAttach();
    }
    persist();
    cancelEdit();
    render();
    showToast('수정했어요');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('복사했어요 ✓');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showToast('복사했어요 ✓'); }
      catch (err) { showToast('복사가 안 됐어요 — 길게 눌러 선택해 주세요'); }
      ta.remove();
    }
  }

  let toastTimer = null;
  function showToast(msg, actionLabel, actionFn, ms = 2600) {
    const t = $('#toast');
    $('#toastMsg').textContent = msg;
    const act = $('#toastAct');
    if (actionLabel && actionFn) {
      act.hidden = false;
      act.textContent = actionLabel;
      undoStack = actionFn;
    } else {
      act.hidden = true;
      undoStack = null;
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; undoStack = null; }, ms);
  }

  /* ---------------- 사진 ---------------- */
  function hideAttach() {
    pendingImage = null;
    $('#attach').hidden = true;
    $('#attachImg').removeAttribute('src');
  }
  function showAttach(dataUrl) {
    $('#attachImg').src = dataUrl;
    $('#attach').hidden = false;
  }

  async function fileToImage(file) {
    if (!file || !file.type.startsWith('image/')) return null;
    let bmp;
    try {
      bmp = await createImageBitmap(file);
    } catch (e) {
      bmp = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = URL.createObjectURL(file);
      });
    }
    const w0 = bmp.width, h0 = bmp.height;
    const scale = Math.min(1, IMG_MAX / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    const data = canvas.toDataURL('image/jpeg', 0.82);
    if (bmp.close) bmp.close();
    return { data, w, h };
  }

  /* ---------------- 백업 ---------------- */
  async function exportJson() {
    const images = await Store.allImages();
    const payload = {
      app: 'quick-memo',
      v: 1,
      exportedAt: new Date().toISOString(),
      notes: notes.filter((n) => !(n.deleted && !n.text)),
      images,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const name = `quick-memo-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.json`;
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast(`백업 파일을 내려받았어요 (${payload.notes.length}개)`);
  }

  async function importJson(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const incoming = Array.isArray(data) ? data : data.notes;
      if (!Array.isArray(incoming)) throw new Error('형식이 달라요');
      const have = new Set(notes.map((n) => n.id));
      let added = 0;
      for (const raw of incoming) {
        if (!raw || typeof raw.text !== 'string') continue;
        const n = {
          id: raw.id || uid(),
          t: Number(raw.t) || Date.now(),
          text: raw.text,
          pinned: !!raw.pinned,
          deleted: false,
          edited: !!raw.edited,
        };
        if (raw.img && raw.img.id) n.img = { id: raw.img.id, w: raw.img.w, h: raw.img.h };
        if (have.has(n.id)) continue;
        have.add(n.id);
        notes.push(n);
        added++;
      }
      const imgs = data.images || {};
      for (const [id, dataUrl] of Object.entries(imgs)) {
        if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) await Store.putImage(id, dataUrl);
      }
      notes.sort((a, b) => a.t - b.t);
      persist();
      render();
      showToast(added ? `${added}개 메모를 가져왔어요` : '새로 가져올 메모가 없어요');
    } catch (e) {
      showToast('가져오기 실패 — quick-memo 백업 파일인지 확인해 주세요', null, null, 4000);
    }
  }

  /* ---------------- 시트 / 테마 / 라이트박스 ---------------- */
  function openSheet() {
    $('#sheetback').hidden = false;
    $('#sheet').hidden = false;
    $('#trashCount').textContent = `삭제한 메모 ${notes.filter((n) => n.deleted).length}개 · 30일 뒤 자동 정리`;
    $('#sheetInfo').textContent =
      `메모 ${notes.filter((n) => !n.deleted).length}개 · 저장 위치: 이 브라우저(${fallback ? 'LocalStorage' : 'IndexedDB'}) 안 · 서버 전송 없음`;
  }
  function closeSheet() {
    $('#sheetback').hidden = true;
    $('#sheet').hidden = true;
  }

  function applyTheme() {
    document.documentElement.dataset.theme = prefs.theme;
    $('#btnTheme').textContent = prefs.theme === 'dark' ? '🌙' : '☀️';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', prefs.theme === 'dark' ? '#0e1013' : '#f4f5f8');
  }
  function toggleTheme() {
    prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    persist();
  }

  function openLightbox(src) {
    if (!src) return;
    $('#lightboxImg').src = src;
    $('#lightbox').hidden = false;
  }

  /* ---------------- 입력 ---------------- */
  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(132, inputEl.scrollHeight) + 'px';
  }
  function submit() {
    if (editId) { saveEdit(); return; }
    const text = inputEl.value;
    if (!text.trim() && !pendingImage) return;
    const img = pendingImage;
    addNote(text, img);
    inputEl.value = '';
    hideAttach();
    autosize();
    inputEl.focus();
  }

  /* ---------------- 초기화 ---------------- */
  async function init() {
    await Store.init();
    const saved = await Store.load();
    if (saved) {
      notes = Array.isArray(saved.notes) ? saved.notes : [];
      prefs = Object.assign({ theme: 'dark' }, saved.prefs || {});
    }
    // 휴지통 자동 정리
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    notes = notes.filter((n) => !(n.deleted && n.delAt && n.delAt < cutoff));
    applyTheme();
    render();
    requestAnimationFrame(() => {
      listEl.scrollTop = listEl.scrollHeight;
      if (window.matchMedia('(min-width: 720px)').matches) inputEl.focus();
    });
  }

  /* ---------------- 이벤트 ---------------- */
  inputEl.addEventListener('input', autosize);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape' && editId) cancelEdit();
  });
  inputEl.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (!file) continue;
        e.preventDefault();
        const img = await fileToImage(file);
        if (img) { pendingImage = img; showAttach(img.data); showToast('사진을 붙여 넣을 준비를 했어요 — Enter로 전송'); }
        break;
      }
    }
  });

  $('#btnSend').addEventListener('click', submit);
  $('#btnPhoto').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const img = await fileToImage(f);
    if (img) { pendingImage = img; showAttach(img.data); inputEl.focus(); }
  });
  $('#attachRemove').addEventListener('click', hideAttach);
  $('#btnTodo').addEventListener('click', () => {
    const v = inputEl.value;
    if (v && !v.endsWith('\n')) inputEl.value = v + '\n- [ ] ';
    else inputEl.value = v + '- [ ] ';
    autosize();
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  });
  $('#editCancel').addEventListener('click', cancelEdit);

  qEl.addEventListener('input', () => {
    query = qEl.value;
    $('#qclear').hidden = !query;
    render();
  });
  $('#qclear').addEventListener('click', () => {
    qEl.value = ''; query = ''; $('#qclear').hidden = true;
    render(); qEl.focus();
  });

  $('#btnTheme').addEventListener('click', toggleTheme);
  $('#btnMenu').addEventListener('click', openSheet);
  $('#sheetback').addEventListener('click', closeSheet);
  $('#sheetClose').addEventListener('click', closeSheet);
  $$('.sheetitem').forEach((b) => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'export') { closeSheet(); exportJson(); }
    if (act === 'import') { closeSheet(); $('#importInput').click(); }
    if (act === 'trash') { closeSheet(); trashView = true; editId = null; render(); }
    if (act === 'theme') { toggleTheme(); }
  }));
  $('#importInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) importJson(f);
  });

  $('#toastAct').addEventListener('click', () => {
    if (undoStack) { const fn = undoStack; undoStack = null; fn(); }
    $('#toast').hidden = true;
  });

  $('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; $('#lightboxImg').removeAttribute('src'); });

  listEl.addEventListener('scroll', () => {
    const far = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight > 420;
    $('#jumpBottom').hidden = !far;
  });
  $('#jumpBottom').addEventListener('click', () => {
    listEl.scrollTo({ top: listEl.scrollHeight, behavior: 'smooth' });
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault(); qEl.focus(); qEl.select();
    }
    if (e.key === 'Escape') {
      if (!$('#lightbox').hidden) { $('#lightbox').hidden = true; return; }
      if (!$('#sheet').hidden) { closeSheet(); return; }
      if (document.activeElement === qEl && qEl.value) { qEl.value = ''; query = ''; $('#qclear').hidden = true; render(); }
      else if (editId) cancelEdit();
    }
  });

  // 창 최소화/복귀 시 저장 보장
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') Store.save({ notes, prefs, savedAt: Date.now() });
  });

  // 서비스 워커 (PWA 오프라인)
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  init();
})();
