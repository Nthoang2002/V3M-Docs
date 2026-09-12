import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

const root = process.cwd();
const output = path.join(root, "v3m-docs-full.html");

const files = fs
  .readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
  .filter((file) => !file.startsWith("node_modules/") && !file.startsWith("."))
  .sort((a, b) => {
    if (a === "README.md") return -1;
    if (b === "README.md") return 1;
    return a.localeCompare(b, "vi", { numeric: true });
  });

const slug = (value) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const docIds = new Map(files.map((file) => [file.toLowerCase(), `doc-${slug(file)}`]));

function titleOf(markdown, file) {
  return markdown.match(/^#\s+(.+)$/m)?.[1].replace(/[`*_]/g, "") ?? file;
}

function rewriteLinks(markdown, file) {
  const currentDir = path.posix.dirname(file);
  return markdown.replace(/\]\(([^)]+\.md)(#[^)]+)?\)/gi, (whole, target, hash = "") => {
    const resolved = path.posix.normalize(path.posix.join(currentDir, decodeURI(target))).toLowerCase();
    const id = docIds.get(resolved);
    return id ? `](#${id})` : whole;
  });
}

marked.setOptions({ gfm: true, breaks: false });

const docs = files.map((file, index) => {
  const markdown = fs.readFileSync(path.join(root, file), "utf8").replace(/^\uFEFF/, "");
  const title = titleOf(markdown, file);
  const id = docIds.get(file.toLowerCase());
  return { file, title, id, index, html: marked.parse(rewriteLinks(markdown, file)) };
});

const groups = [
  ["Bắt đầu", (f) => !f.includes("/")],
  ["1. Behavior Events", (f) => f.startsWith("01-")],
  ["2. Customer Service", (f) => f.startsWith("02-")],
  ["3. Kiến thức nền", (f) => f.startsWith("03-")],
  ["4. Tra cứu nhanh", (f) => f.startsWith("04-")],
  ["5. Ôn tập", (f) => f.startsWith("05-")],
];

const nav = groups
  .map(([name, test]) => {
    const items = docs.filter((doc) => test(doc.file));
    if (!items.length) return "";
    return `<section class="nav-group"><h2>${name}</h2>${items
      .map((doc) => `<a href="#${doc.id}" data-doc="${doc.id}"><span>${doc.file.split("/").pop().replace(".md", "")}</span><small>${doc.title}</small></a>`)
      .join("")}</section>`;
  })
  .join("");

const articles = docs
  .map((doc, index) => `<article id="${doc.id}" class="doc" data-index="${index}" data-title="${doc.title.replaceAll('"', "&quot;")}" data-file="${doc.file}">
    <div class="file-label">${doc.file}</div>
    ${doc.html}
    <nav class="pager">
      ${index ? `<a href="#${docs[index - 1].id}">← ${docs[index - 1].title}</a>` : "<span></span>"}
      ${index < docs.length - 1 ? `<a href="#${docs[index + 1].id}">${docs[index + 1].title} →</a>` : ""}
    </nav>
  </article>`)
  .join("\n");

