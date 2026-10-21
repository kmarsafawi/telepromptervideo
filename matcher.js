// Speech-to-script matching. Pure functions + one class, no DOM, usable in Node and the browser.
//
// Model: the script is an array of tokens. `pos` is the index of the NEXT unspoken word
// (the "current" word). Each time the recognizer produces a hypothesis (interim or final,
// cumulative for the session), we take its last K words and locally align them against
// a window of the script around `pos` (Smith-Waterman style, with fuzzy word similarity).
// The pointer only moves FORWARD, and the required confidence grows with the size of the jump.

export const STOPWORDS = new Set(
  'a an the and or of to in on at is it i as be we so if by my me he she do no up us am are was but for you your that this'.split(' ')
);

/** Lowercase, strip diacritics, apostrophes and punctuation. Keeps letters/digits in any script. */
export function normalize(w) {
  return w
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Split script text into display/matching tokens.
 * Every token has a non-empty `norm`. Pure-punctuation fragments (e.g. "—") are attached to a neighbour.
 * Hyphenated / slashed compounds are split so they match how recognizers emit them ("well known").
 */
export function tokenize(text) {
  const tokens = [];
  const re = /\S+/g;
  let m;
  let lastEnd = 0;
  let prefix = '';
  let nlBefore = 0;
  while ((m = re.exec(text))) {
    const gap = text.slice(lastEnd, m.index);
    nlBefore += (gap.match(/\n/g) || []).length;
    lastEnd = m.index + m[0].length;
    // No lookbehind here on purpose: it is a hard SyntaxError on iOS < 16.4.
    const parts = m[0].replace(/([\-–—/])(?=[^\s\-–—/])/gu, '$1\u0001').split('\u0001');
    parts.forEach((part, pi) => {
      const norm = normalize(part);
      if (!norm) {
        if (tokens.length && pi > 0) tokens[tokens.length - 1].raw += part;
        else if (tokens.length && nlBefore === 0) tokens[tokens.length - 1].raw += ' ' + part;
        else prefix += part + ' ';
        return;
      }
      const prev = tokens[tokens.length - 1];
      tokens.push({
        raw: prefix + part,
        norm,
        nl: pi === 0 ? nlBefore : 0, // newlines immediately before this token
        sentenceStart: !prev || /[.!?…]["'”’)\]]*$/.test(prev.raw) || (pi === 0 && nlBefore >= 2),
        joined: pi > 0, // continues the previous whitespace-delimited word (no space before it)
      });
      prefix = '';
      if (pi === 0) nlBefore = 0;
    });
  }
  return tokens;
}

/** Turn a recognizer transcript into normalized words. */
export function hypothesisWords(text) {
  return text
    .split(/[\s\-–—/]+/u)
    .map(normalize)
    .filter(Boolean);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const c = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** Crude English-ish phonetic skeleton so "there/their", "night/knight", "meat/meet" collide. */
export function phoneticKey(w) {
  if (!/^[a-z]+$/.test(w)) return w; // non-latin: no phonetic folding
  let s = w
    .replace(/^kn/, 'n').replace(/^wr/, 'r').replace(/^wh/, 'w')
    .replace(/ph/g, 'f').replace(/gh/g, '').replace(/ck/g, 'k')
    .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/q/g, 'k')
    .replace(/x/g, 'ks').replace(/z/g, 's')
    .replace(/(.)\1+/g, '$1');
  return s[0] + s.slice(1).replace(/[aeiouhwy]/g, '');
}

/** Word similarity in [0,1]. >= MATCH_MIN counts as "the same word". */
export const MATCH_MIN = 0.75;
export function similarity(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen <= 2) return 0;
  let s = 1 - levenshtein(a, b) / maxLen;
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 4 && maxLen >= 4) {
    const pa = phoneticKey(a), pb = phoneticKey(b);
    if (pa === pb && pa.length >= 2 && a[0] === b[0]) s = Math.max(s, 0.85);
    // interim results often cut a word off: "importa" for "important"
    if ((a.startsWith(b) || b.startsWith(a)) && minLen / maxLen >= 0.6) s = Math.max(s, 0.8);
  }
  return s;
}

