// d.parliament.mn (Цахим парламент)-ийн "Өргөн мэдүүлсэн төслүүд" ба "Боловсруулж буй төслүүд"
// жагсаалтыг нээлттэй API-аас татаж data/bills.json-д хадгалж,
// шинэ төсөл болон үе шат өөрчлөгдсөнийг data/bills-changes.json-д бүртгэнэ.
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';

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

// ---- "Төрийн мэдээлэл"-тэй тулгах (албан ёсны эх сурвалж давуу) ----
// d.parliament.mn-ийн үе шат хоцорч шинэчлэгддэг тул репод хадгалсан дугааруудын бүрэн текстээс
// (data/<он>-no<N>.txt) тухайн төслийн нэртэй хууль батлагдаж нийтлэгдсэн эсэх, эсвэл
// "Хуулийн төсөл буцаах тухай" тогтоолоор буцаагдсан эсэхийг хайна.
const norm = s => (s || '').toUpperCase().replace(/Ё/g, 'Е').replace(/[^А-ЯӨҮA-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
function coreTitle(name) {
  let n = norm(name);
  n = n.replace(/ ХУУЛ(ИЙН|Ь) ШИНЭЧИЛСЭН НАЙРУУЛГ(ЫН ТӨСӨЛ|А)$/, ' ШИНЭЧИЛСЭН НАЙРУУЛГА');
  n = n.replace(/ ШИНЭЧИЛСЭН НАЙРУУЛГЫН ТӨСӨЛ$/, ' ШИНЭЧИЛСЭН НАЙРУУЛГА');
  n = n.replace(/ (ХУУЛИЙН )?ТӨСӨЛ$/, '');
  return n;
}
const MONTH_RE = /(\d{4}) ОНЫ (\d{1,2}) (?:ДУГААР|ДҮГЭЭР) (?:[^ ]+ ){0,12}?САРЫН (\d{1,2})/;
function loadIssues() {
  const meta = existsSync('data/latest.json') ? JSON.parse(readFileSync('data/latest.json', 'utf8')) : {};
  const known = new Map((meta.recent_issues || []).map(i => [`${i.year}-${i.no}`, i]));
  const issues = [];
  for (const f of readdirSync('data')) {
    const m = f.match(/^(\d{4})-no(\d+)\.txt$/);
    if (!m) continue;
    const info = known.get(`${+m[1]}-${+m[2]}`) || { year: +m[1], no: +m[2] };
    const lines = readFileSync(`data/${f}`, 'utf8').split('\n')
      .filter(l => !/[᠀-᢯]/.test(l) && !/îí|ÒªÐÈÉÍ/.test(l) && !/^\s*\d+\s*$/.test(l));
    // Баримт бичиг бүрийг толгойгоор нь хуваана
    const docs = [];
    let cur = null;
    for (const l of lines) {
      const h = l.trim();
      if (/^МОНГОЛ УЛСЫН (ХУУЛЬ|ИХ ХУРЛЫН ТОГТООЛ|ЕРӨНХИЙЛӨГЧИЙН ЗАРЛИГ|ЗАСГИЙН ГАЗРЫН ТОГТООЛ)$/.test(h)) {
        cur = { kind: h.includes('ХУУЛЬ') ? 'law' : 'other', text: '' };
        docs.push(cur);
      } else if (cur) cur.text += ' ' + l;
    }
    for (const d of docs) {
      d.n = norm(d.text);
      d.head = d.n.slice(0, 600);
      const dm = d.n.slice(0, 300).match(MONTH_RE);
      d.date = dm ? `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}` : null;
      d.isReturn = d.kind === 'other' && /ХУУЛИЙН ТӨСӨЛ (БУЦААХ|ХЭЛЭЛЦЭХГҮЙ БАЙХ)/.test(d.head);
    }
    issues.push({ ...info, docs });
  }
  return issues;
}
const issues = loadIssues();
const allItems = Object.values(result.lists).flatMap(l => l.items);
const titleCount = new Map();
for (const it of allItems) titleCount.set(coreTitle(it.name), (titleCount.get(coreTitle(it.name)) || 0) + 1);
for (const it of allItems) {
  const t = coreTitle(it.name);
  // Зөвхөн өргөн мэдүүлсэн төсөл батлагдах/буцаагдах боломжтой
  if (it.list !== 'submitted' || t.length < 12) continue;
  const since = (it.publishDate || '').slice(0, 10);
  for (const iss of issues) {
    for (const d of iss.docs) {
      // Огноогүй блок = ГАРЧИГ (агуулга биш) — алгасна; төсөл өргөн мэдүүлэхээс өмнө баталсан хууль таарахгүй
      if (!d.date || (since && d.date < since)) continue;
      let status = null;
      if (d.kind === 'law' && d.head.includes(t)) status = 'passed';
      else if (d.isReturn && d.n.includes(t)) status = 'returned';
      if (!status) continue;
      const prevOfficial = it.official;
      if (prevOfficial && prevOfficial.issue_date >= (iss.date || '')) continue;
      it.official = {
        status,
        issue: iss.total ? `№${iss.no}(${iss.total})` : `№${iss.no}`,
        issue_date: iss.date || null,
        issue_url: iss.url || null,
        doc_date: d.date,
        // Нэг ижил нэртэй (жишээ нь "...хуульд нэмэлт оруулах тухай") олон төсөл байж болох тул
        // таарсан нэр давхцаж байвал тоймд "баталгаажуулах шаардлагатай" гэж тэмдэглэнэ.
        ambiguous: titleCount.get(t) > 1 || /НЭМЭЛТ|ӨӨРЧЛӨЛТ/.test(t),
      };
    }
  }
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
      const oldOff = old && old.official ? `${old.official.status}|${old.official.issue}` : null;
      const newOff = it.official ? `${it.official.status}|${it.official.issue}` : null;
      if (newOff && newOff !== oldOff) changes.push({ ...base, kind: 'official', step: it.step, official: it.official });
    }
  }
  // Жагсаалтаас хасагдсан (батлагдсан, буцаагдсан, татагдсан байж болзошгүй)
  const curIds = new Set(allItems.map(i => i.id));
  for (const l of Object.values(prev.lists)) {
    for (const it of l.items) {
      if (!curIds.has(it.id)) {
        changes.push({ detected_at: now, id: it.id, name: it.name, initiator: it.initiator, url: it.url, list: it.list,
          publishDate: it.publishDate, kind: 'removed', from_step: it.step, official: it.official || null });
      }
    }
  }
}
const cutoff = Date.now() - KEEP_DAYS * 864e5;
changes = changes.filter(c => Date.parse(c.detected_at) >= cutoff);

writeFileSync('data/bills.json', JSON.stringify(result, null, 1));
writeFileSync(changesFile, JSON.stringify(changes, null, 1));
console.log(`OK: ${Object.values(result.lists).map(l => `${l.title} ${l.items.length}/${l.count}`).join(', ')}; өөрчлөлт нийт ${changes.length}`);
