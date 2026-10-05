const fs = require('fs');
const zlib = require('zlib');

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/extract-pdf-text.js <file.pdf>');
  process.exit(1);
}

const pdf = fs.readFileSync(input);
const binary = pdf.toString('latin1');
const pieces = [];
const decodedStreams = [];
const glyphs = new Map();
const streamPattern = /stream\r?\n/g;
let match;

function decodeLiteral(value) {
  return value
    .replace(/\\([nrtbf])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c]))
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function unicodeFromHex(hex) {
  const points = [];
  for (let index = 0; index < hex.length; index += 4) {
    points.push(parseInt(hex.slice(index, index + 4), 16));
  }
  return String.fromCodePoint(...points);
}

function collectGlyphs(text) {
  const pairPattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
  let pair;
  while ((pair = pairPattern.exec(text))) {
    const key = pair[1].toUpperCase();
    if (!glyphs.has(key)) glyphs.set(key, unicodeFromHex(pair[2]));
  }
}

function decodeHex(value) {
  const width = value.length % 4 === 0 && !glyphs.has(value.slice(0, 4).toUpperCase()) ? 4 : 2;
  let result = '';
  for (let index = 0; index < value.length; index += width) {
    const key = value.slice(index, index + width).toUpperCase();
    if (glyphs.has(key)) result += glyphs.get(key);
    else if (width === 4) result += String.fromCharCode(parseInt(key, 16));
  }
  return result;
}

function extractOperators(content) {
  const text = content.toString('latin1');
  const blocks = text.match(/BT[\s\S]*?ET/g) || [];
  for (const block of blocks) {
    const values = [];
    const valuePattern = /\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f]+)>/g;
    let value;
    while ((value = valuePattern.exec(block))) {
      values.push(value[1] !== undefined ? decodeLiteral(value[1]) : decodeHex(value[2]));
    }
    const line = values.join('').replace(/\s+/g, ' ').trim();
    if (line) pieces.push(line);
  }
}

while ((match = streamPattern.exec(binary))) {
  const start = match.index + match[0].length;
  const end = binary.indexOf('endstream', start);
  if (end < 0) break;
  let stream = pdf.subarray(start, end);
  while (stream.length && (stream[stream.length - 1] === 10 || stream[stream.length - 1] === 13)) {
    stream = stream.subarray(0, stream.length - 1);
  }
  const dictionaryStart = binary.lastIndexOf('<<', match.index);
  const dictionary = binary.slice(dictionaryStart, match.index);
  try {
    decodedStreams.push(dictionary.includes('/FlateDecode') ? zlib.inflateSync(stream) : stream);
  } catch (_) {
    // Image streams and unsupported filters are intentionally ignored.
  }
  streamPattern.lastIndex = end + 9;
}

for (const stream of decodedStreams) collectGlyphs(stream.toString('latin1'));
for (const stream of decodedStreams) extractOperators(stream);

process.stdout.write(pieces.filter((piece) => /[A-Za-zÀ-ÿ0-9]/.test(piece)).join('\n'));
