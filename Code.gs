/**
 * 拾藏 Stash — 類 Albo 的「貼連結 → AI 抽取 → 收藏 → 分享給朋友」App
 * 中文 / ภาษาไทย 雙語
 * 後端：Google Apps Script + Google Sheets + Gemini API
 *
 * 設定：專案設定 → 指令碼屬性 → 新增 GEMINI_API_KEY
 * 部署：網頁應用程式（執行身分：我；誰可以存取：所有人）
 *       你自己用「exec網址?k=你的密鑰」開啟；朋友用分享連結「?s=…」只能看。
 *       執行 showMyLinks() 取得你的專屬網址。
 */

// ===== 設定 =====
const CONFIG = {
  MODEL: 'gemini-flash-latest',   // 可改成 'gemini-3.5-flash-lite' 更省錢
  MAX_PAGE_CHARS: 15000,
  APP_NAME: '拾藏 Stash'
};

const ITEM_COLS = ['id', 'createdAt', 'url', 'type', 'title', 'subtitle', 'summary', 'image',
  'tags', 'details', 'collections', 'wishlist', 'done', 'rating', 'pinned', 'notes', 'source'];
const COL_COLS = ['id', 'title', 'emoji', 'createdAt'];
const SHARE_COLS = ['token', 'kind', 'targetId', 'createdAt', 'revoked'];

const TYPES = ['place', 'recipe', 'film', 'tv', 'book', 'product', 'article', 'video',
  'music', 'event', 'software', 'workout', 'other'];

// ===== 網頁入口 =====
function doGet(e) {
  const p = (e && e.parameter) || {};
  let mode = 'invalid';
  if (p.s) mode = 'shared';
  else if (p.k && p.k === ownerKey_()) mode = 'owner';

  const t = HtmlService.createTemplateFromFile('Index');
  t.boot = JSON.stringify({
    mode: mode,
    key: mode === 'owner' ? p.k : '',
    share: p.s || '',
    add: mode === 'owner' ? (p.add || p.url || '') : '',
    lang: p.lang || ''
  }).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== JSON API（給 GitHub Pages 上的 App 呼叫，沒有 Google 橫幅） =====
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const API = {
      apiLoad, apiAdd, apiUpdate, apiDelete, apiAddCollection, apiDeleteCollection,
      apiShare, apiUnshare, apiShared, apiAsk, apiPing
    };
    const fn = API[req.fn];
    if (!fn) throw new Error('unknown function');
    out = { ok: true, data: fn.apply(null, req.args || []) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** 檢查密鑰是否正確（App 第一次連線用） */
function apiPing(k) { auth_(k); return { ok: true, hasKey: !!getKey_() }; }

// ===== 權限 =====
function ownerKey_() {
  const props = PropertiesService.getScriptProperties();
  let k = props.getProperty('OWNER_KEY');
  if (!k) {
    k = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    props.setProperty('OWNER_KEY', k);
  }
  return k;
}
function auth_(k) {
  if (!k || k !== ownerKey_()) throw new Error('unauthorized');
}

// ===== 資料表 =====
function db_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SHEET_ID');
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('拾藏 資料庫');
    props.setProperty('SHEET_ID', ss.getId());
    const items = ss.getSheets()[0].setName('Items');
    items.appendRow(ITEM_COLS); items.setFrozenRows(1);
  }
  ensureSheet_(ss, 'Collections', COL_COLS);
  ensureSheet_(ss, 'Shares', SHARE_COLS);
  return ss;
}
function ensureSheet_(ss, name, cols) {
  if (!ss.getSheetByName(name)) {
    const sh = ss.insertSheet(name);
    sh.appendRow(cols); sh.setFrozenRows(1);
  }
}
function sheet_(name) { return db_().getSheetByName(name); }

function readAll_(name, cols) {
  const values = sheet_(name).getDataRange().getValues();
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const o = {};
    cols.forEach((c, i) => o[c] = values[r][i]);
    out.push(o);
  }
  return out;
}

