// ==========================================
// Punch AI - Chat Module
// ==========================================
import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
let chatHistory = [];

const chatWindow = document.getElementById("chat-window");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

function addMessage(container, message, sender) {
  const div = document.createElement("div");
  div.className = `msg ${sender}`;
  div.textContent = message;

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

// Types the assistant's reply out word-by-word instead of dumping it
// instantly, matching how the chat product should feel.
function typeMessage(container, fullText, speedMs = 18) {
  const div = document.createElement("div");
  div.className = "msg assistant";
  const cursor = document.createElement("span");
  cursor.className = "typing-cursor";
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  const words = fullText.split(" ");
  let i = 0;

  return new Promise((resolve) => {
    div.appendChild(cursor);

    function step() {
      if (i < words.length) {
        const chunk = (i === 0 ? "" : " ") + words[i];
        cursor.insertAdjacentText("beforebegin", chunk);
        i++;
        container.scrollTop = container.scrollHeight;
        setTimeout(step, speedMs);
      } else {
        cursor.remove();
        resolve(div);
      }
    }
    step();
  });
}

async function sendChatMessage(message) {
  addMessage(chatWindow, message, "user");
  chatInput.disabled = true;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        history: chatHistory,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Server Error");
    }

    chatHistory.push({
      role: "user",
      parts: [{ text: message }],
    });

    chatHistory.push({
      role: "model",
      parts: [{ text: data.reply }],
    });

    await typeMessage(chatWindow, data.reply);
  } catch (error) {
    console.error(error);

    addMessage(chatWindow, "⚠️ Unable to contact the server.", "system");
  } finally {
    chatInput.disabled = false;
    chatInput.focus();
  }
}

const newChatBtn = document.getElementById("new-chat-btn");
if (newChatBtn) {
  newChatBtn.addEventListener("click", () => {
    chatHistory = [];
    chatWindow.innerHTML =
      '<div class="msg assistant">Hey, I\'m Punch. Ask me anything — I\'ll pull in live search results when a question needs current info.</div>';
  });
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();

  const message = chatInput.value.trim();

  if (message === "") return;

  chatInput.value = "";

  sendChatMessage(message);
});

// ==========================================
// Punch AI - Voice Module
// ==========================================

const voiceOrbBtn = document.getElementById("voice-orb-btn");
const voiceStatus = document.getElementById("voice-status");
const voiceTranscript = document.getElementById("voice-transcript");
const ttsAudio = document.getElementById("tts-audio");

let voiceHistory = [];

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let isListening = false;

// -----------------------------
// Browser Support
// -----------------------------
if (SpeechRecognition) {
  recognition = new SpeechRecognition();

  recognition.lang = "en-US";
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
} else {
  voiceStatus.textContent =
    "Speech Recognition is not supported in this browser.";
}

// -----------------------------
// Recognition Events
// -----------------------------
if (recognition) {
  recognition.onstart = () => {
    isListening = true;

    voiceOrbBtn.classList.add("listening");

    voiceStatus.textContent = "Listening...";
  };

  recognition.onend = () => {
    isListening = false;

    voiceOrbBtn.classList.remove("listening");

    voiceStatus.textContent = "Tap to Talk";
  };

  recognition.onerror = (event) => {
    console.error(event.error);

    isListening = false;

    voiceOrbBtn.classList.remove("listening");

    voiceStatus.textContent = "Voice Error";
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript.trim();

    voiceTranscript.textContent = `You: ${transcript}`;

    sendVoiceMessage(transcript);
  };
}

// -----------------------------
// Audio Controls
// -----------------------------
function stopAudio() {
  ttsAudio.pause();

  ttsAudio.currentTime = 0;

  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
  }

  voiceOrbBtn.classList.remove("speaking");
}

function unlockAudio() {
  ttsAudio.muted = true;

  const promise = ttsAudio.play();

  if (promise) {
    promise
      .then(() => {
        ttsAudio.pause();

        ttsAudio.currentTime = 0;

        ttsAudio.muted = false;
      })
      .catch(() => {
        ttsAudio.muted = false;
      });
  }
}

// -----------------------------
// Voice Button
// -----------------------------
voiceOrbBtn.addEventListener("click", () => {
  if (!recognition) return;

  stopAudio();

  unlockAudio();

  if (isListening) {
    recognition.stop();

    return;
  }

  recognition.start();
});

// -----------------------------
// Send Voice Message
// -----------------------------
async function sendVoiceMessage(message) {
  voiceStatus.textContent = "Thinking...";

  try {
    const response = await fetch("/api/voice_chat", {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        message,

        history: voiceHistory,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error);
    }

    voiceHistory.push({
      role: "user",

      parts: [{ text: message }],
    });

    voiceHistory.push({
      role: "model",

      parts: [{ text: data.reply }],
    });

    voiceTranscript.textContent = data.reply;

    if (data.audio_base64) {
      playAudio(data.audio_base64);
    } else {
      browserSpeak(data.reply);
    }
  } catch (err) {
    console.error(err);

    voiceStatus.textContent = "Server Error";

    voiceTranscript.textContent = "Unable to connect.";
  }
}

