// "Төрийн мэдээлэл" эмхэтгэлийн хамгийн сүүлийн дугаарыг parliament.mn-ээс уншиж,
// data/latest.json ба data/<дугаар>.txt файлд хадгална.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const LIST_URL = 'https://parliament.mn/news/list?category=176';
mkdirSync('data', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();

// 1. Жагсаалтаас хамгийн шинэ дугаарыг олох (тойм биш, "№NN(NNNN)" гэсэн бичлэг)
await page.goto(LIST_URL, { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForTimeout(3000);
const items = await page.$$eval('a[href*="toriin-medeelel-emkhetgeliin"]', as =>
  as.map(a => ({ href: a.href, text: (a.closest('div')?.innerText || a.innerText || '').trim() }))
);
const issues = [];
for (const it of items) {
  const m = it.href.match(/toriin-medeelel-emkhetgeliin-(\d{4})-ony-no(\d+)-(\d+)/);
  if (m && !issues.find(x => x.url === it.href)) {
    const d = it.text.match(/\d{4}-\d{2}-\d{2}/);
    issues.push({ year: +m[1], no: +m[2], total: +m[3], url: it.href, date: d ? d[0] : null });
  }
}
issues.sort((a, b) => b.year - a.year || b.no - a.no);
if (!issues.length) {
  writeFileSync('data/error.txt', `${new Date().toISOString()}\nЖагсаалтаас дугаар олдсонгүй.\n` + (await page.content()).slice(0, 5000));
  await browser.close();
  process.exit(1);
}
const latest = issues[0];

// Өмнө нь уншсан бол дахин татахгүй
if (existsSync('data/latest.json')) {
  const prev = JSON.parse(readFileSync('data/latest.json', 'utf8'));
  if (prev.url === latest.url && prev.toc) { await browser.close(); process.exit(0); }
}

// 2. Дугаарын хуудаснаас PDF холбоос олох
await page.goto(latest.url, { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForTimeout(3000);
const pageText = await page.evaluate(() => document.body.innerText);
if (!latest.date) { const d = pageText.match(/\d{4}-\d{2}-\d{2}/); latest.date = d ? d[0] : null; }
const pdfUrl = await page.$$eval('a[href]', as => {
  const a = as.find(x => /\.pdf(\?|$)/i.test(x.href)) || as.find(x => /файл татах/i.test(x.innerText));
  return a ? a.href : null;
});

// 3. PDF-ийг татаж текст болгох
let fullText = '', toc = '';
if (pdfUrl) {
  const resp = await page.request.get(pdfUrl, { timeout: 120000 });
  writeFileSync('/tmp/issue.pdf', await resp.body());
  execFileSync('pdftotext', ['-layout', '/tmp/issue.pdf', '/tmp/issue.txt']);
  fullText = readFileSync('/tmp/issue.txt', 'utf8');
  // ГАРЧИГ хэсэг (ихэвчлэн 2-р хуудас)
  const pages = fullText.split('\f');
  const tocPage = pages.findIndex(p => /ГАРЧИГ/.test(p));
  toc = tocPage >= 0 ? pages.slice(tocPage, tocPage + 2).join('\n') : pages.slice(0, 3).join('\n');
}
await browser.close();

const name = `${latest.year}-no${latest.no}`;
writeFileSync(`data/${name}.txt`, fullText);
writeFileSync('data/latest.json', JSON.stringify({
  ...latest, pdf_url: pdfUrl, toc, full_text_file: `data/${name}.txt`,
  page_text: pageText.slice(0, 4000), checked_at: new Date().toISOString(),
  recent_issues: issues.slice(0, 5)
}, null, 2));
console.log(`OK: №${latest.no}(${latest.total}) ${latest.date} pdf=${!!pdfUrl}`);