function findRow_(name, id) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const ids = sh.getRange(1, 1, last, 1).getValues();
  for (let r = 1; r < ids.length; r++) if (String(ids[r][0]) === String(id)) return r + 1;
  return -1;
}

function bool_(v) { return v === true || v === 'TRUE'; }

function toClientItem_(o) {
  let details = {};
  try { details = o.details ? JSON.parse(o.details) : {}; } catch (e) { details = {}; }
  return {
    id: String(o.id),
    createdAt: o.createdAt instanceof Date ? o.createdAt.toISOString() : String(o.createdAt),
    url: o.url, type: o.type || 'other', title: o.title, subtitle: o.subtitle,
    summary: o.summary, image: o.image,
    tags: String(o.tags || '').split(',').map(s => s.trim()).filter(Boolean),
    details: details,
    collections: String(o.collections || '').split(',').filter(Boolean),
    done: bool_(o.done), rating: Number(o.rating) || 0, pinned: bool_(o.pinned),
    notes: o.notes || '', source: o.source || ''
  };
}

// 給朋友看的版本：拿掉私人筆記、清單、釘選
function toPublicItem_(o) {
  const i = toClientItem_(o);
  delete i.notes; delete i.collections; delete i.pinned;
  return i;
}

// ===== 擁有者 API（全部需要密鑰） =====
function apiLoad(k) {
  auth_(k);
  const items = readAll_('Items', ITEM_COLS).map(toClientItem_).reverse();
  const collections = readAll_('Collections', COL_COLS).map(c => ({
    id: String(c.id), title: c.title, emoji: c.emoji || '📁'
  }));
  const shares = readAll_('Shares', SHARE_COLS)
    .filter(s => !bool_(s.revoked))
    .map(s => ({ kind: s.kind, targetId: String(s.targetId), token: s.token }));
  return { items, collections, shares, hasKey: !!getKey_(), baseUrl: ScriptApp.getService().getUrl() };
}

/** 貼上連結（或文字）→ 抓網頁 → AI 抽取（中文＋泰文）→ 存檔 */
function apiAdd(k, input, extraText) {
  auth_(k);
  input = String(input || '').trim();
  extraText = String(extraText || '').trim();
  if (!input && !extraText) throw new Error('empty');

  const isUrl = /^https?:\/\//i.test(input);
  let page = { url: '', title: '', description: '', image: '', text: '', jsonld: '' };
  if (isUrl) page = fetchPage_(input);
  else page.text = input;
  if (extraText) page.text = '[User note] ' + extraText + '\n\n' + page.text;

  const ai = extract_(page);
  const zh = ai.zh || {}, th = ai.th || {};
  const item = {
    id: Utilities.getUuid().slice(0, 8),
    createdAt: new Date(),
    url: page.url || '',
    type: TYPES.indexOf(ai.type) >= 0 ? ai.type : 'other',
    title: zh.title || ai.name || page.title || '(untitled)',
    subtitle: zh.subtitle || '',
    summary: zh.summary || '',
    image: page.image || '',
    tags: (zh.tags || []).slice(0, 8).join(','),
    details: JSON.stringify({ name: ai.name || '', mapsQuery: ai.mapsQuery || page.mapsQuery || '', zh: zh, th: th }),
    collections: '', wishlist: true, done: false, rating: 0, pinned: false,
    notes: extraText, source: page.url ? hostOf_(page.url) : 'text'
  };
  sheet_('Items').appendRow(ITEM_COLS.map(c => item[c]));
  return toClientItem_(item);
}