// -----------------------------
// ElevenLabs Audio
// -----------------------------
function playAudio(audioBase64) {
  voiceStatus.textContent = "Speaking...";

  voiceOrbBtn.classList.add("speaking");

  ttsAudio.src = `data:audio/mpeg;base64,${audioBase64}`;

  ttsAudio.play();

  ttsAudio.onended = () => {
    voiceStatus.textContent = "Tap to Talk";

    voiceOrbBtn.classList.remove("speaking");
  };
}

// -----------------------------
// Browser TTS Backup
// -----------------------------
function browserSpeak(text) {
  if (!("speechSynthesis" in window)) {
    voiceStatus.textContent = "Tap to Talk";

    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);

  utterance.rate = 1;

  utterance.pitch = 1;

  utterance.volume = 1;

  utterance.onstart = () => {
    voiceStatus.textContent = "Speaking...";

    voiceOrbBtn.classList.add("speaking");
  };

  utterance.onend = () => {
    voiceStatus.textContent = "Tap to Talk";

    voiceOrbBtn.classList.remove("speaking");
  };

  speechSynthesis.speak(utterance);
}

// ==========================================
// Punch AI - Authentication Module
// ==========================================




// -------------------------------------
// DOM Elements
// -------------------------------------

const modal = document.getElementById("punch-auth-overlay");

const loginTab = document.getElementById("punch-tab-login");
const signupTab = document.getElementById("punch-tab-signup");

const authForm = document.getElementById("punch-auth-form");

const nameGroup = document.getElementById("punch-name-group");

const submitBtn = document.getElementById("punch-auth-submit");

const googleBtn = document.getElementById("punch-google-btn");

const authError = document.getElementById("punch-auth-error");

let loginMode = true;

function showAuthError(message) {
  if (!authError) return;
  authError.textContent = message;
  authError.classList.add("show");
}

function clearAuthError() {
  if (!authError) return;
  authError.textContent = "";
  authError.classList.remove("show");
}

// -------------------------------------
// Authentication State
// -------------------------------------

onAuthStateChanged(auth, (user) => {
  if (user) {
    modal.classList.add("hidden");

    console.log("Logged in:", user.email);
  } else {
    modal.classList.remove("hidden");

    console.log("User not logged in");
  }
});

// -------------------------------------
// Login / Signup Tabs
// -------------------------------------

loginTab.addEventListener("click", () => {
  loginMode = true;

  loginTab.classList.add("punch-auth-active");
  signupTab.classList.remove("punch-auth-active");

  nameGroup.classList.add("punch-auth-hidden");

  submitBtn.textContent = "Log In";
  clearAuthError();
});

signupTab.addEventListener("click", () => {
  loginMode = false;

  signupTab.classList.add("punch-auth-active");
  loginTab.classList.remove("punch-auth-active");

  nameGroup.classList.remove("punch-auth-hidden");

  submitBtn.textContent = "Create Account";
  clearAuthError();
});

// -------------------------------------
// Save User Profile
// -------------------------------------

async function saveProfile(user, fullName = "") {
  const ref = doc(db, "users", user.uid);

  const snap = await getDoc(ref);

  if (snap.exists()) return;

  await setDoc(ref, {
    uid: user.uid,

    name: user.displayName || fullName || "User",

    email: user.email,

    photoURL: user.photoURL || "",

    createdAt: serverTimestamp(),
  });
}

// -------------------------------------
// Login / Signup
// -------------------------------------

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAuthError();

  const email = document.getElementById("punch-auth-email").value.trim();

  const password = document.getElementById("punch-auth-password").value;

  const fullName = document.getElementById("punch-auth-name").value.trim();

  submitBtn.disabled = true;
  const originalLabel = submitBtn.textContent;
  submitBtn.textContent = loginMode ? "Logging in..." : "Creating account...";

  try {
    if (loginMode) {
      await signInWithEmailAndPassword(auth, email, password);
    } else {
      const result = await createUserWithEmailAndPassword(
        auth,
        email,
        password,
      );

      await saveProfile(result.user, fullName);
    }

    authForm.reset();
    // Don't manually hide the modal here — onAuthStateChanged fires
    // automatically once Firebase confirms the session and hides it.
  } catch (err) {
    console.error(err);
    showAuthError(friendlyAuthError(err.code) || err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
});

function friendlyAuthError(code) {
  const map = {
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password. Try again.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/email-already-in-use": "An account already exists with that email.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
    "auth/network-request-failed": "Network error — check your connection.",
  };
  return map[code];
}

// -------------------------------------
// Google Login
// -------------------------------------

googleBtn.addEventListener("click", async () => {
  clearAuthError();
  try {
    const provider = new GoogleAuthProvider();

    const result = await signInWithPopup(auth, provider);

    await saveProfile(result.user);
  } catch (err) {
    console.error(err);
    if (err.code !== "auth/popup-closed-by-user") {
      showAuthError(friendlyAuthError(err.code) || err.message);
    }
  }
});

// -------------------------------------
// Logout Function
// -------------------------------------

window.logout = async function () {
  try {
    await signOut(auth);
  } catch (err) {
    console.error(err);
  }
};