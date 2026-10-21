# Voice Teleprompter for iPhone / iPad (Safari, no Mac needed)

A static web app. Nothing runs on a server: speech recognition, matching, scrolling and script storage all happen inside Safari on your device. You only need to put these files on any HTTPS web host once, because iOS Safari only allows the microphone on secure (https) pages.

Your scripts are stored **on the device** (IndexedDB). They are never uploaded to the host.

---

## Part 1: Put it online (one-time, ~5 minutes)

Pick one. All are free and give you an `https://` address automatically, so no certificates and no Mac are involved.

### Option A: GitHub Pages (recommended, permanent)

1. Sign in at github.com and click **New repository**. Name it e.g. `teleprompter`. Public is fine (only the app code is public, not your scripts).
2. In the new repo click **Add file → Upload files**. Drag in **the contents of this folder** (`index.html`, `app.js`, `sw.js`, `icons/`, ...; not the folder itself) and click **Commit changes**. Make sure `.nojekyll` and the `icons` folder are included.
3. Go to **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)**, and **Save**.
4. After a minute your app is at `https://<your-username>.github.io/teleprompter/`.

### Option B: Netlify Drop (fastest)

Go to app.netlify.com/drop, drag this folder in, and you get an `https://….netlify.app` address. Create a free Netlify account and claim the site so it isn't removed.

### Option C: Cloudflare Pages

Workers & Pages → Create → Pages → **Upload assets**, drop this folder, deploy.

> `teleprompter-ios-site.zip` (next to this folder) contains just the site files if a host wants a zip.

---

## Part 2: Install and first run on the iPhone / iPad

1. Open your address **in Safari** (not Chrome/Firefox: iOS only gives Safari the speech API).
2. Tap **Share → Add to Home Screen → Add**. Launch it from the new icon. You now get full-screen, offline launch, and Safari won't clear your data.
3. Make sure **Dictation is on**: Settings → General → Keyboard → **Enable Dictation**. Safari's speech recognition relies on it.
4. Open the app, keep **Welcome - read me first** selected, and tap **Start**. When iOS asks, allow the **Microphone** (and **Speech Recognition** if asked).
5. Read the text aloud. The current word glows yellow, spoken words fade, and the current line stays about a third of the way down the screen.

Internet: Apple's speech recognition normally needs a connection (audio may be processed on Apple's servers). The app itself opens offline. Without internet use **Auto-scroll** mode. (If your language has on-device dictation it may also work offline; try it in airplane mode.)

---

## Part 3: Everyday use

**Add scripts**
- **+ New / paste**: paste from Notes, Mail, Google Docs, anywhere, give it a title, **Save**.
- **Upload .txt / .md / backup**: pick a text or Markdown file from the Files app (iCloud Drive, On My iPhone…). Markdown symbols (`#`, `**`, links, bullets) are stripped for reading.
- **Edit** next to a script to change or delete it.

**Reading screen**
- **Start / Continue** begins a session. The app remembers where you stopped in each script.
- **Tap the middle band** of the screen (about 20–50% down) to pause / resume.
- **Tap any word above or below that band** to jump there, or **drag** the text and let go: the word at the marker becomes your position.
- **↺ Restart**, **↑ Sentence** (back one sentence), **‹ Back**, **⚙** settings. Controls hide while you read; tap the top/bottom edge or empty space to show them.
- **Status pill**: green *Listening*, amber *Reconnecting…* (Safari restarts recognition every so often; it recovers by itself), gray *Paused*.
- **Mode** menu: **Voice** (follows you) or **Auto-scroll** (constant speed with a WPM slider, no mic needed).
- If you skip words or ad-lib, it waits for the next words it recognizes. Big jumps (about 30+ words) need a manual tap.

**Settings (⚙)**: font size, line spacing, side margins, **mirror horizontally** (beam-splitter glass rigs), position marker on/off, dark/light, **recognition language** (default English US; pick Arabic, Spanish, etc. to match your script), auto-scroll speed.

**Phone locks or you switch apps**: recognition stops, your position is saved, and you get a **Resume** button when you return.

**Backups**: **Export backup** saves all scripts to a `.json` file via the share sheet (Save to Files, AirDrop...). To restore or move to another device, tap **Upload .txt / .md / backup** and pick that file. Duplicates are skipped.

