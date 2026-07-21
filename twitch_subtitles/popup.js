// popup.js - Extension popup logic
class PopupController {
  constructor() {
    this.isActive = false;
    this.settings = {
      translationEnabled: true,
      translationProvider: 'ollama',
      targetLanguage: 'en',
      fontSize: '18px',
      textColor: '#ffffff',
      bgOpacity: 80,
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'gemma4:e4b',
      sourceLanguageHint: ''
    };
    
    this.init();
  }

  async init() {
    await this.loadSettings();
    this.setupEventListeners();
    this.updateUI();
    this.checkCurrentTab();
    await this.loadHistory();
    this.watchHistory();
  }

  async loadSettings() {
    const result = await chrome.storage.sync.get(['subtitleSettings']);
    if (result.subtitleSettings) {
      this.settings = { ...this.settings, ...result.subtitleSettings };
    }
    this.applySettingsToUI();
  }

  setupEventListeners() {
    // Toggle button
    document.getElementById('toggle-btn').addEventListener('click', () => {
      this.toggleSubtitles();
    });

    // Settings listeners
    document.getElementById('translation-enabled').addEventListener('change', (e) => {
      this.settings.translationEnabled = e.target.checked;
      this.saveSettings();
    });

    document.getElementById('translation-provider').addEventListener('change', (e) => {
      this.settings.translationProvider = e.target.value;
      this.saveSettings();
    });

    document.getElementById('target-language').addEventListener('change', (e) => {
      this.settings.targetLanguage = e.target.value;
      this.saveSettings();
    });

    document.getElementById('source-language-hint').addEventListener('change', (e) => {
      this.settings.sourceLanguageHint = e.target.value;
      this.saveSettings();
    });

    document.getElementById('font-size').addEventListener('change', (e) => {
      this.settings.fontSize = e.target.value;
      this.saveSettings();
      this.updatePreview();
    });

    document.getElementById('text-color').addEventListener('change', (e) => {
      this.settings.textColor = e.target.value;
      this.saveSettings();
      this.updatePreview();
    });

    document.getElementById('bg-opacity').addEventListener('input', (e) => {
      this.settings.bgOpacity = parseInt(e.target.value);
      this.saveSettings();
      this.updatePreview();
    });

    document.getElementById('ollama-base-url').addEventListener('change', (e) => {
      this.settings.ollamaBaseUrl = e.target.value.trim() || 'http://localhost:11434';
      this.saveSettings();
    });

    document.getElementById('ollama-model').addEventListener('change', (e) => {
      this.settings.ollamaModel = e.target.value.trim() || 'gemma4:e4b';
      this.saveSettings();
    });

    document.getElementById('clear-history-btn').addEventListener('click', () => {
      chrome.storage.local.remove('subtitleHistory');
    });
  }

  async loadHistory() {
    const { subtitleHistory = [] } = await chrome.storage.local.get('subtitleHistory');
    this.renderHistory(subtitleHistory);
  }

  watchHistory() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.subtitleHistory) {
        this.renderHistory(changes.subtitleHistory.newValue || []);
      }
    });
  }

  renderHistory(entries) {
    const box = document.getElementById('history-box');
    const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 20;

    if (!entries.length) {
      box.innerHTML = '<div class="history-empty">No subtitles yet</div>';
      return;
    }

    box.innerHTML = entries.map((entry) => {
      const time = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const showOriginal = entry.original && entry.original !== entry.text;
      return `
        <div class="history-entry">
          <span class="history-time">${escapeHtml(time)}</span>${escapeHtml(entry.text)}
          ${showOriginal ? `<div class="history-original">${escapeHtml(entry.original)}</div>` : ''}
        </div>
      `;
    }).join('');

    if (wasNearBottom) {
      box.scrollTop = box.scrollHeight;
    }
  }

  applySettingsToUI() {
    document.getElementById('translation-enabled').checked = this.settings.translationEnabled;
    document.getElementById('translation-provider').value = this.settings.translationProvider;
    document.getElementById('target-language').value = this.settings.targetLanguage;
    document.getElementById('source-language-hint').value = this.settings.sourceLanguageHint;
    document.getElementById('font-size').value = this.settings.fontSize;
    document.getElementById('text-color').value = this.settings.textColor;
    document.getElementById('bg-opacity').value = this.settings.bgOpacity;
    document.getElementById('ollama-base-url').value = this.settings.ollamaBaseUrl;
    document.getElementById('ollama-model').value = this.settings.ollamaModel;
    this.updatePreview();
  }

  updatePreview() {
    const preview = document.getElementById('preview-text');
    const opacity = this.settings.bgOpacity / 100;
    
    preview.style.fontSize = this.settings.fontSize;
    preview.style.color = this.settings.textColor;
    preview.style.backgroundColor = `rgba(0, 0, 0, ${opacity})`;
  }

  async saveSettings() {
    await chrome.storage.sync.set({ subtitleSettings: this.settings });
    
    // Send settings to content script
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && this.isTwitchTab(tab.url)) {
        chrome.tabs.sendMessage(tab.id, {
          action: 'updateSettings',
          settings: this.settings
        });
      }
    } catch (error) {
      console.error('Failed to send settings to content script:', error);
    }
  }

  async toggleSubtitles() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || !this.isTwitchTab(tab.url)) {
        this.showError('Please navigate to a Twitch stream page');
        return;
      }

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
      this.isActive = response.status;
      this.updateUI();

      // Start/stop the actual tab-audio capture. This has to be triggered
      // directly from this click handler (not proxied further through the
      // content script) so it still counts as the user gesture that
      // chrome.tabCapture requires.
      const captureResponse = await chrome.runtime.sendMessage({
        action: this.isActive ? 'start-transcription' : 'stop-transcription',
        tabId: tab.id
      });

      if (this.isActive && captureResponse && captureResponse.status === 'error') {
        this.showError(captureResponse.message || 'Failed to start tab audio capture');
      }
    } catch (error) {
      console.error('Failed to toggle subtitles:', error);
      this.showError('Failed to communicate with Twitch page. Please refresh and try again.');
    }
  }

  async checkCurrentTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab || !this.isTwitchTab(tab.url)) {
        this.showError('This extension only works on Twitch stream pages');
        return;
      }

      // Check if content script is loaded and get current status
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
      this.isActive = response.isActive;

      this.updateUI();
      
    } catch (error) {
      console.error('Failed to check tab status:', error);
      this.showError('Please refresh the Twitch page and try again');
    }
  }

  isTwitchTab(url) {
    return url && (url.includes('twitch.tv/') && !url.includes('/directory'));
  }

  updateUI() {
    const statusEl = document.getElementById('status');
    const toggleBtn = document.getElementById('toggle-btn');
    const statusText = statusEl.querySelector('.status-text');

    if (this.isActive) {
      statusEl.className = 'status active';
      statusText.textContent = 'Subtitles: Active';
      toggleBtn.textContent = 'Disable';
      toggleBtn.classList.add('active');
    } else {
      statusEl.className = 'status inactive';
      statusText.textContent = 'Subtitles: Inactive';
      toggleBtn.textContent = 'Enable';
      toggleBtn.classList.remove('active');
    }
  }

  showError(message) {
    const errorEl = document.getElementById('error-message');
    errorEl.textContent = message;
    errorEl.style.display = 'block';
    
    setTimeout(() => {
      errorEl.style.display = 'none';
    }, 5000);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});