import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matcher, tokenize, hypothesisWords, similarity, normalize } from '../matcher.js';

const SCRIPT = `Good evening everyone, and thank you for joining us tonight. Today I want to talk about
three simple ideas that changed the way our team builds software. The first idea is that small
steps beat big plans. The second idea is that feedback should arrive early, not late. And the third
idea, perhaps the most important one, is that people matter more than process. Let us begin with
the first idea and see where it takes us.`;

function setup(text = SCRIPT) {
  const tokens = tokenize(text);
  return { tokens, m: new Matcher(tokens) };
}
const idx = (tokens, word, nth = 0) => {
  let c = 0;
  for (let i = 0; i < tokens.length; i++) if (tokens[i].norm === word && c++ === nth) return i;
  throw new Error('word not found ' + word);
};

/** Simulate Web Speech: cumulative hypothesis for one recognition session, fed word by word. */
function speak(m, phrase, session = []) {
  for (const w of hypothesisWords(phrase)) {
    session.push(w);
    m.update(session);
  }
  return session;
}

test('tokenizer: punctuation, hyphens, newlines, sentence starts', () => {
  const t = tokenize('Hello, well-known world — again.\n\nNew para! OK');
  assert.deepEqual(t.map((x) => x.norm), ['hello', 'well', 'known', 'world', 'again', 'new', 'para', 'ok']);
  assert.equal(t[5].nl, 2);
  assert.equal(t[5].sentenceStart, true);
  assert.equal(t[7].sentenceStart, true);
  assert.equal(t[1].sentenceStart, false);
  assert.ok(t.every((x) => x.norm.length > 0));
});

test('similarity: exact, near, homophone, unrelated', () => {
  assert.equal(similarity('cat', 'cat'), 1);
  assert.ok(similarity('their', 'there') >= 0.75);
  assert.ok(similarity('knight', 'night') >= 0.75);
  assert.ok(similarity('important', 'importa') >= 0.75);
  assert.ok(similarity('idea', 'process') < 0.5);
  assert.ok(similarity('cat', 'car') < 0.75);
  assert.equal(normalize("Don’t,"), 'dont');
});

test('in-order reading advances to the end of what was said, word by word', () => {
  const { tokens, m } = setup();
  speak(m, 'good evening everyone and thank you for joining us tonight');
  assert.equal(m.pos, idx(tokens, 'tonight') + 1);
});

test('interim revisions of the same hypothesis do not move the pointer twice', () => {
  const { m } = setup();
  m.update(hypothesisWords('good evening'));
  const p = m.pos;
  m.update(hypothesisWords('good evening'));
  m.update(hypothesisWords('good evening'));
  assert.equal(m.pos, p);
  assert.equal(p, 2);
});

test('skipped words: reader skips a phrase and the pointer follows', () => {
  const { tokens, m } = setup();
  speak(m, 'good evening everyone and thank you');
  // skips "for joining us tonight. Today I want to talk about" and resumes at "three simple ideas"
  speak(m, 'three simple ideas that changed');
  assert.equal(m.pos, idx(tokens, 'changed') + 1);
});

test('skipped single words inside a sentence are tolerated', () => {
  const { tokens, m } = setup();
  m.setPos(idx(tokens, 'first') - 1); // start of "The first idea..." sentence
  speak(m, 'the first idea small steps beat plans'); // skipped "is that" and "big"
  assert.equal(m.pos, idx(tokens, 'plans') + 1);
});

test('misheard words: homophones and near misses still advance', () => {
  const { tokens, m } = setup();
  // "evening"->"evenin", "joining"->"joinin", "tonight"->"tonite"
  speak(m, 'good evenin everyone and thank you for joinin us tonite');
  assert.ok(m.pos >= idx(tokens, 'us') + 1, `pos ${m.pos}`);
  assert.ok(m.pos <= idx(tokens, 'tonight') + 1);
});

test('misheard words: completely wrong word does not derail following words', () => {
  const { tokens, m } = setup();
  speak(m, 'good evening banana and thank you for joining');
  assert.equal(m.pos, idx(tokens, 'joining') + 1);
});

