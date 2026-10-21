// Web Speech API wrapper that keeps recognition alive while a session is active.
// iOS Safari ends recognition on its own after silence / ~1 minute / errors, so we restart in onend.
import { hypothesisWords } from './matcher.js';

const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition;

export class SpeechFollower {
  static get supported() { return !!SR(); }

  /**
   * @param {{lang:string,
   *          onWords:(words:string[], sessionId:number)=>void,
   *          onStatus:(s:'listening'|'reconnecting'|'paused'|'error')=>void,
   *          onFatal:(msg:string)=>void}} h
   */
  constructor(h) {
    Object.assign(this, { lang: h.lang, onWords: h.onWords, onStatus: h.onStatus, onFatal: h.onFatal });
    this.active = false;
    this.rec = null;
    this.sessionId = 0;
    this.failures = 0; // consecutive recognition sessions that produced nothing / errored
    this.gotResult = false;
    this.lastActivity = 0;
    this.timer = null;
    this.watchdog = null;
  }

  /** Must be called from a user gesture the first time (iOS). */
  start() {
    this.active = true;
    this.failures = 0;
    this._spawn();
    clearInterval(this.watchdog);
    // If nothing at all (no audio/speech events) for 45s, recycle the session; harmless when merely silent.
    this.watchdog = setInterval(() => {
      if (this.active && this.rec && Date.now() - this.lastActivity > 45000) {
        this.lastActivity = Date.now();
        try { this.rec.abort(); } catch { /* onend restarts */ }
      }
    }, 5000);
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
    const r = this.rec;
    this.rec = null;
    if (r) { r.onend = r.onerror = r.onresult = null; try { r.abort(); } catch { /* ignore */ } }
    this.onStatus('paused');
  }

  setLang(lang) {
    this.lang = lang;
    if (this.active && this.rec) { try { this.rec.abort(); } catch { /* restarts with new lang */ } }
  }

  _delay() {
    if (this.failures <= 0) return 30; // "immediately"
    return Math.min(200 * 2 ** (this.failures - 1), 4000);
  }

  _spawn() {
    if (!this.active || this.rec) return;
    const R = SR();
    const rec = new R();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = this.lang;
    this.rec = rec;
    this.gotResult = false;
    const sid = ++this.sessionId;
    const touch = () => { this.lastActivity = Date.now(); };

    rec.onstart = () => { touch(); this.onStatus('listening'); };
    rec.onaudiostart = rec.onsoundstart = rec.onspeechstart = touch;
    rec.onresult = (e) => {
      touch();
      this.gotResult = true;
      this.failures = 0;
      let t = '';
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript + ' ';
      const words = hypothesisWords(t);
      if (words.length) this.onWords(words, sid);
    };
    rec.onerror = (e) => {
      switch (e.error) {
        case 'not-allowed':
        case 'service-not-allowed':
          this.active = false;
          this.onFatal('Microphone / speech recognition is blocked. In Safari: aA menu → Website Settings → Microphone → Allow, and check Settings → Siri & Search / Dictation is enabled. Or use Auto-scroll mode.');
          break;
        case 'audio-capture':
          this.active = false;
          this.onFatal('No microphone found or it is in use by another app.');
          break;
        case 'no-speech':
          break; // normal during pauses; onend will restart
        case 'aborted':
          break; // we or the OS aborted; onend restarts if still active
        case 'network':
          this.failures++;
          this.onStatus('reconnecting');
          break;
        default:
          this.failures++;
      }
    };
    rec.onend = () => {
      if (this.rec !== rec) return; // stale
      this.rec = null;
      if (!this.active) return;
      if (!this.gotResult && Date.now() - this.lastActivity < 1500) this.failures++; // died instantly
      const d = this._delay();
      if (d >= 300) this.onStatus('reconnecting');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this._spawn(), d);
    };

    try {
      rec.start();
    } catch {
      // InvalidStateError if a previous session is still winding down: retry shortly
      this.rec = null;
      this.failures++;
      this.onStatus('reconnecting');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this._spawn(), this._delay());
    }
  }
}
