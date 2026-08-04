// ---------- Shared state ----------
let chatHistory = [];   // for #chat section — [{role, parts:[{text}]}]
let voiceHistory = [];  // separate context thread for #voice section

// ---------- Text chat ----------
const chatWindow = document.getElementById('chat-window');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');

function addMessage(container, text, role) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  chatInput.value = '';
  addMessage(chatWindow, message, 'user');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: chatHistory })
    });
    const data = await res.json();
    if (data.reply) {
      chatHistory.push({ role: 'user', parts: [{ text: message }] });
      chatHistory.push({ role: 'model', parts: [{ text: data.reply }] });
      addMessage(chatWindow, data.reply, 'assistant');
    } else {
      addMessage(chatWindow, data.error || 'Something went wrong.', 'system');
    }
  } catch (err) {
    addMessage(chatWindow, 'Connection error. Is the server running?', 'system');
  }
});

// ---------- Voice-only section ----------
const voiceOrbBtn = document.getElementById('voice-orb-btn');
const voiceStatus = document.getElementById('voice-status');
const voiceTranscript = document.getElementById('voice-transcript');
const ttsAudio = document.getElementById('tts-audio');

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    voiceTranscript.textContent = `You: "${transcript}"`;
    sendVoiceMessage(transcript);
  };

  recognition.onend = () => {
    isListening = false;
    voiceOrbBtn.classList.remove('listening');
    if (voiceStatus.textContent === 'Listening...') voiceStatus.textContent = 'Tap to talk';
  };

  recognition.onerror = () => {
    isListening = false;
    voiceOrbBtn.classList.remove('listening');
    voiceStatus.textContent = 'Tap to talk';
  };
} else {
  voiceStatus.textContent = 'Voice input not supported in this browser — try Chrome or Edge';
}

voiceOrbBtn.addEventListener('click', () => {
  if (!recognition) return;
  if (isListening) {
    recognition.stop();
    return;
  }
  isListening = true;
  voiceOrbBtn.classList.add('listening');
  voiceStatus.textContent = 'Listening...';
  recognition.start();
});

async function sendVoiceMessage(message) {
  voiceStatus.textContent = 'Thinking...';
  try {
    const res = await fetch('/api/voice_chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: voiceHistory })
    });
    const data = await res.json();

    if (data.reply) {
      voiceHistory.push({ role: 'user', parts: [{ text: message }] });
      voiceHistory.push({ role: 'model', parts: [{ text: data.reply }] });
      voiceTranscript.textContent = data.reply;

      if (data.audio_base64) {
        playBase64Audio(data.audio_base64);
      } else {
        // Fallback to the browser's built-in voice if ElevenLabs isn't configured
        speakWithBrowser(data.reply);
      }
    } else {
      voiceStatus.textContent = 'Tap to talk';
      voiceTranscript.textContent = data.error || 'Something went wrong.';
    }
  } catch (err) {
    voiceStatus.textContent = 'Tap to talk';
    voiceTranscript.textContent = 'Connection error. Is the server running?';
  }
}

function playBase64Audio(base64) {
  voiceStatus.textContent = 'Speaking...';
  voiceOrbBtn.classList.add('speaking');
  ttsAudio.src = `data:audio/mpeg;base64,${base64}`;
  ttsAudio.play();
  ttsAudio.onended = () => {
    voiceOrbBtn.classList.remove('speaking');
    voiceStatus.textContent = 'Tap to talk';
  };
}

function speakWithBrowser(text) {
  if (!('speechSynthesis' in window)) {
    voiceStatus.textContent = 'Tap to talk';
    return;
  }
  voiceStatus.textContent = 'Speaking...';
  voiceOrbBtn.classList.add('speaking');
  const utter = new SpeechSynthesisUtterance(text);
  utter.onend = () => {
    voiceOrbBtn.classList.remove('speaking');
    voiceStatus.textContent = 'Tap to talk';
  };
  window.speechSynthesis.speak(utter);
}
