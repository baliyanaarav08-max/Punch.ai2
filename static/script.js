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

function unlockAudioPlayback() {
  // Mobile browsers only allow audio.play()/speechSynthesis to start from a
  // DIRECT tap. Since our real reply comes back later (after a network call),
  // we "prime" both here, synchronously, at tap time, so the later async
  // playback is allowed to go through.
  ttsAudio.muted = true;
  const playPromise = ttsAudio.play();
  if (playPromise) {
    playPromise
      .then(() => {
        ttsAudio.pause();
        ttsAudio.currentTime = 0;
        ttsAudio.muted = false;
      })
      .catch(() => { ttsAudio.muted = false; });
  }
  if ('speechSynthesis' in window) {
    const unlock = new SpeechSynthesisUtterance('');
    unlock.volume = 0;
    window.speechSynthesis.speak(unlock);
  }
}

function stopSpeaking() {
  // Cuts off any reply still playing (either ElevenLabs audio or browser voice)
  ttsAudio.pause();
  ttsAudio.currentTime = 0;
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  voiceOrbBtn.classList.remove('speaking');
}

voiceOrbBtn.addEventListener('click', () => {
  if (!recognition) return;
  stopSpeaking();
  unlockAudioPlayback();
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
  stopSpeaking();
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
  const playPromise = ttsAudio.play();
  if (playPromise) {
    playPromise.catch((err) => {
      console.error('Audio playback blocked:', err);
      voiceOrbBtn.classList.remove('speaking');
      voiceStatus.textContent = 'Tap the orb to hear the reply';
      // Retry playback on the next tap instead of losing the reply entirely
      voiceOrbBtn.addEventListener('click', function retryPlay() {
        ttsAudio.play().catch(() => {});
        voiceOrbBtn.removeEventListener('click', retryPlay);
      }, { once: true });
    });
  }
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

import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const modal = document.getElementById("auth-modal-overlay");

// As soon as the page loads, check if the user is already authenticated
onAuthStateChanged(auth, (user) => {
  if (user) {
    // User is logged in -> Hide blur and reveal Punch website
    modal.classList.add("hidden");
  } else {
    // User is NOT logged in -> Keep blur background active
    modal.classList.remove("hidden");
  }
});
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  GoogleAuthProvider, 
  signInWithPopup, 
  onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const modal = document.getElementById("auth-modal-overlay");
const tabLogin = document.getElementById("tab-login");
const tabSignup = document.getElementById("tab-signup");
const nameGroup = document.getElementById("name-group");
const submitBtn = document.getElementById("auth-submit-btn");
const authForm = document.getElementById("auth-form");
let isLoginMode = true;

// 1. Auto-show popup if user is NOT logged in
onAuthStateChanged(auth, (user) => {
  if (user) {
    modal.classList.add("hidden"); // User logged in -> Hide popup
  } else {
    modal.classList.remove("hidden"); // User NOT logged in -> Auto-show popup
  }
});

// Tab Switch Logic
tabLogin.addEventListener("click", () => {
  isLoginMode = true;
  tabLogin.classList.add("active");
  tabSignup.classList.remove("active");
  nameGroup.classList.add("hidden");
  submitBtn.textContent = "Log In";
});

tabSignup.addEventListener("click", () => {
  isLoginMode = false;
  tabSignup.classList.add("active");
  tabLogin.classList.remove("active");
  nameGroup.classList.remove("hidden");
  submitBtn.textContent = "Create Account";
});

// Helper function to save profile to Firestore
async function saveUserProfile(user, extraName) {
  const userRef = doc(db, "users", user.uid);
  const userSnap = await getDoc(userRef);

  if (!userSnap.exists()) {
    await setDoc(userRef, {
      uid: user.uid,
      displayName: user.displayName || extraName || "User",
      email: user.email,
      photoURL: user.photoURL || null,
      createdAt: serverTimestamp()
    });
  }
}

// Form Submit (Login or Sign Up)
authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("auth-email").value;
  const password = document.getElementById("auth-password").value;
  const name = document.getElementById("auth-name").value;

  try {
    if (isLoginMode) {
      await signInWithEmailAndPassword(auth, email, password);
    } else {
      const res = await createUserWithEmailAndPassword(auth, email, password);
      await saveUserProfile(res.user, name);
    }
  } catch (err) {
    alert(err.message);
  }
});

// Google Sign-In
document.getElementById("google-signin-btn").addEventListener("click", async () => {
  try {
    const provider = new GoogleAuthProvider();
    const res = await signInWithPopup(auth, provider);
    await saveUserProfile(res.user);
  } catch (err) {
    alert(err.message);
  }
});

// Close Button
document.getElementById("close-auth-btn").addEventListener("click", () => {
  modal.classList.add("hidden");
});