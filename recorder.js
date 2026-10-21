// Camera + mic video recording, independent of the voice-follow speech recognizer.
// Runs alongside it: the camera stream is only used for MediaRecorder, never analyzed,
// so it does not interfere with the matcher or with SpeechRecognition's own mic use.
const CANDIDATES = [
  'video/mp4;codecs=avc1,mp4a.40.2', // iOS Safari 17.6+ recording target
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function pickMimeType() {
  const MR = window.MediaRecorder;
  if (!MR) return null;
  for (const t of CANDIDATES) if (MR.isTypeSupported && MR.isTypeSupported(t)) return t;
  return ''; // let the browser choose its default
}

export class VideoRecorder {
  static get supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  constructor() {
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.mimeType = '';
    this.startedAt = 0;
    this.stopped = null; // resolves with the Blob when stop() finishes
  }

  /**
   * Must be called from a user gesture (Start tap) on iOS.
   * @param {{facingMode:'user'|'environment'}} opts
   * @returns {Promise<MediaStream>} the live stream, for a preview <video>
   */
  async start({ facingMode = 'user' } = {}) {
    if (!VideoRecorder.supported) throw new Error('not-supported');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true, // separate mic tap from SpeechRecognition's; both are allowed to read the mic concurrently
    });
    this.mimeType = pickMimeType();
    if (this.mimeType == null) { this.dispose(); throw new Error('not-supported'); }
    const opts = this.mimeType ? { mimeType: this.mimeType } : {};
    try {
      this.rec = new MediaRecorder(this.stream, opts);
    } catch {
      this.rec = new MediaRecorder(this.stream); // mimeType rejected; fall back to the default
      this.mimeType = '';
    }
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.stoppedPromise = new Promise((resolve) => {
      this.rec.onstop = () => resolve(new Blob(this.chunks, { type: this.rec.mimeType || this.mimeType || 'video/webm' }));
    });
    this.rec.start(1000); // 1s timeslice: bounds data loss if the tab is killed before stop()
    this.startedAt = Date.now();
    return this.stream;
  }

  get recording() { return !!this.rec && this.rec.state !== 'inactive'; }
  get elapsedMs() { return this.startedAt ? Date.now() - this.startedAt : 0; }

  /** Stop recording and release the camera/mic. Resolves with the recorded Blob (null if nothing was captured). */
  async stop() {
    if (!this.rec) return null;
    if (this.rec.state === 'inactive') return null;
    this.rec.stop();
    const blob = await this.stoppedPromise;
    this.dispose();
    return blob && blob.size ? blob : null;
  }

  /** Abandon without producing a blob (e.g. the user discards, or an error occurs). */
  dispose() {
    if (this.rec && this.rec.state !== 'inactive') { try { this.rec.stop(); } catch { /* ignore */ } }
    this.rec = null;
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
  }

  static extFor(mimeType) { return /mp4/.test(mimeType) ? 'mp4' : 'webm'; }
}