function apiUpdate(k, id, patch) {
  auth_(k);
  const row = findRow_('Items', id);
  if (row < 0) throw new Error('not found');
  const sh = sheet_('Items');
  const allowed = ['title', 'subtitle', 'summary', 'type', 'tags', 'collections', 'done', 'rating', 'pinned', 'notes', 'image'];
  Object.keys(patch).forEach(key => {
    if (allowed.indexOf(key) < 0) return;
    let v = patch[key];
    if (Array.isArray(v)) v = v.join(',');
    sh.getRange(row, ITEM_COLS.indexOf(key) + 1).setValue(v);
  });
  const vals = sh.getRange(row, 1, 1, ITEM_COLS.length).getValues()[0];
  const o = {}; ITEM_COLS.forEach((c, i) => o[c] = vals[i]);
  return toClientItem_(o);
}

function apiDelete(k, id) {
  auth_(k);
  const row = findRow_('Items', id);
  if (row > 0) sheet_('Items').deleteRow(row);
  revokeTarget_('item', id);
  return true;
}

function apiAddCollection(k, title, emoji) {
  auth_(k);
  const c = { id: Utilities.getUuid().slice(0, 8), title: String(title || '').trim(), emoji: emoji || '📁', createdAt: new Date() };
  if (!c.title) throw new Error('empty');
  sheet_('Collections').appendRow(COL_COLS.map(key => c[key]));
  return { id: c.id, title: c.title, emoji: c.emoji };
}

function apiDeleteCollection(k, id) {
  auth_(k);
  const row = findRow_('Collections', id);
  if (row > 0) sheet_('Collections').deleteRow(row);
  const sh = sheet_('Items');
  const colIdx = ITEM_COLS.indexOf('collections') + 1;
  const last = sh.getLastRow();
  if (last > 1) {
    const rng = sh.getRange(2, colIdx, last - 1, 1);
    rng.setValues(rng.getValues().map(r => [String(r[0]).split(',').filter(x => x && x !== id).join(',')]));
  }
  revokeTarget_('collection', id);
  return true;
}

// ===== 分享 =====
/** 建立（或取回）分享連結。kind = 'item' | 'collection' */
function apiShare(k, kind, targetId) {
  auth_(k);
  if (kind !== 'item' && kind !== 'collection') throw new Error('bad kind');
  const existing = readAll_('Shares', SHARE_COLS)
    .find(s => s.kind === kind && String(s.targetId) === String(targetId) && !bool_(s.revoked));
  let token = existing && existing.token;
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    sheet_('Shares').appendRow([token, kind, targetId, new Date(), false]);
  }
  return { token: token, url: ScriptApp.getService().getUrl() + '?s=' + token };
}

/** 停止分享（舊連結失效） */
function apiUnshare(k, kind, targetId) {
  auth_(k);
  revokeTarget_(kind, targetId);
  return true;
}

function revokeTarget_(kind, targetId) {
  const sh = sheet_('Shares');
  const vals = sh.getDataRange().getValues();
  for (let r = 1; r < vals.length; r++) {
    if (vals[r][1] === kind && String(vals[r][2]) === String(targetId) && !bool_(vals[r][4])) {
      sh.getRange(r + 1, 5).setValue(true);
    }
  }
}

/** 公開 API：朋友打開分享連結時呼叫（不需密鑰，只讀） */
function apiShared(token) {
  token = String(token || '');
  const s = readAll_('Shares', SHARE_COLS).find(x => x.token === token && !bool_(x.revoked));
  if (!s) return { ok: false };
  const all = readAll_('Items', ITEM_COLS);
  if (s.kind === 'item') {
    const it = all.find(o => String(o.id) === String(s.targetId));
    return it ? { ok: true, kind: 'item', items: [toPublicItem_(it)] } : { ok: false };
  }
  const c = readAll_('Collections', COL_COLS).find(x => String(x.id) === String(s.targetId));
  if (!c) return { ok: false };
  const items = all.filter(o => String(o.collections || '').split(',').indexOf(String(c.id)) >= 0)
    .map(toPublicItem_).reverse();
  return { ok: true, kind: 'collection', collection: { title: c.title, emoji: c.emoji || '📁' }, items: items };
}