const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>V3M Docs — Full Source</title>
<style>
:root{--bg:#f5f7fb;--panel:#fff;--text:#182230;--muted:#687386;--line:#dfe5ed;--brand:#175cd3;--brand-soft:#eaf2ff;--code:#111827;--code-text:#e5edf8;--shadow:0 12px 35px rgba(24,34,48,.08)}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}.layout{display:grid;grid-template-columns:320px minmax(0,1fr);min-height:100vh}.sidebar{position:sticky;top:0;height:100vh;overflow:auto;background:#101828;color:#d0d5dd;padding:22px 18px}.brand{display:flex;align-items:center;gap:12px;margin-bottom:18px}.logo{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#2970ff;color:#fff;font-weight:800}.brand strong{display:block;color:#fff}.brand small{color:#98a2b3}.search{width:100%;border:1px solid #344054;border-radius:10px;background:#1d2939;color:#fff;padding:11px 13px;outline:none}.search:focus{border-color:#84adff}.nav-group{margin-top:22px}.nav-group h2{margin:0 8px 7px;color:#98a2b3;font-size:11px;letter-spacing:.12em;text-transform:uppercase}.nav-group a{display:block;padding:8px;border-radius:8px;color:#d0d5dd;text-decoration:none}.nav-group a:hover,.nav-group a.active{background:#1d2939;color:#fff}.nav-group span{display:block;font-size:13px;font-weight:650}.nav-group small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#98a2b3;font-size:11px}.main{min-width:0;padding:42px clamp(20px,5vw,76px) 80px}.toolbar{display:flex;justify-content:space-between;align-items:center;max-width:1050px;margin:0 auto 18px;color:var(--muted);font-size:13px}.toolbar button,.menu{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:8px 11px;cursor:pointer}.menu{display:none}.doc{display:none;max-width:1050px;margin:auto;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:clamp(24px,5vw,64px);box-shadow:var(--shadow)}.doc.active{display:block}.file-label{display:inline-block;margin-bottom:14px;border-radius:99px;background:var(--brand-soft);color:var(--brand);padding:4px 10px;font:600 12px/1.5 ui-monospace,monospace}.doc h1{font-size:clamp(28px,4vw,42px);line-height:1.2;margin:.3em 0 .8em}.doc h2{font-size:26px;line-height:1.3;margin:2.2em 0 .7em;padding-bottom:.25em;border-bottom:1px solid var(--line)}.doc h3{font-size:20px;margin:1.8em 0 .5em}.doc h4{font-size:17px}.doc a{color:var(--brand);text-decoration-thickness:1px;text-underline-offset:3px}.doc blockquote{margin:1.4em 0;padding:12px 18px;border-left:4px solid #84adff;background:#f5f8ff;color:#344054}.doc blockquote p{margin:0}.doc code{border-radius:5px;background:#eef1f5;padding:.12em .35em;font: .88em/1.5 Consolas,"Cascadia Code",monospace}.doc pre{overflow:auto;border-radius:10px;background:var(--code);color:var(--code-text);padding:18px;line-height:1.55}.doc pre code{background:transparent;padding:0;color:inherit}.doc table{display:block;width:100%;overflow:auto;border-collapse:collapse;margin:1.4em 0}.doc th,.doc td{border:1px solid var(--line);padding:9px 12px;vertical-align:top}.doc th{background:#f2f4f7;text-align:left}.doc hr{border:0;border-top:1px solid var(--line);margin:2.5em 0}.doc li{margin:.28em 0}.pager{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:54px;padding-top:22px;border-top:1px solid var(--line)}.pager a:last-child{text-align:right}.empty{display:none;margin:24px 8px;color:#fda29b}.sidebar.no-results .empty{display:block}
@media(max-width:850px){.layout{display:block}.sidebar{position:fixed;z-index:10;width:min(88vw,340px);transform:translateX(-105%);transition:.2s}.sidebar.open{transform:none}.main{padding:18px 14px 60px}.menu{display:inline-block}.doc{padding:24px 18px;border-radius:12px}.doc h2{font-size:22px}}
@media print{.sidebar,.toolbar,.pager{display:none}.layout{display:block}.main{padding:0}.doc{display:block!important;box-shadow:none;border:0;page-break-after:always;max-width:none}.doc a{color:inherit}}
</style></head><body><div class="layout">
<aside class="sidebar" id="sidebar"><div class="brand"><div class="logo">V3M</div><div><strong>Full Source Docs</strong><small>${docs.length} tài liệu · Offline</small></div></div><input class="search" id="search" type="search" placeholder="Tìm tài liệu..." autocomplete="off"><div class="empty">Không tìm thấy tài liệu.</div>${nav}</aside>
<main class="main"><div class="toolbar"><button class="menu" id="menu">☰ Mục lục</button><span id="position"></span><button onclick="window.print()">In / Lưu PDF</button></div>${articles}</main></div>
<script>
const docs=[...document.querySelectorAll('.doc')],links=[...document.querySelectorAll('[data-doc]')],sidebar=document.getElementById('sidebar');
function show(){let id=location.hash.slice(1);let current=docs.find(d=>d.id===id)||docs[0];docs.forEach(d=>d.classList.toggle('active',d===current));links.forEach(a=>a.classList.toggle('active',a.dataset.doc===current.id));document.getElementById('position').textContent=(+current.dataset.index+1)+' / '+docs.length+' · '+current.dataset.file;document.title=current.dataset.title+' — V3M Docs';sidebar.classList.remove('open');if(!location.hash)history.replaceState(null,'','#'+current.id);scrollTo(0,0)}
addEventListener('hashchange',show);show();
document.getElementById('menu').onclick=()=>sidebar.classList.toggle('open');
document.getElementById('search').addEventListener('input',e=>{let q=e.target.value.trim().toLocaleLowerCase('vi');let count=0;links.forEach(a=>{let ok=!q||a.textContent.toLocaleLowerCase('vi').includes(q);a.style.display=ok?'block':'none';if(ok)count++});sidebar.classList.toggle('no-results',!count)});
document.addEventListener('keydown',e=>{if(e.key==='/'&&!/input|textarea/i.test(e.target.tagName)){e.preventDefault();document.getElementById('search').focus()}if(e.altKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){let i=docs.findIndex(d=>d.classList.contains('active'))+(e.key==='ArrowRight'?1:-1);if(docs[i])location.hash=docs[i].id}});
</script></body></html>`;

fs.writeFileSync(output, html, "utf8");
console.log(`Built ${path.basename(output)} from ${docs.length} Markdown files (${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB).`);