**Record video while you read**: turn on **Settings → Record video while reading** before you tap Start (choose Front or Back camera there too). Allow the camera and microphone when iOS asks. A red **● 0:00** badge and a small round camera preview appear once it's rolling. The camera keeps recording through a pause (tapping the middle only pauses the voice-follow highlighting, not the take) and stops only when you tap **⏹ Stop** in the top bar or **‹ Back**. After it stops you get a review screen to play back the clip and **Save video** (through the share sheet, or a download) or **Discard**. If the app gets backgrounded mid-recording (a call comes in, you switch apps), that clip ends automatically and a new one starts when you resume; the review screen will show each part separately with a note. Recording uses more battery and storage than voice mode alone, and is independent from voice-follow, so it also works with Auto-scroll mode.

**Tips for a good run**
- Set **Settings → Display & Brightness → Auto-Lock → Never** as a backup (the app also holds a screen wake lock while reading).
- Use a quiet room and hold the phone/iPad so the mic hears you clearly; speak at a natural pace.
- Turn on Do Not Disturb so a notification doesn't interrupt the mic.
- Landscape works too (great on an iPad or a teleprompter rig).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Microphone blocked" | Safari: **aA → Website Settings → Microphone → Allow**. Or Settings → Apps → Safari → Microphone. Then Resume. |
| Nothing highlights, status stays on Reconnecting | Check internet, and that Dictation is enabled (Part 2 step 3). Try Auto-scroll meanwhile. |
| It asks for the mic every time you open the Home Screen app | This can happen in Home Screen mode. Use the same page in a normal Safari tab instead (you lose full-screen). |
| Recognition stalls after a while | Tap the middle to pause, tap again to resume, or tap the word you're on to re-sync. |
| Wrong words / no matches in another language | Set the recognition language in ⚙ to match your script. |
| Scripts disappeared | You were in a Private tab or cleared website data. Use a normal tab or the Home Screen app, and Export backups occasionally. |
| Page didn't update after I redeployed | In `sw.js` bump the `voice-teleprompter-v3` cache name, redeploy, then close and reopen the app (twice if needed). |
| "Camera or microphone access was denied" | Safari: **aA → Website Settings → Camera / Microphone → Allow**, then turn the setting back on. Reading still works without it. |
| Recording didn't save / share sheet had no good option | Tap **Save video** again and choose **Save to Files** from the share sheet, or use the plain download if your iOS version doesn't offer file-sharing for video. |
| My recording is in two or more parts | The app was backgrounded during the take (a call, switching apps, the screen locking without a wake lock). Each part is saved separately; join them afterward in the Photos app or iMovie if you want one file. |

## Limitations

- Voice mode depends on **Apple's speech recognition in Safari**: it may use Apple's servers, needs internet in most cases, and can occasionally stall or restart. This is outside the app's control.
- Not tested on a physical iPhone/iPad yet; verified in headless Chromium with a simulated speech API and, for recording, a simulated camera/microphone (storage, offline launch, backup/restore, matching, controls, record/pause/resume/background-split/save/discard, and the permission-denied fallback). Real-device behavior of speech, wake lock, Home Screen mode and video recording may differ.
- iOS wake lock support is 16.4+; in Home Screen mode the app also plays a tiny hidden silent video as a fallback.
- Scripts live per device/browser; there is no cloud sync (use Export/Restore).
- **Video recording** uses `MediaRecorder`. It records in `.mp4` on iOS 17.6+ Safari, and falls back to `.webm` on older versions or other browsers, which the Photos app can't play (VLC or a converter can). It has not been run on a physical iPhone/iPad, so exact format support and how gracefully iOS shares mic access between the camera recording and speech recognition at the same time are unverified — if voice-follow seems to suffer while recording, try Auto-scroll mode instead. Long recordings are held in memory until you save them, so keep takes to a reasonable length and save promptly; closing the tab or reloading before saving loses an unsaved recording.

## Developer notes

```
index.html  style.css  app.js     UI and session logic
matcher.js                        matching algorithm (pure, unit-tested)
speech.js                         Web Speech wrapper with auto-restart/backoff
storage.js                        IndexedDB store (localStorage fallback), export/import
recorder.js                       camera + mic recording (MediaRecorder), independent of voice-follow
sw.js  manifest.webmanifest       offline + Home Screen install
test/matcher.test.js              npm test   (18 tests, no dependencies)
```

Test locally on a computer with `python3 -m http.server 8080` and open `http://localhost:8080` (localhost counts as secure, so the mic works).