test('ad-libs: extra words that are not in the script do not move or derail the pointer', () => {
  const { tokens, m } = setup();
  const s = speak(m, 'good evening everyone');
  const p = m.pos;
  speak(m, 'now let me just say something completely unrelated to the script here', s);
  assert.ok(m.pos - p <= 1, `moved ${m.pos - p}`); // "to"/"the" may score, but only a nudge at most
  speak(m, 'anyway and thank you for joining us', s);
  assert.equal(m.pos, idx(tokens, 'us') + 1);
});

test('ad-lib in the middle of a sentence', () => {
  const { tokens, m } = setup();
  m.setPos(idx(tokens, 'first') - 1);
  speak(m, 'the first idea is that you know honestly small steps beat big plans');
  assert.equal(m.pos, idx(tokens, 'plans') + 1);
});

test('repeated phrases: does not leap to a later repetition', () => {
  const text = 'We go up the hill. We go up the hill. We go up the hill and then we stop at the top.';
  const { tokens, m } = setup(text);
  speak(m, 'we go up the hill');
  assert.equal(m.pos, 5);
  // the reader says the phrase again: pointer should land at the second repetition, not the third
  speak(m, 'we go up the hill');
  assert.equal(m.pos, 10);
  speak(m, 'we go up the hill');
  assert.equal(m.pos, 15);
  assert.equal(tokens[15].norm, 'and');
});

test('repeated phrase: reader repeats a line (stumble) without moving forward', () => {
  const { tokens, m } = setup();
  m.setPos(idx(tokens, 'first') - 1);
  const s = speak(m, 'the first idea is that small steps');
  const p = m.pos;
  // reader restarts the sentence: fresh recognition session, same words again
  speak(m, 'the first idea is that small', []);
  assert.equal(m.pos, p);
  speak(m, 'steps beat big plans', []);
  assert.equal(m.pos, idx(tokens, 'plans') + 1);
  assert.ok(s.length > 0);
});

test('weak matches never cause a big jump (single common word far ahead)', () => {
  const { m } = setup();
  speak(m, 'good evening');
  const p = m.pos;
  m.update(['the']);
  m.update(['and']);
  m.update(['idea']); // "idea" occurs ~13 words ahead: one word is not enough
  assert.equal(m.pos, p);
});

test('never jumps backward, even when earlier text is re-read', () => {
  const { tokens, m } = setup();
  speak(m, 'good evening everyone and thank you for joining us tonight today i want to talk');
  const p = m.pos;
  speak(m, 'good evening everyone and thank you', []);
  assert.equal(m.pos, p);
  assert.ok(p > idx(tokens, 'tonight'));
});

test('restart mid-script: setPos then continue from there', () => {
  const { tokens, m } = setup();
  speak(m, 'good evening everyone');
  const start = idx(tokens, 'third');
  m.setPos(start); // user tapped the word "third"
  assert.equal(m.pos, start);
  // stale hypothesis from before the tap must not pull us anywhere
  m.update(hypothesisWords('good evening everyone'));
  assert.equal(m.pos, start);
  speak(m, 'third idea perhaps the most important one', []);
  assert.equal(m.pos, idx(tokens, 'important') + 2); // just past "one"
});

test('restart at the beginning after finishing part of the script', () => {
  const { m } = setup();
  speak(m, 'good evening everyone and thank you for joining us tonight');
  m.setPos(0);
  speak(m, 'good evening everyone', []);
  assert.equal(m.pos, 3);
});

test('reaching the end of the script sets done and stays put', () => {
  const { tokens, m } = setup('one two three four five six');
  speak(m, 'one two three four five six seven eight');
  assert.equal(m.pos, tokens.length);
  assert.ok(m.done);
  m.update(['six', 'again']);
  assert.equal(m.pos, tokens.length);
});

test('handles non-latin scripts (Arabic) tokenization and matching', () => {
  const { tokens, m } = setup('مرحبا بكم في المدينة الصناعية الذكية اليوم');
  assert.equal(tokens.length, 7);
  speak(m, 'مرحبا بكم في المدينة');
  assert.equal(m.pos, 4);
});