// ===== 問 AI =====
function apiAsk(k, question, lang) {
  auth_(k);
  const L = lang === 'th' ? 'ภาษาไทย' : '繁體中文';
  const items = readAll_('Items', ITEM_COLS).map(toClientItem_);
  const lib = items.slice(-300).map(i =>
    `[${i.id}] (${i.type}) ${i.title}${i.subtitle ? ' — ' + i.subtitle : ''} | tags:${i.tags.join('/')} | ${i.done ? 'done' : 'wishlist'}${i.rating ? ' | ' + i.rating + '★' : ''} | ${String(i.summary).slice(0, 120)}`
  ).join('\n');
  const prompt = `You are the user's personal collection assistant. Their saved items:\n${lib}\n\n` +
    `Answer in ${L}. Prefer items from the collection and cite them as [id]. Be concise, use a short list. ` +
    `If nothing fits, you may give general suggestions but mark them as not from the collection.\n\nQuestion: ${question}`;
  return gemini_({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
}

// ===== 抓網頁 =====
function fetchPage_(url) {
  url = resolveUrl_(url);
  const page = { url: url, title: '', description: '', image: '', text: '', jsonld: '', social: '' };

  // IG / TikTok / Threads / Facebook / Google Maps：用官方嵌入 API 取得內容
  const soc = fetchSocial_(url);
  if (soc) {
    page.social = soc.platform;
    page.title = soc.title || '';
    page.image = soc.image || '';
    page.mapsQuery = soc.mapsQuery || '';
    page.text = soc.text || '';
    if ((page.text || '').length < 40) {
      const viaAI = urlContext_(url);   // 抓不到文字時，請 Gemini 自己去讀這個網址
      if (viaAI) page.text += '\n[Read by Gemini] ' + viaAI;
    }
    return page;
  }

  if (/youtube\.com|youtu\.be/.test(url)) {
    try {
      const r = UrlFetchApp.fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url), { muteHttpExceptions: true });
      if (r.getResponseCode() === 200) {
        const j = JSON.parse(r.getContentText());
        page.title = j.title; page.image = j.thumbnail_url;
        page.text = 'YouTube video: ' + j.title + '\nChannel: ' + j.author_name;
      }
    } catch (e) {}
  }

  try {
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true, followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept-Language': 'zh-TW,zh;q=0.9,th;q=0.8,en;q=0.7'
      }
    });
    const html = resp.getContentText();
    const meta = (prop) => {
      const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']*)["\']', 'i');
      const re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i');
      const m = html.match(re) || html.match(re2);
      return m ? decode_(m[1]) : '';
    };
    page.title = page.title || meta('og:title') || decode_((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    page.description = meta('og:description') || meta('description');
    page.image = page.image || meta('og:image') || meta('twitter:image');
    if (page.image && page.image.indexOf('//') === 0) page.image = 'https:' + page.image;

    const ld = [];
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) && ld.join('').length < 6000) ld.push(m[1].trim());
    page.jsonld = ld.join('\n').slice(0, 6000);

    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    page.text = (page.text ? page.text + '\n' : '') + decode_(body).replace(/\s+/g, ' ').trim().slice(0, CONFIG.MAX_PAGE_CHARS);
  } catch (e) {
    page.text = page.text || '(page could not be fetched; infer from the URL)';
  }
  return page;
}

