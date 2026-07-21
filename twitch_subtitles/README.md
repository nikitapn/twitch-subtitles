# Twitch Live Subtitles

A Chrome extension that overlays live, translated subtitles on Twitch streams. Transcription runs locally through [Ollama](https://ollama.com) using Gemma 4's audio input, so no audio ever leaves your machine — translation of the resulting text uses the free [MyMemory](https://mymemory.translated.net) API.

## How it works

1. **Capture** — when you enable subtitles, `background.js` requests a `chrome.tabCapture` stream for the active Twitch tab and hands it to a hidden offscreen document (service workers can't touch media APIs directly).
2. **Playback** — `offscreen.js` plays the captured audio straight back out to your speakers (tab capture otherwise mutes the tab) and chunks it into ~5s segments via `MediaRecorder`.
3. **Transcription** — each chunk is decoded, re-encoded as WAV, and sent to a local Ollama server (`gemma4:e4b` by default) via its OpenAI-compatible `/v1/chat/completions` endpoint with `input_audio` content. The model returns both the detected language and the transcript.
4. **Translation** — two options, picked in the popup:
   - **Ollama** (default) — the same transcription request also asks Gemma 4 to translate into your target language, so translation costs no extra round-trip and has no external rate limit.
   - **MyMemory** — sends the transcript to the free MyMemory API, using the language Ollama detected as the source (not a naive "auto" guess, which that API rejects). Subject to MyMemory's free-tier usage limits.
5. **Overlay** — the subtitle box lives in `document.body`, positioned with `fixed` CSS tracked against the player's bounding box — it never touches Twitch's own React-managed DOM, which was the cause of an earlier bug where the extension broke video playback.

## Requirements

- Chrome (or a Chromium-based browser) with Manifest V3 support.
- [Ollama](https://ollama.com) running locally with a Gemma 4 audio-capable model:
  ```
  ollama pull gemma4:e4b   # or gemma4:e2b for a lighter model
  OLLAMA_ORIGINS="chrome-extension://*" ollama serve
  ```
  The `OLLAMA_ORIGINS` variable is required — Ollama rejects cross-origin requests from extensions by default.

## Installation

1. Clone this repository.
2. Go to `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the `twitch_subtitles` folder.
4. Start Ollama as shown above, then open any Twitch stream and click the extension icon.

## Usage

- **Enable/Disable** — toggles both the subtitle overlay and tab-audio capture. Also available from the right-click context menu on any Twitch page.
- **Source Language Hint** — optional; nudges Gemma 4 toward a specific language when it tends to misdetect one. The model can still report a different language if it's confident.
- **Translation Provider** — `ollama` (local, folded into the transcription call, no external limits) or `mymemory` (online, free-tier rate limited).
- **Target Language** — the language subtitles are translated into.
- **Transcript History** — a scrollable log of everything transcribed this session, since on-screen captions clear after 5 seconds. Persisted in `chrome.storage.local`; clear it with the "Clear" button.
- **Ollama Server URL / Model** — point at a non-default Ollama host/port or a different model tag.

## File structure

```
twitch_subtitles/
├── manifest.json      # Extension configuration (MV3)
├── background.js      # Service worker — tabCapture, offscreen doc lifecycle, Ollama calls
├── offscreen.js        # Tab audio capture, playback passthrough, WAV chunking
├── offscreen.html
├── content.js          # Subtitle overlay, translation, history
├── popup.html / popup.js  # Settings UI
├── styles.css
└── README.md
```

## Known limitations

- Gemma 4's audio input support in Ollama is still fairly new; there are open upstream issues around "thinking mode" leaking into transcription output on the OpenAI-compatible endpoint. This extension strips `<think>...</think>` blocks and instructs the model to reply with only the transcript, but occasional noise is possible.
- Transcription quality depends entirely on the local model you run and your hardware.
- MyMemory's free tier has usage limits; translation may occasionally fail or be rate-limited.
- Only one tab can be transcribed at a time.

## Disclaimer

Not affiliated with Twitch Interactive, Inc. or Ollama. Independent project for accessibility/translation purposes.
