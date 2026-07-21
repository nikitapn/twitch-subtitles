// content.js - Main content script for Twitch subtitle overlay
class TwitchSubtitles {
  constructor() {
    this.isActive = false;
    this.subtitleContainer = null;
    this.currentSubtitle = null;
    this.settings = {
      translationEnabled: true,
      translationProvider: 'ollama',
      targetLanguage: 'en',
      fontSize: '18px',
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      textColor: '#ffffff',
      position: 'bottom'
    };

    this.init();
  }

  async init() {
    await this.loadSettings();
    this.createSubtitleContainer();
    this.setupMessageListener();
    this.waitForVideoPlayer();
  }

  async loadSettings() {
    const result = await chrome.storage.sync.get(['subtitleSettings']);
    if (result.subtitleSettings) {
      this.settings = { ...this.settings, ...result.subtitleSettings };
    }
  }

  createSubtitleContainer() {
    this.subtitleContainer = document.createElement('div');
    this.subtitleContainer.id = 'twitch-subtitles-container';
    this.subtitleContainer.className = 'twitch-subtitles-overlay';

    // Apply styling. Positioned as 'fixed' and kept in document.body (never
    // inside Twitch's own player subtree) so we don't touch a React-managed
    // DOM node — appending into it caused React reconciliation errors that
    // crashed the player. Position is tracked against the player's bounding
    // box instead; see trackVideoPlayerPosition().
    Object.assign(this.subtitleContainer.style, {
      position: 'fixed',
      zIndex: '9999',
      pointerEvents: 'none',
      textAlign: 'center',
      fontSize: this.settings.fontSize,
      color: this.settings.textColor,
      fontFamily: 'Arial, sans-serif',
      textShadow: '2px 2px 4px rgba(0,0,0,0.8)',
      display: 'none'
    });

    document.body.appendChild(this.subtitleContainer);
  }