// ===== 社群平台（IG / TikTok / Threads / Facebook / Google Maps） =====
const UA_BOT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** 展開短網址（vm.tiktok.com、maps.app.goo.gl、instagr.am…） */
function resolveUrl_(url) {
  const shortHosts = /^(vm\.tiktok\.com|vt\.tiktok\.com|instagr\.am|fb\.watch|maps\.app\.goo\.gl|goo\.gl|t\.co|bit\.ly|lin\.ee|threads\.net\/t|www\.threads\.net\/t)/i;
  let cur = url;
  for (let i = 0; i < 4; i++) {
    const host = hostOf_(cur);
    if (!shortHosts.test(host) && !/\/share\/|\/t\//.test(cur)) break;
    try {
      const r = UrlFetchApp.fetch(cur, { followRedirects: false, muteHttpExceptions: true, headers: { 'User-Agent': UA_MOBILE } });
      const h = r.getHeaders();
      const loc = h.Location || h.location;
      if (!loc || loc === cur) break;
      cur = loc.indexOf('http') === 0 ? loc : 'https://' + host + loc;
    } catch (e) { break; }
  }
  return cur;
}

function platformOf_(url) {
  const h = hostOf_(url);
  if (/tiktok\.com$/i.test(h)) return 'tiktok';
  if (/instagram\.com$/i.test(h)) return 'instagram';
  if (/threads\.(net|com)$/i.test(h)) return 'threads';
  if (/facebook\.com$|fb\.com$/i.test(h)) return 'facebook';
  if (/google\.[a-z.]+$/i.test(h) && /\/maps/.test(url)) return 'googlemaps';
  return '';
}

function getJson_(url, ua) {
  try {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': ua || UA_MOBILE } });
    if (r.getResponseCode() !== 200) return null;
    return JSON.parse(r.getContentText());
  } catch (e) { return null; }
}

function getHtml_(url, ua) {
  try {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': ua || UA_MOBILE, 'Accept-Language': 'zh-TW,zh;q=0.9,th;q=0.8,en;q=0.7' } });
    return r.getResponseCode() === 200 ? r.getContentText() : '';
  } catch (e) { return ''; }
}

function htmlToText_(html) {
  return decode_(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim();
}

function metaOf_(html, prop) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']*)["\']', 'i');
  const re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i');
  const m = String(html || '').match(re) || String(html || '').match(re2);
  return m ? decode_(m[1]) : '';
}

