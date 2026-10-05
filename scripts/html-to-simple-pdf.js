const fs = require('fs');

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node html-to-simple-pdf.js input.html output.pdf');

let html = fs.readFileSync(input, 'utf8');
const body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || ['', html])[1];
let text = body
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<h1[^>]*>/gi, '\n# ').replace(/<h2[^>]*>/gi, '\n## ').replace(/<h3[^>]*>/gi, '\n### ')
  .replace(/<\/h[1-3]>/gi, '\n')
  .replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '')
  .replace(/<tr[^>]*>/gi, '\n').replace(/<\/(td|th)>/gi, ' | ')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<\/pre>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/[–—]/g, '-').replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
  .replace(/…/g, '...').replace(/œ/g, 'oe').replace(/Œ/g, 'OE')
  .replace(/→/g, '->').replace(/₅/g, '5').replace(/\u00a0/g, ' ')
  .replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

const wrapped = [];
for (const raw of text.split('\n')) {
  const line = raw.trim();
  if (!line) { wrapped.push(''); continue; }
  const width = line.startsWith('# ') ? 55 : line.startsWith('## ') ? 62 : 92;
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut < 25) cut = width;
    wrapped.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  wrapped.push(rest);
}

const perPage = 48;
const pages = [];
for (let i = 0; i < wrapped.length; i += perPage) pages.push(wrapped.slice(i, i + perPage));

const objects = [null];
const add = value => (objects.push(value), objects.length - 1);
const catalog = add('');
const pagesObj = add('');
const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
const pageIds = [];

const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
for (let p = 0; p < pages.length; p++) {
  let y = 800;
  const ops = ['BT'];
  for (const original of pages[p]) {
    let line = original;
    let size = 9.5, face = 'F1', leading = 14;
    if (line.startsWith('# ')) { line = line.slice(2); size = 18; face = 'F2'; leading = 25; }
    else if (line.startsWith('## ')) { line = line.slice(3); size = 14; face = 'F2'; leading = 22; }
    else if (line.startsWith('### ')) { line = line.slice(4); size = 11; face = 'F2'; leading = 18; }
    ops.push(`/${face} ${size} Tf 1 0 0 1 50 ${y} Tm (${esc(line)}) Tj`);
    y -= leading;
  }
  ops.push(`/F1 8 Tf 1 0 0 1 500 25 Tm (Page ${p + 1}/${pages.length}) Tj`, 'ET');
  const stream = Buffer.from(ops.join('\n'), 'latin1');
  const content = add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'ascii'), stream, Buffer.from('\nendstream', 'ascii')]));
  const page = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`);
  pageIds.push(page);
}
objects[catalog] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
objects[pagesObj] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')];
const offsets = [0];
let pos = chunks[0].length;
for (let i = 1; i < objects.length; i++) {
  offsets[i] = pos;
  const data = Buffer.isBuffer(objects[i]) ? objects[i] : Buffer.from(objects[i], 'latin1');
  const chunk = Buffer.concat([Buffer.from(`${i} 0 obj\n`, 'ascii'), data, Buffer.from('\nendobj\n', 'ascii')]);
  chunks.push(chunk); pos += chunk.length;
}
const xref = pos;
let table = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
for (let i = 1; i < objects.length; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
table += `trailer\n<< /Size ${objects.length} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
chunks.push(Buffer.from(table, 'ascii'));
fs.writeFileSync(output, Buffer.concat(chunks));
