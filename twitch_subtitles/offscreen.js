// offscreen.js - captures tab audio via chrome.tabCapture, plays it back so
// the user still hears the stream, and periodically ships WAV-encoded chunks
// to the background service worker for transcription.
'use strict';

const CHUNK_MS = 5000;
// Below this average PCM amplitude (0-1 range) a chunk is treated as silence
// and skipped, since sending silence to the model tends to produce
// hallucinated transcript text instead of an empty response.
const SILENCE_THRESHOLD = 0.01;

let mediaStream = null;
let playbackAudio = null;
let decodeContext = null;
let capturing = false;
let recordLoopPromise = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return undefined;

  if (message.type === 'start-capture') {
    startCapture(message.streamId).then(
      () => sendResponse({ status: 'ok' }),
      (error) => sendResponse({ status: 'error', message: error.message })
    );
    return true;
  }

  if (message.type === 'stop-capture') {
    stopCapture();
    sendResponse({ status: 'ok' });
    return false;
  }

  return undefined;
});

async function startCapture(streamId) {
  if (capturing) {
    stopCapture();
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    }
  });

  // Route captured audio back out to speakers so the user keeps hearing the
  // stream — tabCapture mutes the tab's normal output once captured.
  playbackAudio = new Audio();
  playbackAudio.srcObject = mediaStream;
  playbackAudio.volume = 1.0;
  await playbackAudio.play();

  decodeContext = new (window.AudioContext || window.webkitAudioContext)();

  capturing = true;
  recordLoopPromise = runRecordLoop();
}

function stopCapture() {
  capturing = false;

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (playbackAudio) {
    playbackAudio.pause();
    playbackAudio.srcObject = null;
    playbackAudio = null;
  }

  if (decodeContext) {
    decodeContext.close();
    decodeContext = null;
  }
}

async function runRecordLoop() {
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  while (capturing && mediaStream) {
    try {
      const blob = await recordChunk(mediaStream, mimeType);
      await processChunk(blob);
    } catch (error) {
      console.error('Twitch Subtitles: chunk capture/processing failed', error);
    }
  }
}

function recordChunk(stream, mimeType) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch (error) {
      reject(error);
      return;
    }

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = (event) => reject(event.error || new Error('MediaRecorder error'));
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));

    recorder.start();
    setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, CHUNK_MS);
  });
}

async function processChunk(blob) {
  if (!decodeContext || blob.size === 0) return;

  const arrayBuffer = await blob.arrayBuffer();
  let audioBuffer;
  try {
    audioBuffer = await decodeContext.decodeAudioData(arrayBuffer);
  } catch (error) {
    // A too-short or malformed chunk (e.g. right at capture start/stop) —
    // not fatal, just skip it.
    return;
  }

  if (!hasAudibleSignal(audioBuffer)) return;

  const wavBase64 = audioBufferToWavBase64(audioBuffer);

  chrome.runtime.sendMessage({
    target: 'background',
    type: 'audio-chunk',
    data: wavBase64
  });
}

function hasAudibleSignal(audioBuffer) {
  const channelData = audioBuffer.getChannelData(0);
  let sumSquares = 0;
  for (let i = 0; i < channelData.length; i++) {
    sumSquares += channelData[i] * channelData[i];
  }
  const rms = Math.sqrt(sumSquares / channelData.length);
  return rms >= SILENCE_THRESHOLD;
}

// Encodes an AudioBuffer as 16-bit PCM WAV and returns it as a base64 string.
function audioBufferToWavBase64(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