/** 回傳 { platform, title, text, image, mapsQuery } 或 null（不是社群網址） */
function fetchSocial_(url) {
  const p = platformOf_(url);
  if (!p) return null;
  const out = { platform: p, title: '', text: '', image: '', mapsQuery: '' };
  const add = (label, v) => { v = String(v || '').trim(); if (v && out.text.indexOf(v) < 0) out.text += (out.text ? '\n' : '') + label + v; };

  if (p === 'tiktok') {
    const j = getJson_('https://www.tiktok.com/oembed?url=' + encodeURIComponent(url));
    if (j) {
      out.title = j.title; out.image = j.thumbnail_url;
      add('TikTok by @', j.author_unique_id || j.author_name);
      add('Caption: ', j.title);
    }
  }

  if (p === 'instagram') {
    // 1) Meta 官方免 token 嵌入 API
    const j = getJson_('https://graph.facebook.com/v25.0/instagram_oembed?format=json&url=' + encodeURIComponent(url));
    if (j) {
      add('Instagram by @', j.author_name);
      add('Caption: ', htmlToText_(j.html).replace(/A post shared by[\s\S]*$/i, ''));
      out.image = j.thumbnail_url || '';
    }
    // 2) 嵌入頁（通常有完整說明文字和圖片）
    const code = (url.match(/instagram\.com\/(?:[^\/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/) || []);
    if (code[2]) {
      const kind = code[1] === 'reels' ? 'reel' : code[1];
      const html = getHtml_('https://www.instagram.com/' + kind + '/' + code[2] + '/embed/captioned/');
      if (html) {
        const cap = html.match(/<div class="Caption"[^>]*>([\s\S]*?)<div class="CaptionComments"/i) ||
                    html.match(/<div class="Caption"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
        if (cap) add('Caption: ', htmlToText_(cap[1]));
        const img = html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/i) || html.match(/<img[^>]+src="(https:\/\/[^"]+cdninstagram[^"]+)"/i);
        if (img && !out.image) out.image = decode_(img[1]);
      }
    }
    // 3) 分享預覽用的 og 標籤
    if (out.text.length < 40) {
      const html = getHtml_(url, UA_BOT);
      add('', metaOf_(html, 'og:description') || metaOf_(html, 'description'));
      out.title = out.title || metaOf_(html, 'og:title');
      out.image = out.image || metaOf_(html, 'og:image');
    }
  }

  if (p === 'threads') {
    const j = getJson_('https://graph.threads.com/oembed?url=' + encodeURIComponent(url.replace('threads.net', 'threads.com')));
    if (j) {
      add('Threads by @', j.author_name);
      add('Post: ', htmlToText_(j.html).replace(/Post by[\s\S]*?View on Threads/i, ''));
    }
    const html = getHtml_(url, UA_BOT);
    if (html) {
      if (out.text.length < 40) add('Post: ', metaOf_(html, 'og:description'));
      out.title = metaOf_(html, 'og:title');
      out.image = metaOf_(html, 'og:image');
    }
  }

  if (p === 'facebook') {
    const ep = /\/(reel|videos|watch)\b/.test(url) ? 'oembed_video' : 'oembed_post';
    const j = getJson_('https://graph.facebook.com/v25.0/' + ep + '?format=json&url=' + encodeURIComponent(url));
    if (j) { add('Facebook by ', j.author_name); add('Post: ', htmlToText_(j.html)); }
    const html = getHtml_(url, UA_BOT);
    if (html) {
      if (out.text.length < 40) add('Post: ', metaOf_(html, 'og:description'));
      out.title = metaOf_(html, 'og:title'); out.image = metaOf_(html, 'og:image');
    }
  }

  if (p === 'googlemaps') {
    const name = (url.match(/\/maps\/place\/([^\/@?]+)/) || [])[1];
    const q = (url.match(/[?&]q=([^&]+)/) || [])[1];
    const coords = (url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || []);
    const place = decodeURIComponent(String(name || q || '').replace(/\+/g, ' '));
    if (place) { out.title = place; out.mapsQuery = place; add('Google Maps place: ', place); }
    if (coords[1]) add('Coordinates: ', coords[1] + ',' + coords[2]);
    add('This is a place saved from Google Maps. Type must be "place".', ' ');
  }

  out.text = out.text.slice(0, CONFIG.MAX_PAGE_CHARS);
  if (out.image && out.image.indexOf('//') === 0) out.image = 'https:' + out.image;
  return out;
}

/** 請 Gemini 用 URL Context 工具自己讀網址（抓不到內容時的備援） */
function urlContext_(url) {
  try {
    return gemini_({
      contents: [{ role: 'user', parts: [{ text:
        'Open this URL and describe in detail what the post/page is about. Include the full caption text if any, ' +
        'plus every place name, address, dish, price, product, film/book title or other concrete detail mentioned. ' +
        'If you cannot access it, reply exactly: NO_ACCESS\n' + url }] }],
      tools: [{ url_context: {} }]
    }).replace(/^NO_ACCESS\s*$/, '').slice(0, 4000);
  } catch (e) {
    Logger.log('URL Context 失敗：' + e.message);
    return '';
  }
}

/** 下載圖片給 Gemini 看（圖片裡常有菜單、店名、價格） */
function imagePart_(imgUrl) {
  if (!imgUrl) return null;
  try {
    const r = UrlFetchApp.fetch(imgUrl, { muteHttpExceptions: true, headers: { 'User-Agent': UA_MOBILE } });
    if (r.getResponseCode() !== 200) return null;
    const blob = r.getBlob();
    const type = String(blob.getContentType() || '');
    const bytes = blob.getBytes();
    if (!/^image\/(jpeg|png|webp|heic|heif)/i.test(type) || bytes.length > 4 * 1024 * 1024) return null;
    return { inline_data: { mime_type: type.split(';')[0], data: Utilities.base64Encode(bytes) } };
  } catch (e) { return null; }
}

function decode_(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function hostOf_(url) {
  const m = String(url).match(/^https?:\/\/([^\/?#]+)/i);
  return m ? m[1].replace(/^www\./, '') : '';
}

// ===== AI 抽取（一次產生中文＋泰文） =====
function extract_(page) {
  const langBlock = (desc) => ({
    type: 'OBJECT', description: desc,
    properties: {
      title: { type: 'STRING', description: 'Name of the thing (restaurant, dish, film, book…). Keep proper nouns in original form; add a translation in parentheses only if helpful.' },
      subtitle: { type: 'STRING', description: 'One short line under 40 characters: area / author / director / year / price' },
      summary: { type: 'STRING', description: '2–4 sentence summary' },
      tags: { type: 'ARRAY', items: { type: 'STRING' }, description: '3–6 short tags' },
      facts: {
        type: 'ARRAY', description: 'Key facts: address, opening hours, price, runtime, author, pages…',
        items: { type: 'OBJECT', properties: { label: { type: 'STRING' }, value: { type: 'STRING' } }, required: ['label', 'value'] }
      },
      ingredients: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Recipes only' },
      steps: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Recipes / tutorials only' }
    },
    required: ['title', 'summary', 'tags']
  });
  const schema = {
    type: 'OBJECT',
    properties: {
      type: { type: 'STRING', enum: TYPES },
      name: { type: 'STRING', description: 'Original proper name as written in the source' },
      mapsQuery: { type: 'STRING', description: 'Places only: "name + city" for Google Maps search' },
      zh: langBlock('All text in Traditional Chinese (繁體中文)'),
      th: langBlock('All text in Thai (ภาษาไทย)')
    },
    required: ['type', 'name', 'zh', 'th']
  };

  const prompt =
    'You are a content extractor. Decide what single "thing" this page/text is mainly about and turn it into a structured card.\n' +
    `- type: one of ${TYPES.join(', ')}.\n` +
    '- Fill BOTH the zh (Traditional Chinese) and th (Thai) blocks with the same information, naturally written in each language.\n' +
    '- Keep proper nouns (shop names, addresses, film titles) in their original form.\n' +
    '- If the page lists several places/items, pick the main one and mention others in the summary.\n' +
    '- Do not invent facts you are unsure about.\n\n' +
    (page.social ? `- This is a ${page.social} post. The caption and the attached image are the main content; identify the place/dish/product/etc. being shown. Use the post caption language only as a source, still output zh and th.\n` : '') +
    (page.mapsQuery ? `- mapsQuery should be: ${page.mapsQuery}\n` : '') +
    `URL: ${page.url}\nTitle: ${page.title}\nDescription: ${page.description || ''}\n` +
    (page.jsonld ? `Structured data: ${page.jsonld}\n` : '') +
    `Content: ${page.text}`;

  const img = page.social ? imagePart_(page.image) : null;
  const req = (withSchema) => gemini_({
    contents: [{ role: 'user', parts: (img ? [img] : []).concat([{ text: prompt + (withSchema ? '' :
      '\n\nReturn ONLY one JSON object with keys: type, name, mapsQuery, zh, th. ' +
      'zh and th each have: title, subtitle (one short line, under 40 characters), summary (2-4 sentences), tags[] (3-6), facts[{label,value}], ingredients[], steps[]. Keep every field concise; never repeat phrases.') }]) }],
    generationConfig: withSchema
      ? { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2, maxOutputTokens: 6000 }
      : { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 6000 }
  });

  // 先用純 JSON 模式（實測較穩）；失敗才改用結構化輸出再試一次
  let out = '';
  const modes = [false, true];
  for (let m = 0; m < modes.length; m++) {
    const withSchema = modes[m];
    try {
      out = req(withSchema);
      const obj = parseJson_(out);
      if (obj && (obj.zh || obj.th)) {
        if (!obj.zh) obj.zh = obj.th;
        if (!obj.th) obj.th = obj.zh;
        return obj;
      }
      Logger.log('AI 回傳無法解析（' + (withSchema ? 'schema' : 'json') + '）：' + String(out).slice(0, 1500));
    } catch (e) {
      Logger.log('AI 呼叫失敗（' + (withSchema ? 'schema' : 'json') + '）：' + e.message);
      if (m === modes.length - 1) throw e;
    }
  }
  const fb = { title: page.title, summary: page.description, tags: [] };
  return { type: 'other', name: page.title, zh: fb, th: fb };
}

/** 容錯解析：去掉 ```json 圍欄，抓第一個 { 到最後一個 } */
function parseJson_(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return null;
}

function getKey_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
}

function gemini_(body) {
  const key = getKey_();
  if (!key) throw new Error('GEMINI_API_KEY missing (Project settings → Script properties)');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.MODEL + ':generateContent';
  const resp = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body)
  });
  const code = resp.getResponseCode();
  const j = JSON.parse(resp.getContentText());
  if (code !== 200) throw new Error('Gemini ' + code + ': ' + (j.error && j.error.message));
  const cand = (j.candidates && j.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');
  if (!text) {
    const why = cand.finishReason || (j.promptFeedback && j.promptFeedback.blockReason) || 'empty';
    throw new Error('Gemini 沒有回傳內容（' + why + '）');
  }
  if (cand.finishReason && cand.finishReason !== 'STOP') Logger.log('Gemini finishReason: ' + cand.finishReason);
  return text;
}

// ===== 在編輯器執行 =====
/** 第一次設定：建立資料庫並測試 AI 抽取 */
function testSetup() {
  Logger.log('資料庫：' + db_().getUrl());
  const item = apiAdd(ownerKey_(), 'https://en.wikipedia.org/wiki/Spirited_Away');
  Logger.log(JSON.stringify(item, null, 2));
  showMyLinks();
}

/** 單獨測 AI：看 Gemini 原始回應（抽取失敗時用來除錯） */
function testAI() {
  Logger.log('模型：' + CONFIG.MODEL);
  Logger.log(gemini_({ contents: [{ role: 'user', parts: [{ text: '用繁體中文和泰文各說一句「你好」' }] }] }));
  const page = fetchPage_('https://en.wikipedia.org/wiki/Spirited_Away');
  Logger.log('網頁標題：' + page.title + '｜內文長度：' + page.text.length);
  const r = extract_(page);
  Logger.log('類型：' + r.type + '｜中文：' + (r.zh && r.zh.title) + '｜泰文：' + (r.th && r.th.title));
  Logger.log('中文摘要：' + (r.zh && r.zh.summary));
}

/** 測試社群連結：把下面網址換成你的 IG / TikTok / Threads 連結再執行 */
function testLink() {
  const url = 'https://www.tiktok.com/@scout2015/video/6718335390845095173';
  const page = fetchPage_(url);
  Logger.log('平台：' + (page.social || '一般網頁') + '｜展開後網址：' + page.url);
  Logger.log('圖片：' + (page.image || '（無）'));
  Logger.log('抓到的文字：\n' + String(page.text).slice(0, 1500));
  const r = extract_(page);
  Logger.log('AI 整理 → 類型：' + r.type + '｜中文：' + (r.zh && r.zh.title) + '｜泰文：' + (r.th && r.th.title));
  Logger.log('中文摘要：' + (r.zh && r.zh.summary));
}

/** 部署後執行：印出 App 設定需要的資訊（不要分享給別人） */
function showMyLinks() {
  const base = ScriptApp.getService().getUrl() || '(尚未部署，請先部署為網頁應用程式)';
  Logger.log('① API 網址（貼到 config.js 的 API_URL）：' + base);
  Logger.log('② 你的密鑰（第一次開 App 時貼上）：' + ownerKey_());
  Logger.log('③ 一鍵登入網址（把 你的網站 換成 GitHub Pages 網址）：https://你的網站/#k=' + ownerKey_());
}

/** 密鑰外洩時執行：換一組新密鑰（舊的專屬網址失效，朋友的分享連結不受影響） */
function resetOwnerKey() {
  PropertiesService.getScriptProperties().deleteProperty('OWNER_KEY');
  showMyLinks();
}
