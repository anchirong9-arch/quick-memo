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
        notes.forEach((n) => { imagesOf(n).forEach((im) => { if (im.data) out[im.id] = im.data; }); });
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
  let selectMode = false;
  const selected = new Set();
  let pendingDday = '';    // 입력창에서 고른 디데이 날짜 'YYYY-MM-DD'
  let ddayTargetId = null; // 카드에서 날짜를 바꾸는 대상 메모 id

  const listEl = $('#list');
  const inputEl = $('#input');
  const qEl = $('#q');
  const chipsEl = $('#chips');
  const qcountEl = $('#qcount');

  /* ---------------- 유틸 ---------------- */
  const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s);
  // 메모의 첨부 사진 목록 (여러 장 합치기 지원 — 예전 단일 img 형식도 읽음)
  const imagesOf = (n) => (Array.isArray(n.imgs) && n.imgs.length ? n.imgs : (n.img ? [n.img] : []));
  const imageIds = (n) => imagesOf(n).map((im) => im.id).filter(Boolean);

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

  /* ---------------- 디데이 ---------------- */
  // 'YYYY-MM-DD' → 연·월·일. 없거나 이상한 값이면 null.
  function parseDday(s) {
    if (typeof s !== 'string') return null;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const utc = Date.UTC(y, mo - 1, d);
    const chk = new Date(utc);
    if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
    return { y, mo, d, utc };
  }
  // 오늘 날짜의 자정을 UTC 기준 숫자로 — 양쪽 다 UTC로 재서 시간대·서머타임 때문에 하루 밀리지 않게 한다
  function todayStamp() {
    const now = new Date();
    return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  }
  function ddayInfo(s) {
    const p = parseDday(s);
    if (!p) return null;
    const diff = Math.round((p.utc - todayStamp()) / 86400000);
    return {
      y: p.y, mo: p.mo, d: p.d,
      diff,
      label: diff === 0 ? 'D-DAY' : (diff > 0 ? `D-${diff}` : `D+${-diff}`),
      short: `${p.mo}/${p.d}`,
    };
  }
  // 다가오는 일정 먼저(D-DAY → D-1 …), 지난 일정은 최근 것부터 뒤로
  function ddayOrder(a, b) {
    if (!a) return b ? 1 : 0;
    if (!b) return -1;
    if ((a.diff >= 0) !== (b.diff >= 0)) return a.diff >= 0 ? -1 : 1;
    return a.diff >= 0 ? a.diff - b.diff : b.diff - a.diff;
  }
  function ddayLive() {
    return notes.filter((n) => !n.deleted && ddayInfo(n.dday));
  }
  const ddayClass = (info) => {
    if (!info) return '';
    if (info.diff === 0) return 'today';
    if (info.diff > 0) return info.diff <= 3 ? 'soon' : 'future';
    return 'past';
  };
  // 배너에 쓸 가장 가까운 일정 (다가오는 게 없으면 가장 최근 지난 일정)
  function ddayBannerData() {
    const live = ddayLive();
    if (!live.length) return null;
    const rows = live.map((n) => ({ n, info: ddayInfo(n.dday) })).sort((a, b) => ddayOrder(a.info, b.info));
    return {
      note: rows[0].n,
      info: rows[0].info,
      extra: live.length - 1,
      sig: live.map((n) => `${n.id}:${n.dday}`).sort().join('|'),
    };
  }
  // 메모 본문 첫 줄을 배너·제목용 한 줄로
  function noteTitle(n) {
    const lines = String(n.text || '')
      .split('\n')
      .map((l) => l.replace(TODO_RE, '$2').replace(BULLET_RE, '').replace(URL_RE, '').trim())
      .filter(Boolean);
    let t = (lines[0] || '').replace(/\s+/g, ' ').trim();
    if (!t) t = imagesOf(n).length ? '사진 메모' : '메모';
    const chars = Array.from(t);
    if (chars.length > 20) t = chars.slice(0, 20).join('') + '…';
    return t;
  }

  const URL_RE = /https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+/gi;
  const TAG_RE = /#[0-9A-Za-z가-힣_]{1,30}/g;
  const TODO_RE = /^\s*(?:[-*]\s*)?\[( |x|X)\]\s?(.*)$/;
  const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;

  // 여러 줄 글을 '줄마다 네모'가 붙는 할일 목록으로 바꾼다.
  // 이미 할일인 줄은 체크 상태 그대로 두고, 빈 줄은 목록에서 뺀다.
  function toTodoText(text) {
    const out = [];
    String(text).replace(/\s+$/, '').split('\n').forEach((raw) => {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) return;
      if (TODO_RE.test(line)) {
        const tm = line.match(TODO_RE);
        if (!tm[2].trim()) return; // 글자 없는 빈 네모는 버린다
        out.push(line.replace(/^\s+/, ''));
        return;
      }
      const body = line.replace(BULLET_RE, '').trim();
      out.push('- [ ] ' + (body || line.trim()));
    });
    return out.join('\n');
  }

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
    return text.split('\n').some((l) => { const m = l.match(TODO_RE); return m && m[1] === ' ' && m[2].trim(); });
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
    if (filter === 'dday') return !!ddayInfo(n.dday);
    if (filter === 'link') return urlsOf(n.text).length > 0;
    if (filter === 'img') return imagesOf(n).length > 0;
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
    let buf = [];
    // 줄바꿈을 입력한 그대로 (빈 줄 포함) 보여 주기 위해 한 덩어리는 pre-wrap 으로 렌더
    const flush = () => {
      if (!buf.length) return;
      const p = document.createElement('p');
      p.appendChild(inlineNodes(buf.join('\n')));
      body.appendChild(p);
      buf = [];
    };
    lines.forEach((line, lineIdx) => {
      const tm = line.match(TODO_RE);
      if (tm) {
        // 글자 없는 빈 네모는 그리지 않는다 (예전에 밑에 덩그러니 남던 빈 체크박스)
        if (!tm[2].trim()) return;
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
      buf.push(line);
    });
    flush();
    if (!body.childNodes.length) body.appendChild(document.createElement('p'));
    highlight(body, ts);
    return body;
  }

  function thumbEl(im, noteId) {
    const wrap = document.createElement('div');
    wrap.className = 'thumb';
    const img = document.createElement('img');
    img.alt = '첨부 사진';
    img.loading = 'lazy';
    const cached = imageCache.get(im.id) || im.data;
    if (cached) img.src = cached;
    else {
      img.style.minHeight = '110px';
      img.style.background = 'var(--line)';
      Store.getImage(im.id).then((d) => { if (d) img.src = d; });
    }
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectMode) { toggleSelect(noteId); return; }
      openLightbox(img.src);
    });
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

  function ddayBadgeEl(n) {
    const info = ddayInfo(n.dday);
    if (!info) return null;
    const canEdit = !trashView && !selectMode;
    const b = document.createElement(canEdit ? 'button' : 'span');
    b.className = 'ddaybadge ' + ddayClass(info);
    const d = document.createElement('span');
    d.className = 'db-d';
    d.textContent = `📅 ${info.label}`;
    const m = document.createElement('span');
    m.className = 'db-m';
    m.textContent = info.short;
    b.append(d, m);
    if (canEdit) {
      b.type = 'button';
      b.title = '디데이 날짜 바꾸기';
      b.addEventListener('click', (e) => { e.stopPropagation(); openDdayPicker(n.id); });
    }
    return b;
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
    const dd = ddayInfo(n.dday);
    const items = [
      mk(n.pinned ? '고정해제' : '📌 고정', () => togglePin(n.id)),
      mk(dd ? `📅 ${dd.label}` : '📅 디데이', () => openDdayPicker(n.id), null, dd ? '디데이 날짜 바꾸기' : '디데이 날짜 정하기'),
      dd ? mk('📅 빼기', () => clearDday(n.id), null, '디데이 빼기') : null,
      mk('☑️ 할일', () => convertNoteToTodo(n.id), null, '줄마다 체크박스로 바꾸기'),
      mk('수정', () => startEdit(n.id)),
      mk('삭제', () => deleteNote(n.id), 'danger'),
    ].filter(Boolean);
    acts.append(...items);
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

    if (selectMode) {
      wrap.classList.add('selmode');
      if (selected.has(n.id)) wrap.classList.add('selected');
      const box = document.createElement('button');
      box.type = 'button';
      box.className = 'selbox';
      box.textContent = selected.has(n.id) ? '✓' : '';
      box.setAttribute('aria-label', '이 메모 선택');
      box.addEventListener('click', (e) => { e.stopPropagation(); toggleSelect(n.id); });
      wrap.appendChild(box);
    }

    const bubbleWrap = document.createElement('div');
    bubbleWrap.className = 'bubblewrap';

    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (n.pinned && !trashView ? ' pinned' : '');
    const badge = ddayBadgeEl(n);
    if (badge) bubble.appendChild(badge);
    bubble.appendChild(bodyEl(n, ts));
    const urls = urlsOf(n.text);
    if (urls.length) bubble.appendChild(linkCardEl(urls[0]));
    const imgs = imagesOf(n);
    if (imgs.length) {
      const gal = document.createElement('div');
      gal.className = 'imgrid' + (imgs.length > 1 ? ' multi' : '');
      imgs.forEach((im) => gal.appendChild(thumbEl(im, n.id)));
      bubble.appendChild(gal);
    }
    bubbleWrap.appendChild(bubble);
    if (!selectMode) bubbleWrap.appendChild(toolsEl(n));

    const time = document.createElement('div');
    time.className = 'time';
    const t1 = document.createElement('span');
    t1.textContent = fmtTime(n.t);
    time.appendChild(t1);
    const flags = document.createElement('span');
    flags.className = 'flags';
    const fl = [];
    if (n.pinned && !trashView) fl.push('📌');
    if (n.merged) fl.push('🧩');
    if (n.edited) fl.push('수정됨');
    if (trashView) fl.push('🗑');
    flags.textContent = fl.join(' ');
    if (fl.length) time.appendChild(flags);

    wrap.append(time, bubbleWrap);
    wrap.addEventListener('click', (e) => {
      if (selectMode) {
        // 선택 모드에서는 카드 어디를 눌러도 선택 (사진·할일도 포함)
        if (e.target.closest('button,a')) return;
        toggleSelect(n.id);
        return;
      }
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
      { id: 'dday', label: '📅 디데이', n: live.filter((x) => ddayInfo(x.dday)).length },
      { id: 'pin', label: '📌 고정', n: live.filter((x) => x.pinned).length },
      { id: 'link', label: '🔗 링크', n: live.filter((x) => urlsOf(x.text).length).length },
      { id: 'img', label: '🖼️ 사진', n: live.filter((x) => imagesOf(x).length).length },
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
      b.addEventListener('click', () => { filter = d.id; render(); listEl.scrollTop = 0; });
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

  function renderBanner() {
    const el = $('#ddayBanner');
    const data = trashView ? null : ddayBannerData();
    if (!data || (prefs.ddayBannerOff && prefs.ddayBannerOff === data.sig)) { el.hidden = true; return; }
    el.className = 'ddaybanner ' + ddayClass(data.info);
    el.dataset.noteId = data.note.id;
    el.textContent = '';
    const d = document.createElement('b');
    d.className = 'db-dday';
    d.textContent = `📅 ${data.info.label}`;
    const t = document.createElement('span');
    t.className = 'db-title';
    t.textContent = noteTitle(data.note);
    const dt = document.createElement('span');
    dt.className = 'db-date';
    dt.textContent = data.info.short;
    el.append(d, t, dt);
    if (data.extra > 0) {
      const m = document.createElement('span');
      m.className = 'db-more';
      m.textContent = '+' + data.extra;
      el.append(m);
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'dbx';
    x.textContent = '✕';
    x.setAttribute('aria-label', '디데이 배너 접기');
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      prefs.ddayBannerOff = data.sig;
      persist();
      renderBanner();
      showToast('배너를 접었어요 · 디데이를 새로 넣으면 다시 떠요');
    });
    el.append(x);
    el.hidden = false;
  }

  function bannerStateText() {
    if (!ddayBannerData()) return '디데이 메모를 넣으면 여기에 떠요';
    return prefs.ddayBannerOff ? '접힘 — 눌러서 다시 표시' : '가장 가까운 디데이를 상단에 표시';
  }

  function render() {
    if (trashView && selectMode) { selectMode = false; selected.clear(); }
    const ts = terms();
    const scroller = listEl;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    const keepTop = scroller.scrollTop;

    listEl.innerHTML = '';
    renderChips();
    renderBanner();
    $('#totalBadge').textContent = notes.filter((n) => !n.deleted).length;
    $('#btnMerge').hidden = trashView;
    composerVisible(!trashView);
    updateMergeBar();

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
          '<span>↵ 버튼으로 줄바꿈, 상단 ⇅ 로 메모 합치기</span>' +
          '<span>링크는 자동으로 카드가 되고, 🖼️ 로 사진 첨부</span></div>';
      } else if (trashView) {
        empty.innerHTML = '<div class="big">🗑️</div><b>휴지통이 비어 있어요</b>';
      } else if (filter === 'dday' && !query.trim() && !activeTag) {
        empty.innerHTML =
          '<div class="big">📅</div><b>디데이 메모가 없어요</b>' +
          '<small>입력창의 📅 를 눌러 날짜를 붙이면, 여기에 다가오는 순서로 모여요.</small>';
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

    if (filter === 'dday' && !activeTag) {
      // 다가오는 순서로 한 줄로 — 다가오는 일정과 지난 일정을 머리말로 나눈다
      const rows = shown.map((n) => ({ n, info: ddayInfo(n.dday) })).sort((a, b) => ddayOrder(a.info, b.info));
      let grp = null;
      rows.forEach((row) => {
        const g = row.info && row.info.diff >= 0 ? 'up' : 'past';
        if (g !== grp) {
          grp = g;
          const head = document.createElement('div');
          head.className = 'sectionhead';
          head.textContent = g === 'up' ? '📅 다가오는' : '📅 지난 일정';
          listEl.appendChild(head);
        }
        listEl.appendChild(msgEl(row.n, ts));
      });
      updateQcount(shown.length, notes.filter((n) => !n.deleted).length);
      requestAnimationFrame(() => { scroller.scrollTop = keepTop; });
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
    else requestAnimationFrame(() => { scroller.scrollTop = keepTop; });
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

  /* ---------------- 선택 모드 · 메모 합치기 ---------------- */
  function updateMergeBar() {
    const bar = $('#mergebar');
    const btn = $('#btnMerge');
    if (!bar || !btn) return;
    bar.hidden = !selectMode;
    const n = selected.size;
    $('#mergeCount').textContent = n ? `${n}개 선택` : '0개 선택';
    const go = $('#mergeGo');
    go.disabled = n < 2;
    go.textContent = n ? `선택한 ${n}개 합치기` : '선택한 0개 합치기';
    btn.classList.toggle('on', selectMode);
    const label = selectMode ? '취소' : '합치기';
    btn.innerHTML = `<span class="mi">${selectMode ? '✕' : '⇅'}</span><span class="mlabel">${label}</span>`;
    btn.setAttribute('aria-label', selectMode ? '합치기 취소' : '메모 합치기');
    $('#composer').classList.toggle('selmode', selectMode && !trashView);
  }

  function enterSelect() {
    if (trashView) { showToast('휴지통에서는 합치기를 쓸 수 없어요'); return; }
    if (editId) cancelEdit();
    selectMode = true;
    selected.clear();
    render();
    showToast('메모 카드를 눌러 고르세요 · 시간순으로 합쳐요');
  }

  function exitSelect() {
    selectMode = false;
    selected.clear();
    render();
  }

  function toggleSelect(id) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    const el = listEl.querySelector(`.msg[data-id="${id}"]`);
    if (el) {
      const on = selected.has(id);
      el.classList.toggle('selected', on);
      const box = el.querySelector('.selbox');
      if (box) box.textContent = on ? '✓' : '';
    }
    updateMergeBar();
  }

  function focusNote(id) {
    requestAnimationFrame(() => {
      const el = listEl.querySelector(`.msg[data-id="${id}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1900);
    });
  }

  function mergeSelected() {
    if (!selectMode) return;
    const ids = Array.from(selected);
    const picks = notes.filter((n) => ids.includes(n.id) && !n.deleted).sort((a, b) => a.t - b.t);
    if (picks.length < 2) { showToast('두 개 이상 골라 주세요'); return; }

    const delOrig = $('#mergeDelOrig').checked;
    // 전부 할일 메모면 빈 줄 없이 촘촘하게 이어 붙여 하나의 체크리스트로 만든다
    const allTodo = picks.every((n) => {
      const lines = n.text.split('\n').filter((l) => l.trim());
      return lines.length > 0 && lines.every((l) => TODO_RE.test(l));
    });
    const text = picks.map((n) => n.text.replace(/\s+$/, '')).filter((t) => t.length).join(allTodo ? '\n' : '\n\n');
    const imgs = [];
    picks.forEach((n) => imagesOf(n).forEach((im) => imgs.push({ id: im.id, w: im.w, h: im.h })));

    const merged = {
      id: uid(),
      t: Date.now(),
      text,
      pinned: picks.some((n) => n.pinned),
      deleted: false,
      merged: picks.length,
    };
    if (imgs.length) merged.imgs = imgs;
    // 고른 메모에 디데이가 있으면 가장 가까운 것을 새 메모에 따라가게 한다
    const picksDday = picks
      .map((n) => ({ n, info: ddayInfo(n.dday) }))
      .filter((x) => x.info)
      .sort((a, b) => ddayOrder(a.info, b.info));
    if (picksDday.length) merged.dday = picksDday[0].n.dday;
    const before = picks.map((n) => ({ id: n.id, deleted: !!n.deleted, delAt: n.delAt }));

    notes.push(merged);
    if (delOrig) picks.forEach((n) => { n.deleted = true; n.delAt = Date.now(); });

    selectMode = false;
    selected.clear();
    editId = null;
    query = '';
    qEl.value = '';
    $('#qclear').hidden = true;
    filter = 'all';
    activeTag = '';
    persist();
    render();
    focusNote(merged.id);

    showToast(
      `${picks.length}개 메모를 하나로 합쳤어요${delOrig ? ' · 원본은 휴지통' : ''}`,
      '실행취소',
      () => {
        notes = notes.filter((x) => x.id !== merged.id);
        before.forEach((b) => {
          const n = notes.find((x) => x.id === b.id);
          if (!n) return;
          n.deleted = b.deleted;
          if (b.delAt) n.delAt = b.delAt; else delete n.delAt;
        });
        persist();
        render();
        showToast('합치기를 취소했어요');
      },
      9000,
    );
  }

  function addNote(text, img, dday) {
    const clean = text.replace(/\s+$/, '');
    if (!clean && !img) return;
    const n = {
      id: uid(),
      t: Date.now(),
      text: clean,
      pinned: false,
      deleted: false,
    };
    if (dday && parseDday(dday)) n.dday = dday;
    if (img) {
      const id = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const rec = { id, w: img.w, h: img.h };
      if (fallback) rec.data = img.data;
      n.imgs = [rec];
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

  // 메모 한 장을 줄마다 체크박스가 붙는 할일 목록으로 바꾼다 (합친 메모도 한 번에)
  function convertNoteToTodo(id) {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    const before = n.text;
    const next = toTodoText(before);
    if (!next) { showToast('바꿀 내용이 없어요'); return; }
    if (next === before) { showToast('이미 줄마다 할일이에요'); return; }
    n.text = next;
    n.edited = true;
    persist();
    render();
    const count = next.split('\n').length;
    showToast(`할일 ${count}개로 바꿨어요`, '실행취소', () => {
      n.text = before;
      persist();
      render();
      showToast('할일로 바꾸기를 되돌렸어요');
    }, 9000);
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
    const imgs = imageIds(n);
    notes = notes.filter((x) => x.id !== id);
    // 합친 메모가 같은 사진을 같이 쓰고 있으면 사진 데이터는 지우지 않는다
    imgs.forEach((imgId) => {
      if (!notes.some((o) => imageIds(o).includes(imgId))) Store.delImage(imgId);
    });
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
    pendingDday = parseDday(n.dday) ? n.dday : '';
    updateDdayChip();
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
    pendingDday = '';
    updateDdayChip();
    $('#ddayInput').value = '';
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
    if (pendingDday && parseDday(pendingDday)) n.dday = pendingDday;
    else delete n.dday;
    if (pendingImage) {
      const id = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const rec = { id, w: pendingImage.w, h: pendingImage.h };
      if (fallback) rec.data = pendingImage.data;
      n.imgs = imagesOf(n).concat([rec]);
      delete n.img;
      Store.putImage(id, pendingImage.data);
      pendingImage = null;
      hideAttach();
    }
    persist();
    cancelEdit();
    render();
    showToast('수정했어요');
  }

  /* ---------------- 디데이 입력 (입력창·카드) ---------------- */
  function updateDdayChip() {
    const box = $('#ddayChip');
    if (!pendingDday) { box.hidden = true; return; }
    const info = ddayInfo(pendingDday);
    $('#ddayChipText').textContent = `📅 ${pendingDday}${info ? `  (${info.label})` : ''}`;
    box.className = 'ddaychip ' + ddayClass(info);
    box.hidden = false;
  }

  // noteId 없이 부르면 지금 입력창에 붙일 날짜를 고른다
  function openDdayPicker(noteId) {
    const el = $('#ddayInput');
    ddayTargetId = noteId || null;
    const n = noteId ? notes.find((x) => x.id === noteId) : null;
    el.value = n ? (parseDday(n.dday) ? n.dday : '') : pendingDday;
    try {
      if (typeof el.showPicker === 'function') { el.showPicker(); return; }
    } catch (e) { /* 아래 방식으로 */ }
    try { el.focus(); el.click(); } catch (e) { /* ignore */ }
  }

  function clearDday(id) {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    delete n.dday;
    n.edited = true;
    persist();
    render();
    showToast('디데이를 뺐어요');
  }

  function jumpToNote(id) {
    let el = listEl.querySelector(`.msg[data-id="${id}"]`);
    if (!el) {
      if (editId) cancelEdit();
      if (selectMode) { selectMode = false; selected.clear(); }
      trashView = false;
      query = '';
      qEl.value = '';
      $('#qclear').hidden = true;
      activeTag = '';
      filter = 'dday';
      render();
    }
    focusNote(id);
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
        if (Array.isArray(raw.imgs) && raw.imgs.length) {
          n.imgs = raw.imgs.filter((i) => i && i.id).map((i) => ({ id: i.id, w: i.w, h: i.h }));
          if (raw.merged) n.merged = raw.merged;
        }
        if (raw.img && raw.img.id && !n.imgs) n.imgs = [{ id: raw.img.id, w: raw.img.w, h: raw.img.h }];
        if (raw.dday && parseDday(raw.dday)) n.dday = raw.dday;
        if (raw.merged) n.merged = raw.merged;
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
    $('#bannerState').textContent = bannerStateText();
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
    addNote(text, img, pendingDday);
    inputEl.value = '';
    pendingDday = '';
    updateDdayChip();
    hideAttach();
    autosize();
    inputEl.focus();
  }

  // 닫힌 입력창에서도 커서 자리에 줄바꿈을 넣는다
  function insertNewline() {
    const el = inputEl;
    const start = el.selectionStart == null ? el.value.length : el.selectionStart;
    const end = el.selectionEnd == null ? start : el.selectionEnd;
    el.value = el.value.slice(0, start) + '\n' + el.value.slice(end);
    const pos = start + 1;
    el.focus();
    try { el.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
    autosize();
  }

  /* ---------------- 초기화 ---------------- */
  async function init() {
    await Store.init();
    const saved = await Store.load();
    if (saved) {
      notes = Array.isArray(saved.notes) ? saved.notes : [];
      prefs = Object.assign({ theme: 'dark', ddayBannerOff: '' }, saved.prefs || {});
    }
    // 휴지통 자동 정리
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    notes = notes.filter((n) => !(n.deleted && n.delAt && n.delAt < cutoff));
    // 예전 단일 img 형식을 imgs 배열로 맞춰 둔다
    notes.forEach((n) => {
      if (!Array.isArray(n.imgs) || !n.imgs.length) {
        const list = imagesOf(n);
        if (list.length) n.imgs = list;
      }
      if (Array.isArray(n.imgs) && n.imgs.length && n.img) delete n.img;
    });
    applyTheme();
    $('#mergeDelOrig').checked = prefs.mergeDelete !== false;
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
  $('#btnNewline').addEventListener('click', insertNewline);
  $('#btnMerge').addEventListener('click', () => { if (selectMode) exitSelect(); else enterSelect(); });
  $('#mergeGo').addEventListener('click', mergeSelected);
  $('#mergeDelOrig').addEventListener('change', (e) => { prefs.mergeDelete = e.target.checked; persist(); });
  $('#btnPhoto').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const img = await fileToImage(f);
    if (img) { pendingImage = img; showAttach(img.data); inputEl.focus(); }
  });
  $('#attachRemove').addEventListener('click', hideAttach);
  // ☑️ — 입력 중인 글을 '줄마다 네모' 할일로 바꾼다 (빈 칸이면 새 항목 시작)
  $('#btnTodo').addEventListener('click', () => {
    const v = inputEl.value;
    if (!v.trim()) {
      inputEl.value = '- [ ] ';
    } else {
      const before = v.replace(/\s+$/, '');
      const next = toTodoText(v) || v;
      inputEl.value = next;
      if (next !== before) {
        const count = next.split('\n').length;
        showToast(`${count}줄을 할일로 바꿨어요 — Enter로 저장`, '되돌리기', () => {
          inputEl.value = before;
          autosize();
          inputEl.focus();
          inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        }, 6000);
      }
    }
    autosize();
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  });
  $('#editCancel').addEventListener('click', cancelEdit);

  // 📅 — 입력창에 붙일 디데이 날짜 고르기
  $('#btnDday').addEventListener('click', () => openDdayPicker(null));
  $('#ddayChipClear').addEventListener('click', () => {
    pendingDday = '';
    $('#ddayInput').value = '';
    updateDdayChip();
    inputEl.focus();
  });
  $('#ddayInput').addEventListener('change', (e) => {
    const v = e.target.value || '';
    const valid = v && parseDday(v) ? v : '';
    const target = ddayTargetId;
    ddayTargetId = null;
    if (target) {
      const n = notes.find((x) => x.id === target);
      if (!n) return;
      if (!valid) { clearDday(target); return; }
      n.dday = valid;
      n.edited = true;
      persist();
      render();
      const info = ddayInfo(valid);
      showToast(`📅 ${info.label} · ${valid} 로 정했어요`);
      return;
    }
    pendingDday = valid;
    updateDdayChip();
    if (valid) {
      const info = ddayInfo(valid);
      showToast(`📅 ${info.label} (${valid}) — Enter로 메모와 함께 저장`);
    }
    inputEl.focus();
  });

  // 상단 디데이 배너 — 누르면 그 메모로
  const bannerEl = $('#ddayBanner');
  bannerEl.addEventListener('click', () => {
    const id = bannerEl.dataset.noteId;
    if (id) jumpToNote(id);
  });
  bannerEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const id = bannerEl.dataset.noteId;
    if (id) jumpToNote(id);
  });

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
    if (act === 'banner') {
      const data = ddayBannerData();
      if (prefs.ddayBannerOff) {
        prefs.ddayBannerOff = '';
        showToast('디데이 배너를 켰어요');
      } else if (data) {
        prefs.ddayBannerOff = data.sig;
        showToast('디데이 배너를 접었어요 · 디데이를 새로 넣으면 다시 떠요');
      } else {
        showToast('디데이 메모를 넣으면 배너가 떠요');
      }
      persist();
      render();
      $('#bannerState').textContent = bannerStateText();
    }
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
      if (selectMode) { exitSelect(); return; }
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
