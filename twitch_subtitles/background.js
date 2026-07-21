// background.js - Service worker for the extension
const OFFSCREEN_URL = 'offscreen.html';
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'gemma4:e4b';

let activeCaptureTabId = null;

chrome.runtime.onInstalled.addListener(() => {
  console.log('Twitch Subtitles extension installed');

  chrome.contextMenus.create({
    id: 'toggle-subtitles',
    title: 'Toggle Twitch Subtitles',
    contexts: ['page'],
    documentUrlPatterns: ['*://www.twitch.tv/*', '*://twitch.tv/*']
  });
});

// Listen for messages from content scripts, the popup, and the offscreen document
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'translateText') {
    handleTranslation(request.text, request.targetLang)
      .then((translation) => sendResponse({ translation }))
      .catch((error) => sendResponse({ error: error.message }));
    return true; // Indicates async response
  }

  if (request.action === 'start-transcription') {
    const tabId = (sender.tab && sender.tab.id) || request.tabId;
    startTranscription(tabId)
      .then(() => sendResponse({ status: 'ok' }))
      .catch((error) => sendResponse({ status: 'error', message: error.message }));
    return true;
  }

  if (request.action === 'stop-transcription') {
    stopTranscription().then(() => sendResponse({ status: 'ok' }));
    return true;
  }

  if (request.target === 'background' && request.type === 'audio-chunk') {
    handleAudioChunk(request.data);
    return false;
  }

  return undefined;
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'toggle-subtitles' || !tab || !tab.id) return;

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
    if (response && response.status) {
      await startTranscription(tab.id);
    } else {
      await stopTranscription();
    }
  } catch (error) {
    console.error('Twitch Subtitles: failed to toggle from context menu', error);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeCaptureTabId) {
    stopTranscription();
  }
});

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });

  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture Twitch tab audio for live transcription'
  });
}

async function startTranscription(tabId) {
  if (!tabId) throw new Error('No target tab for transcription');

  await ensureOffscreenDocument();

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start-capture',
    streamId
  });

  if (!response || response.status !== 'ok') {
    throw new Error((response && response.message) || 'Failed to start tab capture');
  }

  activeCaptureTabId = tabId;
}

async function stopTranscription() {
  activeCaptureTabId = null;

  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-capture' });
  } catch (error) {
    // No offscreen document listening — nothing was capturing.
  }

  try {
    await chrome.offscreen.closeDocument();
  } catch (error) {
    // No offscreen document to close.
  }
}

async function handleAudioChunk(base64Wav) {
  if (!activeCaptureTabId) return;
  const tabId = activeCaptureTabId;

  try {
    const { text, sourceLang, translatedText } = await transcribeWithOllama(base64Wav);
    if (text) {
      chrome.tabs.sendMessage(tabId, { action: 'transcript', text, sourceLang, translatedText }).catch(() => {});
    }
  } catch (error) {
    console.error('Twitch Subtitles: transcription failed', error);
    chrome.tabs.sendMessage(tabId, {
      action: 'transcription-error',
      message: `Ollama transcription failed: ${error.message}`
    }).catch(() => {});
  }
}

const LANGUAGE_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', pl: 'Polish', ru: 'Russian', uk: 'Ukrainian', cs: 'Czech',
  sk: 'Slovak', nl: 'Dutch', sv: 'Swedish', tr: 'Turkish', ar: 'Arabic',
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese'
};

async function getOllamaSettings() {
  const result = await chrome.storage.sync.get(['subtitleSettings']);
  const settings = result.subtitleSettings || {};
  return {
    baseUrl: (settings.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, ''),
    model: settings.ollamaModel || DEFAULT_OLLAMA_MODEL,
    sourceLanguageHint: settings.sourceLanguageHint || '',
    translationProvider: settings.translationProvider || 'ollama',
    translationEnabled: settings.translationEnabled !== false,
    targetLanguage: settings.targetLanguage || 'en'
  };
}