  waitForVideoPlayer() {
    const findAndTrack = () => {
      const videoPlayer = document.querySelector('[data-a-target="video-player"]');
      if (videoPlayer && videoPlayer !== this.videoPlayer) {
        this.videoPlayer = videoPlayer;
        this.trackVideoPlayerPosition();
        return true;
      }
      return false;
    };

    if (findAndTrack()) return;

    const observer = new MutationObserver(() => {
      if (findAndTrack()) {
        observer.disconnect();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  trackVideoPlayerPosition() {
    const updatePosition = () => {
      if (!this.videoPlayer || !this.videoPlayer.isConnected) return;
      const rect = this.videoPlayer.getBoundingClientRect();
      Object.assign(this.subtitleContainer.style, {
        left: `${rect.left + rect.width / 2}px`,
        top: `${rect.bottom - 60}px`,
        transform: 'translateX(-50%)',
        width: `${rect.width * 0.8}px`
      });
    };

    updatePosition();

    const resizeObserver = new ResizeObserver(updatePosition);
    resizeObserver.observe(this.videoPlayer);

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
  }

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      switch (request.action) {
        case 'toggle':
          this.toggle();
          sendResponse({ status: this.isActive });
          break;
        case 'updateSettings':
          this.updateSettings(request.settings);
          sendResponse({ status: 'updated' });
          break;
        case 'getStatus':
          sendResponse({ isActive: this.isActive });
          break;
        // Sent by background.js once it has a transcript back from Ollama
        // for a captured tab-audio chunk.
        case 'transcript':
          this.processFinalTranscript(request.text, request.sourceLang, request.translatedText);
          sendResponse({ status: 'ok' });
          break;
        case 'transcription-error':
          this.showError(request.message);
          sendResponse({ status: 'ok' });
          break;
      }
    });
  }

  async toggle() {
    if (this.isActive) {
      this.stop();
    } else {
      this.start();
    }
  }

  start() {
    // Actual tab-audio capture is started by background.js (triggered from
    // the popup or the context menu, both real user gestures required by
    // chrome.tabCapture) — this just switches the overlay on.
    this.isActive = true;
    this.subtitleContainer.style.display = 'block';
    this.showStatus('Subtitles activated');
  }

  stop() {
    this.isActive = false;
    this.subtitleContainer.style.display = 'none';
    this.clearSubtitle();
    this.showStatus('Subtitles deactivated');
  }

  async processFinalTranscript(text, sourceLang, translatedText) {
    let displayText = text;
    const targetLang = this.settings.targetLanguage;

    if (translatedText) {
      // background.js already asked Ollama to translate inline as part of
      // the same transcription call — nothing left to do here.
      displayText = translatedText;
    } else {
      // Only fall back to MyMemory when it's the explicitly chosen provider
      // (never as a silent fallback) and we actually know the source
      // language — MyMemory's API rejects "auto" as a source language.
      const shouldTranslateViaMyMemory = this.settings.translationEnabled &&
        this.settings.translationProvider === 'mymemory' &&
        sourceLang &&
        targetLang !== 'auto' &&
        sourceLang.toLowerCase() !== targetLang.toLowerCase();

      if (shouldTranslateViaMyMemory) {
        try {
          displayText = await this.translateText(text, sourceLang, targetLang);
        } catch (error) {
          console.error('Translation failed:', error);
          // Fall back to original text
        }
      }
    }

    this.displaySubtitle(displayText, false);
    this.appendToHistory(text, displayText, sourceLang);

    // Clear subtitle after 5 seconds
    setTimeout(() => {
      this.clearSubtitle();
    }, 5000);
  }

  async appendToHistory(originalText, displayText, sourceLang) {
    const MAX_HISTORY_ENTRIES = 200;
    const { subtitleHistory = [] } = await chrome.storage.local.get('subtitleHistory');

    subtitleHistory.push({
      time: Date.now(),
      sourceLang: sourceLang || null,
      original: originalText,
      text: displayText
    });

    if (subtitleHistory.length > MAX_HISTORY_ENTRIES) {
      subtitleHistory.splice(0, subtitleHistory.length - MAX_HISTORY_ENTRIES);
    }

    chrome.storage.local.set({ subtitleHistory });
  }

  async translateText(text, sourceLang, targetLang) {
    // Using a simple translation API (you might want to use Google Translate API or similar)
    // For demo purposes, this is a placeholder
    const response = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sourceLang}|${targetLang}`);
    const data = await response.json();
    return data.responseData.translatedText || text;
  }

  displaySubtitle(text, isInterim) {
    if (!this.subtitleContainer) return;

    // Create or update subtitle element
    if (!this.currentSubtitle) {
      this.currentSubtitle = document.createElement('div');
      this.currentSubtitle.className = 'subtitle-text';
      Object.assign(this.currentSubtitle.style, {
        backgroundColor: this.settings.backgroundColor,
        padding: '8px 16px',
        borderRadius: '4px',
        margin: '4px 0',
        display: 'inline-block',
        maxWidth: '100%',
        wordWrap: 'break-word',
        opacity: isInterim ? '0.7' : '1'
      });
      this.subtitleContainer.appendChild(this.currentSubtitle);
    }

    this.currentSubtitle.textContent = text;
    this.currentSubtitle.style.opacity = isInterim ? '0.7' : '1';
  }

  clearSubtitle() {
    if (this.currentSubtitle) {
      this.currentSubtitle.remove();
      this.currentSubtitle = null;
    }
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };

    if (this.subtitleContainer) {
      Object.assign(this.subtitleContainer.style, {
        fontSize: this.settings.fontSize,
        color: this.settings.textColor
      });
    }

    chrome.storage.sync.set({ subtitleSettings: this.settings });
  }

  showStatus(message) {
    // Create temporary status message
    const status = document.createElement('div');
    status.textContent = message;
    status.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #9146ff;
      color: white;
      padding: 10px;
      border-radius: 4px;
      z-index: 10000;
      font-family: Arial, sans-serif;
    `;

    document.body.appendChild(status);
    setTimeout(() => status.remove(), 3000);
  }

  showError(message) {
    const error = document.createElement('div');
    error.textContent = message;
    error.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #ff4444;
      color: white;
      padding: 10px;
      border-radius: 4px;
      z-index: 10000;
      font-family: Arial, sans-serif;
      max-width: 320px;
    `;

    document.body.appendChild(error);
    setTimeout(() => error.remove(), 5000);
  }
}

// Initialize when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new TwitchSubtitles();
  });
} else {
  new TwitchSubtitles();
}
