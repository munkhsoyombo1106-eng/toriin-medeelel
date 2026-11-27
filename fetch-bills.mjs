// d.parliament.mn (Цахим парламент)-ийн "Өргөн мэдүүлсэн төслүүд" ба "Боловсруулж буй төслүүд"
// жагсаалтыг нээлттэй API-аас татаж data/bills.json-д хадгалж,
// шинэ төсөл болон үе шат өөрчлөгдсөнийг data/bills-changes.json-д бүртгэнэ.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const API = 'https://api-d.parliament.mn/tusul/tusulList';
const APP_ID = '56cc90a2-83a0-4e1f-994d-7fdebfdfbf68';
const FILE_BASE = 'https://lawforum.parliament.mn';
const LISTS = {
  submitted: { title: 'Өргөн мэдүүлсэн төслүүд', parentId: '6101970e-2fb0-4394-8113-db13d7374fb6' },
  drafting: { title: 'Боловсруулж буй төслүүд', parentId: 'eb5c6c00-0440-4b6d-aef5-8df235d5da13' },
};
const KEEP_DAYS = 90;
mkdirSync('data', { recursive: true });

async function fetchPage(parentId, page, limit) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://d.parliament.mn', Referer: 'https://d.parliament.mn/' },
        body: JSON.stringify({ appId: APP_ID, parentId, publishDate: new Date().toISOString(), page: String(page), limit: String(limit) }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(res => setTimeout(res, 5000 * attempt));
    }
  }
}

function slim(t, listKey) {
  const c = t.creator || {};
  const initiator = [c.name1 && c.name1.trim(), c.name && c.name.trim()].filter(Boolean).join(' ');
  const files = [];
  for (const a of (t.jdata && t.jdata.attachments) || []) {
    for (const f of a.files || []) {
      files.push({ category: a.category && a.category.title, name: f.fileName, url: f.fileUrl ? FILE_BASE + f.fileUrl : null });
    }
  }
  return {
    id: t.id,
    list: listKey,
    name: (t.name || '').trim(),
    type: (t.name1 || '').trim(),
    initiator,
    step: (t.jdata && t.jdata.step) || null,
    publishDate: t.publishDate,
    lawDate: t.lawDate,
    updatedAt: t.updatedAt,
    url: `https://d.parliament.mn/tusul/${t.id}`,
    files,
  };
}

const now = new Date().toISOString();
const result = { checked_at: now, lists: {} };
for (const [key, cfg] of Object.entries(LISTS)) {
  const limit = 100;
  const first = await fetchPage(cfg.parentId, 1, limit);
  let items = first.list || [];
  const pages = Math.ceil((first.count || 0) / limit);
  for (let p = 2; p <= pages; p++) {
    const r = await fetchPage(cfg.parentId, p, limit);
    items = items.concat(r.list || []);
  }
  if (!items.length) throw new Error(`${cfg.title}: жагсаалт хоосон ирлээ`);
  result.lists[key] = { title: cfg.title, count: first.count, items: items.map(t => slim(t, key)) };
}

// Өмнөх төлөвтэй харьцуулах
const prev = existsSync('data/bills.json') ? JSON.parse(readFileSync('data/bills.json', 'utf8')) : null;
const changesFile = 'data/bills-changes.json';
let changes = existsSync(changesFile) ? JSON.parse(readFileSync(changesFile, 'utf8')) : [];
if (prev) {
  const prevById = new Map();
  for (const l of Object.values(prev.lists)) for (const it of l.items) prevById.set(it.id, it);
  for (const l of Object.values(result.lists)) {
    for (const it of l.items) {
      const old = prevById.get(it.id);
      const base = { detected_at: now, id: it.id, name: it.name, initiator: it.initiator, url: it.url, list: it.list, publishDate: it.publishDate };
      if (!old) changes.push({ ...base, kind: 'new', step: it.step });
      else if (old.list !== it.list) changes.push({ ...base, kind: 'moved', from_list: old.list, from_step: old.step, step: it.step });
      else if (old.step !== it.step) changes.push({ ...base, kind: 'step', from_step: old.step, step: it.step });
    }
  }
}
const cutoff = Date.now() - KEEP_DAYS * 864e5;
changes = changes.filter(c => Date.parse(c.detected_at) >= cutoff);

writeFileSync('data/bills.json', JSON.stringify(result, null, 1));
writeFileSync(changesFile, JSON.stringify(changes, null, 1));
console.log(`OK: ${Object.values(result.lists).map(l => `${l.title} ${l.items.length}/${l.count}`).join(', ')}; өөрчлөлт нийт ${changes.length}`);
