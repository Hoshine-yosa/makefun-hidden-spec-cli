// mend: applies an AI-written edit to a tree of text files, as SPEC.md specifies.
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
//
// The kit's starter already did sections 1 to 4, 9 and 10 (command line, output and
// exit codes, safe paths, format detection, JSON edits, the all-or-nothing write).
// This file adds what was missing: line matching at three tiers (section 5), unified
// diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8),
// and the `R old -> new` line for moves (section 2).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// --- A file as lines (SPEC section 3) ---------------------------------------

interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const bothTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const normAt = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? trailTrim(s) : bothTrim(s));

// --- Matching old lines (SPEC section 5) ------------------------------------

function occurrences(file: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  const k = oldLines.length;
  if (k === 0 || k > file.length) return out;
  const want = oldLines.map((l) => normAt(l, tier));
  for (let i = 0; i + k <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (normAt(file[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

function firstTier(file: string[], oldLines: string[], strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(file, oldLines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function firstTierFrom(file: string[], oldLines: string[], from: number, strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(file, oldLines, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Resolve the replacement lines: a context line is the file's own matched line;
 *  at tier 2 every other line is re-indented from the old lines' indent to the
 *  file's indent; at tiers 0 and 1 the new lines are written as they are. */
function resolveNew(items: NewLine[], file: string[], pos: number, tier: number, oldLines: string[]): string[] {
  if (tier !== 2) return items.map((it) => (it.ctx ? file[pos + it.oIdx]! : it.text));
  const fLead = leadWs(file[pos] ?? '');
  const pLead = leadWs(oldLines[0] ?? '');
  return items.map((it) => {
    if (it.ctx) return file[pos + it.oIdx]!;
    const t = it.text;
    if (t === '' || t.trim() === '') return t;
    return t.startsWith(pLead) ? fLead + t.slice(pLead.length) : t;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// --- JSON edits (SPEC section 9) --------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Unified diffs (SPEC section 6) -----------------------------------------

interface HunkItem {
  kind: 'ctx' | 'old' | 'nw' | 'bs';
  text: string;
}
interface Hunk {
  a: number;
  items: HunkItem[];
}
interface UniSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A path off a `--- ` / `+++ ` line: text after the four characters, up to the
 *  first tab, surrounding spaces removed, one leading a/ or b/ removed;
 *  /dev/null means no file. */
function headerPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  let q = rest.trim();
  if (q.startsWith('a/')) q = q.slice(2);
  else if (q.startsWith('b/')) q = q.slice(2);
  return q === '/dev/null' ? null : q;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let phase: 'none' | 'header' | 'hunk' | 'between' = 'none';
  let hunk: Hunk | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (phase === 'hunk') {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        while (hunk!.items.length > 0) {
          const last = hunk!.items[hunk!.items.length - 1]!;
          if (last.kind === 'ctx' && last.text === '') hunk!.items.pop();
          else break;
        }
        phase = 'between';
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        if (line === '') hunk!.items.push({ kind: 'ctx', text: '' });
        else if (line.startsWith(' ')) hunk!.items.push({ kind: 'ctx', text: line.slice(1) });
        else if (line.startsWith('-')) hunk!.items.push({ kind: 'old', text: line.slice(1) });
        else if (line.startsWith('+')) hunk!.items.push({ kind: 'nw', text: line.slice(1) });
        else hunk!.items.push({ kind: 'bs', text: line });
        i++;
        continue;
      }
      while (hunk!.items.length > 0) {
        const last = hunk!.items[hunk!.items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk!.items.pop();
        else break;
      }
      phase = 'between';
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { pairOld: undefined, pairNew: undefined, renameFrom: undefined, renameTo: undefined, gitOld: m[1]!, gitNew: m[2]!, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      phase = 'header';
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (phase === 'header' && cur !== null) {
        if (cur.pairOld === undefined) {
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(lines[i + 1]!);
        }
        i += 2;
        continue;
      }
      cur = { pairOld: headerPath(line), pairNew: headerPath(lines[i + 1]!), renameFrom: undefined, renameTo: undefined, gitOld: undefined, gitNew: undefined, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      phase = 'header';
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (phase === 'header') throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (phase === 'none' || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), items: [] };
      cur.hunks.push(hunk);
      phase = 'hunk';
      i++;
      continue;
    }
    if (phase === 'header' && cur !== null) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.newFile = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function bsAfterLast(hunk: Hunk): boolean {
  for (let k = hunk.items.length - 1; k >= 0; k--) {
    const it = hunk.items[k]!;
    if (it.kind === 'ctx' || it.kind === 'nw') {
      return hunk.items[k + 1] !== undefined && hunk.items[k + 1]!.kind === 'bs';
    }
  }
  return false;
}

function splitHunk(hunk: Hunk): { o: string[]; nItems: NewLine[] } {
  const o: string[] = [];
  const nItems: NewLine[] = [];
  for (const it of hunk.items) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      nItems.push({ text: it.text, ctx: true, oIdx: o.length - 1 });
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else if (it.kind === 'nw') {
      nItems.push({ text: it.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, nItems };
}

function applyUnifiedHunks(sec: UniSection, startText: string, strict: boolean, path: string): string {
  const f = splitFile(startText);
  const lines = f.lines;
  let finalBreak = f.final;
  let d = 0;
  for (const hunk of sec.hunks) {
    const { o, nItems } = splitHunk(hunk);
    const bs = bsAfterLast(hunk);
    if (o.length === 0) {
      const at = Math.min(Math.max(hunk.a + d, 0), lines.length);
      const touchesEnd = at === lines.length;
      const nLines = nItems.map((x) => x.text);
      lines.splice(at, 0, ...nLines);
      if (touchesEnd) finalBreak = !bs;
    } else {
      const found = firstTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const touchesEnd = best + o.length === lines.length;
      const nLines = resolveNew(nItems, lines, best, found.tier, o);
      lines.splice(best, o.length, ...nLines);
      if (touchesEnd) finalBreak = !bs;
    }
    d += nItems.length - o.length;
  }
  return joinFile({ br: f.br, lines, final: finalBreak });
}

function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld !== undefined ? sec.gitOld : null;
    const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew !== undefined ? sec.gitNew : null;
    const isCreate = oldPath === null || sec.newFile;
    const isDelete = !isCreate && (newPath === null || sec.deletedFile);
    if (isCreate) {
      if (newPath === null) throw new Fail('unsafe', '');
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let finalBreak = true;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.items.length; k++) {
          const it = h.items[k]!;
          if (it.kind === 'nw') {
            plus.push(it.text);
            finalBreak = !(h.items[k + 1] !== undefined && h.items[k + 1]!.kind === 'bs');
          }
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldPath === null) throw new Fail('unsafe', '');
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === null || newPath === null) throw new Fail('unsafe', '');
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (oldPath !== newPath && !safe(newPath)) throw new Fail('unsafe', newPath);
    const cur = tree.get(oldPath);
    if (cur === null) throw new Fail('missing', oldPath);
    if (oldPath !== newPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const result = applyUnifiedHunks(sec, cur, strict, oldPath);
    if (oldPath !== newPath) {
      tree.now.set(newPath, result);
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
    } else {
      tree.now.set(oldPath, result);
    }
  };
}

// --- SEARCH/REPLACE blocks (SPEC section 7) ---------------------------------

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  for (;;) {
    let sIdx = -1;
    for (let j = prevEnd; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        sIdx = j;
        break;
      }
    }
    if (sIdx < 0) break;
    let path: string | null = null;
    for (let j = sIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    let eqIdx = -1;
    let repIdx = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eqIdx = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    for (let j = eqIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(sIdx + 1, eqIdx), newLines: lines.slice(eqIdx + 1, repIdx) });
    prevPath = path;
    prevEnd = repIdx + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srBlockEdit(b, strict));
}

function srBlockEdit(block: SrBlock, strict: boolean): Edit {
  return (tree) => {
    const p = block.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (block.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, block.newLines.length === 0 ? '' : block.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const f = splitFile(cur);
    const found = firstTier(f.lines, block.oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const pos = found.occ[0]!;
    const nItems: NewLine[] = block.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const nLines = resolveNew(nItems, f.lines, pos, found.tier, block.oldLines);
    f.lines.splice(pos, block.oldLines.length, ...nLines);
    tree.now.set(p, joinFile(f));
  };
}

// --- V4A patches (SPEC section 8) -------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: HunkItem[];
}

const V4A_SECTION = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (lines[k]!.trim() !== '') {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const path = line.slice(line.indexOf(': ') + 2).trim();
      const items: { text: string; idx: number }[] = [];
      let j = i + 1;
      while (j < last && !V4A_SECTION(lines[j]!)) {
        items.push({ text: lines[j]!, idx: j });
        j++;
      }
      while (items.length > 0 && items[items.length - 1]!.text.trim() === '') items.pop();
      if (kind === 'add') {
        for (const it of items) {
          if (!(it.text.startsWith('+') || it.text === '')) throw new Exit2(`error: parse ${it.idx + 1}`);
        }
        const content = items.map((it) => (it.text === '' ? '' : it.text.slice(1)));
        edits.push((tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) !== null) throw new Fail('exists', path);
          tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
        });
      } else if (kind === 'delete') {
        if (items.length > 0) throw new Exit2(`error: parse ${items[0]!.idx + 1}`);
        edits.push((tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) === null) throw new Fail('missing', path);
          tree.now.set(path, null);
        });
      } else {
        const { moveTo, chunks } = parseV4AUpdate(items, i + 1);
        edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      }
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function parseV4AUpdate(items: { text: string; idx: number }[], updateLine: number): { moveTo: string | null; chunks: VChunk[] } {
  let moveTo: string | null = null;
  let k = 0;
  if (items.length > 0 && items[0]!.text.startsWith('*** Move to: ')) {
    moveTo = items[0]!.text.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; k < items.length; k++) {
    const it = items[k]!;
    const t = it.text;
    if (t.startsWith('@@')) {
      const anchorText = t.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
      chunks.push(cur);
      continue;
    }
    if (t === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${it.idx + 1}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (t.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${it.idx + 1}`);
    if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
      if (cur === null) {
        cur = { anchor: null, eof: false, items: [] };
        chunks.push(cur);
      }
      if (t === '') cur.items.push({ kind: 'ctx', text: '' });
      else if (t.startsWith(' ')) cur.items.push({ kind: 'ctx', text: t.slice(1) });
      else if (t.startsWith('-')) cur.items.push({ kind: 'old', text: t.slice(1) });
      else cur.items.push({ kind: 'nw', text: t.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${it.idx + 1}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return { moveTo, chunks };
}

function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normAt(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (normAt(lines[i]!, t) === want) return i;
    }
  }
  return -1;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    let newPath: string | null = null;
    if (moveTo !== null) {
      newPath = moveTo;
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
    }
    const f = splitFile(cur);
    const lines = f.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(lines, chunk.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, nItems } = splitHunk({ a: 0, items: chunk.items });
      if (o.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        const nLines = nItems.map((x) => x.text);
        lines.splice(at, 0, ...nLines);
        cursor = at + nLines.length;
      } else {
        const found = firstTierFrom(lines, o, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        if (chunk.eof && pos + o.length !== lines.length) throw new Fail('no-match', path);
        const nLines = resolveNew(nItems, lines, pos, found.tier, o);
        lines.splice(pos, o.length, ...nLines);
        cursor = pos + nLines.length;
      }
    }
    const text = joinFile(f);
    if (newPath !== null) {
      tree.now.set(newPath, text);
      tree.now.set(path, null);
      tree.moves.push([path, newPath]);
    } else {
      tree.now.set(path, text);
    }
  };
}

// --- Invocation, output and exit codes (SPEC sections 1, 2, 10) -------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const rPairs: [string, string][] = [];
  for (const [old, nw] of tree.moves) {
    if (tree.original(old) !== null && tree.get(old) === null && tree.original(nw) === null && tree.get(nw) !== null) rPairs.push([old, nw]);
  }
  const rOlds = new Set(rPairs.map((p) => p[0]));
  const rNews = new Set(rPairs.map((p) => p[1]));
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOlds.has(p) || rNews.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [old, nw] of rPairs) rows.push({ key: nw, line: `R ${old} -> ${nw}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
