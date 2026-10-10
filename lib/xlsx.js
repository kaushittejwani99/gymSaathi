// Reads the first sheet of an Excel .xlsx file into rows of cells, with nothing but Node's own zlib.
// An .xlsx is a zip of XML files: the sheet holds the cells, and text cells point into a shared list of strings.
// ponytail: dates come out as Excel's day numbers and formulas as their last worked-out value; that is enough for
// reading a member list. Use a spreadsheet library if formats or several sheets ever matter.
'use strict';
const zlib = require('node:zlib');

// name -> () => contents, for every file in the zip. Each is unpacked only when asked for, and never beyond 30 MB.
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip file');
  const files = {};
  let at = buf.readUInt32LE(end + 16);
  for (let left = buf.readUInt16LE(end + 10); left > 0 && buf.readUInt32LE(at) === 0x02014b50; left--) {
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), nameLength = buf.readUInt16LE(at + 28), local = buf.readUInt32LE(at + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), raw = buf.subarray(start, start + size);
    files[buf.toString('utf8', at + 46, at + 46 + nameLength)] = () => (method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: 30e6 }) : raw).toString('utf8');
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return files;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const plain = (xml) => xml.replace(/&(#x?[0-9a-f]+|\w+);/gi, (all, code) => (code[0] === '#' ? String.fromCodePoint(code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : NAMED[code] ?? all));
const texts = (xml) => [...xml.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((m) => plain(m[1])).join('');
// 'C7' -> 2, the column counted from nought.
const column = (ref) => [...ref.replace(/\d/g, '')].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;

// The rows of the first sheet, each a list of cell texts. At most `limit` rows.
function rows(buf, limit = 2000) {
  const files = unzip(buf), sheet = Object.keys(files).filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name)).sort()[0];
  if (!sheet) throw new Error('no sheet in this file');
  const shared = files['xl/sharedStrings.xml'] ? [...files['xl/sharedStrings.xml']().matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1])) : [];
  const out = [];
  for (const row of files[sheet]().matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const [, attrs, body = ''] of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs), type = (/\bt="(\w+)"/.exec(attrs) || [])[1], value = (/<v\b[^>]*>([^<]*)<\/v>/.exec(body) || [])[1];
      const text = type === 's' ? shared[Number(value)] : type === 'inlineStr' ? texts(body) : value === undefined ? '' : plain(value);
      cells[ref ? column(ref[1]) : cells.length] = text ?? '';
    }
    if (cells.some((c) => c)) out.push(Array.from(cells, (c) => c ?? ''));
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { rows };