function buildTranscriptionPrompt(sourceLanguageHint, translateToLang) {
  const hintName = LANGUAGE_NAMES[sourceLanguageHint];
  const hintSentence = hintName
    ? `The speech is most likely ${hintName} (${sourceLanguageHint}) — use that as a strong prior, ` +
      'but if you are confident it is actually a different language, report that instead. '
    : '';

  if (translateToLang) {
    const targetName = LANGUAGE_NAMES[translateToLang] || translateToLang;
    return 'Transcribe this audio clip verbatim in its original language, then translate that ' +
      `transcript into ${targetName}. ` + hintSentence +
      'Reply with EXACTLY one line in this format: ' +
      `<2-letter ISO 639-1 language code of the speech>||<verbatim transcript>||<${targetName} translation>. ` +
      'Reply with only that one line — no commentary, no notes, no reasoning. ' +
      'If there is no speech, reply with an empty string. ' +
      `If the speech is already in ${targetName}, repeat it unchanged as the translation.`;
  }

  return 'Transcribe this audio clip verbatim in its original language. ' +
    hintSentence +
    'Reply with EXACTLY one line in this format: ' +
    '<2-letter ISO 639-1 language code of the speech>||<verbatim transcript>. ' +
    'Example: en||Hello there, how are you doing? ' +
    'Reply with only that one line — no commentary, no notes, no reasoning. ' +
    'If there is no speech, reply with an empty string.';
}

async function transcribeWithOllama(base64Wav) {
  const {
    baseUrl, model, sourceLanguageHint,
    translationProvider, translationEnabled, targetLanguage
  } = await getOllamaSettings();

  const wantsInlineTranslation = translationEnabled &&
    translationProvider === 'ollama' &&
    targetLanguage && targetLanguage !== 'auto';

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: buildTranscriptionPrompt(sourceLanguageHint, wantsInlineTranslation ? targetLanguage : null)
            },
            {
              type: 'input_audio',
              input_audio: { data: base64Wav, format: 'wav' }
            }
          ]
        }
      ],
      stream: false
    })
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        'Ollama rejected the request (403) — start it with OLLAMA_ORIGINS="chrome-extension://*" ollama serve'
      );
    }
    throw new Error(`Ollama server returned ${response.status}`);
  }

  const data = await response.json();
  const rawContent = data?.choices?.[0]?.message?.content || '';
  return parseTranscript(rawContent, wantsInlineTranslation);
}

function parseTranscript(rawContent, expectTranslation) {
  // gemma4's thinking mode can't be disabled on the OpenAI-compatible
  // endpoint, so reasoning sometimes leaks into content wrapped in
  // <think>...</think> — strip it and keep only the actual transcript.
  const withoutThinking = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  if (!withoutThinking) {
    return { sourceLang: null, text: '', translatedText: null };
  }

  // Expected format is "<lang>||<transcript>" (optionally "||<translation>")
  // so we know the real source language instead of guessing — MyMemory's
  // translate API rejects "auto" as a source language outright.
  const langMatch = withoutThinking.match(/^([a-z]{2})\s*\|\|\s*([\s\S]*)$/i);
  if (!langMatch) {
    // Model didn't follow the format — still show the raw text rather than
    // dropping it, just without translation (no reliable source language).
    return { sourceLang: null, text: withoutThinking, translatedText: null };
  }

  const sourceLang = langMatch[1].toLowerCase();
  const rest = langMatch[2];

  if (expectTranslation) {
    const separatorIndex = rest.indexOf('||');
    if (separatorIndex !== -1) {
      return {
        sourceLang,
        text: rest.slice(0, separatorIndex).trim(),
        translatedText: rest.slice(separatorIndex + 2).trim()
      };
    }
    // Asked for a translation but didn't get one — fall through and show
    // the original text untranslated rather than erroring out.
  }

  return { sourceLang, text: rest.trim(), translatedText: null };
}

async function handleTranslation(text, targetLang) {
  try {
    // Using MyMemory Translation API (free tier)
    const response = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto|${targetLang}&de=extension@twitch-subtitles.com`
    );

    if (!response.ok) {
      throw new Error('Translation service unavailable');
    }

    const data = await response.json();

    if (data.responseStatus === 200) {
      return data.responseData.translatedText;
    } else {
      throw new Error('Translation failed');
    }
  } catch (error) {
    console.error('Translation error:', error);
    throw error;
  }
}