const DEFAULTS = {
  window: 30, // how far ahead of pos we search
  tail: 6, // how many recent hypothesis words we align
  lookback: 6, // how far behind pos the alignment may start (context only, never moves pointer back)
  skipPenalty: 0.3, // script word not spoken, inside an alignment
  adlibPenalty: 0.15, // spoken word not in script, inside an alignment
  mismatch: -0.4,
};

function wordWeight(w) {
  return w.length <= 3 || STOPWORDS.has(w) ? 0.5 : 1;
}

/** Confidence required to accept an advance of `jump` words. */
export function requiredConfidence(jump) {
  if (jump <= 2) return { score: 0.7, count: 1 };
  if (jump <= 6) return { score: 1.6, count: 2 };
  if (jump <= 14) return { score: 2.4, count: 3 };
  return { score: 3.0, count: 3 };
}

export class Matcher {
  /** @param {string[]|{norm:string}[]} words normalized words or tokens */
  constructor(words, opts = {}) {
    this.words = words.map((w) => (typeof w === 'string' ? w : w.norm));
    this.opts = { ...DEFAULTS, ...opts };
    this.pos = 0;
  }

  get done() {
    return this.pos >= this.words.length;
  }

  setPos(i) {
    this.pos = Math.max(0, Math.min(this.words.length, i | 0));
  }

  /**
   * Feed the current recognizer hypothesis (cumulative words for this recognition session).
   * @returns {{pos:number, advanced:number, score:number}}
   */
  update(hyp) {
    const o = this.opts;
    const none = { pos: this.pos, advanced: 0, score: 0 };
    if (this.done || !hyp.length) return none;
    const h = hyp.slice(-o.tail);
    const m = h.length;
    const lo = Math.max(0, this.pos - o.lookback);
    const hi = Math.min(this.words.length, this.pos + o.window);
    const n = hi - lo;
    if (n <= 0) return none;

    // DP tables (row-major), local alignment.
    const W = n + 1;
    const H = new Float32Array((m + 1) * W);
    const C = new Uint8Array((m + 1) * W); // matched-pair count along best path
    const M = new Uint8Array((m + 1) * W); // 1 if cell was reached by a real match
    const hw = h.map(wordWeight);
    let best = null;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const sw = this.words[lo + j - 1];
        const sim = similarity(h[i - 1], sw);
        const isMatch = sim >= MATCH_MIN;
        const w = Math.min(hw[i - 1], wordWeight(sw));
        const sub = isMatch ? sim * w : o.mismatch;
        const idx = i * W + j;

        let v = 0, c = 0, mm = 0;
        const diag = H[(i - 1) * W + j - 1] + sub;
        if (diag > v) { v = diag; c = C[(i - 1) * W + j - 1] + (isMatch ? 1 : 0); mm = isMatch ? 1 : 0; }
        const up = H[(i - 1) * W + j] - o.adlibPenalty; // spoken word with no script counterpart
        if (up > v) { v = up; c = C[(i - 1) * W + j]; mm = 0; }
        const left = H[i * W + j - 1] - o.skipPenalty; // script word skipped
        if (left > v) { v = left; c = C[i * W + j - 1]; mm = 0; }
        H[idx] = v; C[idx] = c; M[idx] = mm;

        if (mm) {
          const endPos = lo + j; // new pointer if we accept this cell (index after the matched word)
          const jump = endPos - this.pos;
          if (jump <= 0) continue; // explains only already-spoken words
          const need = requiredConfidence(jump);
          if (v < need.score || c < need.count) continue;
          const rank = v - 0.05 * jump; // prefer the nearest of equally good alignments
          if (!best || rank > best.rank) best = { rank, score: v, endPos, jump };
        }
      }
    }
    if (!best) return none;
    this.pos = best.endPos;
    return { pos: this.pos, advanced: best.jump, score: best.score };
  }
}
