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
  addDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
let chatHistory = [];

const chatWindow = document.getElementById("chat-window");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

// ==========================================
// Punch AI - User Profile (name, hobbies, goals, photo)
// ==========================================
let userProfile = {}; // never includes email/password — profile doc is separate from auth

const profileCorner = document.getElementById("profile-corner");
const profileAvatar = document.getElementById("profile-avatar");
const customizeBtn = document.getElementById("customize-btn");
const customizeOverlay = document.getElementById("customize-overlay");
const customizeClose = document.getElementById("customize-close");
const customizeForm = document.getElementById("customize-form");
const customizeAvatarPreview = document.getElementById("customize-avatar-preview");
const customizePhotoUrl = document.getElementById("customize-photo-url");
const customizeName = document.getElementById("customize-name");
const customizeHobby = document.getElementById("customize-hobby");
const customizeWant = document.getElementById("customize-want");
const customizeGoal = document.getElementById("customize-goal");
const customizeAbout = document.getElementById("customize-about");
const customizeNote = document.getElementById("customize-note");

const DEFAULT_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="%238b5cf6"/><circle cx="20" cy="16" r="7" fill="%23fff"/><path d="M6 35c1-8 7-13 14-13s13 5 14 13" fill="%23fff"/></svg>'
  );

function profileDocRef(uid) {
  return doc(db, "users", uid, "profile", "info");
}

function applyAvatar(url) {
  const src = url && url.trim() ? url.trim() : DEFAULT_AVATAR;
  profileAvatar.src = src;
  customizeAvatarPreview.src = src;
}

function fillCustomizeForm() {
  customizePhotoUrl.value = userProfile.photoURL || "";
  customizeName.value = userProfile.name || "";
  customizeHobby.value = userProfile.hobby || "";
  customizeWant.value = userProfile.wantToBecome || "";
  customizeGoal.value = userProfile.goal || "";
  customizeAbout.value = userProfile.about || "";
  applyAvatar(userProfile.photoURL);
}

async function loadProfile(uid) {
  try {
    const snap = await getDoc(profileDocRef(uid));
    userProfile = snap.exists() ? snap.data() : {};
  } catch (err) {
    console.error("Failed to load profile:", err);
    userProfile = {};
  }
  profileCorner.classList.remove("hidden");
  applyAvatar(userProfile.photoURL);
  fillCustomizeForm();
}

function clearProfileUI() {
  userProfile = {};
  profileCorner.classList.add("hidden");
  applyAvatar("");
}

function openCustomize() {
  if (!currentUser) {
    modal.classList.remove("hidden");
    return;
  }
  fillCustomizeForm();
  customizeNote.classList.add("hidden");
  customizeOverlay.classList.remove("hidden");
}

function closeCustomize() {
  customizeOverlay.classList.add("hidden");
}

customizeBtn.addEventListener("click", openCustomize);
customizeClose.addEventListener("click", closeCustomize);
customizeOverlay.addEventListener("click", (e) => {
  if (e.target === customizeOverlay) closeCustomize();
});
profileCorner.addEventListener("click", openCustomize);

customizePhotoUrl.addEventListener("input", () => {
  applyAvatar(customizePhotoUrl.value);
});

customizeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUser) return;

  const saveBtn = document.getElementById("customize-save");
  saveBtn.disabled = true;

  const newProfile = {
    name: customizeName.value.trim(),
    photoURL: customizePhotoUrl.value.trim(),
    hobby: customizeHobby.value.trim(),
    wantToBecome: customizeWant.value.trim(),
    goal: customizeGoal.value.trim(),
    about: customizeAbout.value.trim(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(profileDocRef(currentUser.uid), newProfile, { merge: true });
    userProfile = { ...userProfile, ...newProfile };
    applyAvatar(userProfile.photoURL);
    customizeNote.textContent = "Saved. Punch will use this from your next message.";
    customizeNote.classList.remove("hidden");
    setTimeout(() => customizeOverlay.classList.add("hidden"), 900);
  } catch (err) {
    console.error("Failed to save profile:", err);
    customizeNote.textContent = "Couldn't save right now — please try again.";
    customizeNote.classList.remove("hidden");
  } finally {
    saveBtn.disabled = false;
  }
});

// Strips fields the AI shouldn't need (nothing sensitive is stored here in
// the first place — no email/password — but keep this explicit and small).
function profileForApi() {
  if (!userProfile) return null;
  const { name, hobby, wantToBecome, goal, about } = userProfile;
  return { name, hobby, wantToBecome, goal, about };
}

// ==========================================
// Punch AI - Multiple Named Chats (Firestore)
// ==========================================

const chatListEl = document.getElementById("chat-list");

let currentUser = null;
let currentChatId = null;
let unsubscribeChatList = null;
const DEFAULT_GREETING =
  "Hey, I'm Punch. Ask me anything — I'll pull in live search results when a question needs current info.";

function chatsCol(uid) {
  return collection(db, "users", uid, "chats");
}
function messagesCol(uid, chatId) {
  return collection(db, "users", uid, "chats", chatId, "messages");
}

function renderChatWindowFromHistory(history) {
  chatWindow.innerHTML = "";
  if (history.length === 0) {
    addMessage(chatWindow, DEFAULT_GREETING, "assistant");
    return;
  }
  history.forEach((turn) => {
    const sender = turn.role === "model" ? "assistant" : "user";
    addMessage(chatWindow, turn.parts[0].text, sender);
  });
}

async function loadChatMessages(uid, chatId) {
  const q = query(messagesCol(uid, chatId), orderBy("createdAt", "asc"));
  const snap = await getDocs(q);
  chatHistory = [];
  snap.forEach((docSnap) => {
    const m = docSnap.data();
    chatHistory.push({ role: m.role, parts: [{ text: m.text }] });
  });
  renderChatWindowFromHistory(chatHistory);
}

async function selectChat(chatId) {
  if (!currentUser || chatId === currentChatId) return;
  currentChatId = chatId;
  highlightActiveChat();
  await loadChatMessages(currentUser.uid, chatId);
}

function highlightActiveChat() {
  chatListEl.querySelectorAll(".chat-list-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.chatId === currentChatId);
  });
}

function renderChatList(chats) {
  if (chats.length === 0) {
    chatListEl.innerHTML = '<div class="chat-list-empty">No chats yet — start one!</div>';
    return;
  }
  chatListEl.innerHTML = "";
  chats.forEach((c) => {
    const item = document.createElement("div");
    item.className = "chat-list-item";
    item.dataset.chatId = c.id;

    const title = document.createElement("span");
    title.className = "chat-list-item-title";
    title.textContent = c.title || "New Chat";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "chat-list-item-delete";
    del.innerHTML = "&times;";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      handleDeleteChat(c.id);
    });

    item.appendChild(title);
    item.appendChild(del);
    item.addEventListener("click", () => selectChat(c.id));
    chatListEl.appendChild(item);
  });
  highlightActiveChat();
}

function watchChatList(uid) {
  if (unsubscribeChatList) unsubscribeChatList();
  const q = query(chatsCol(uid), orderBy("updatedAt", "desc"), limit(50));
  unsubscribeChatList = onSnapshot(q, async (snap) => {
    const chats = [];
    snap.forEach((d) => chats.push({ id: d.id, ...d.data() }));
    renderChatList(chats);

    // First load after login: jump into the most recent chat, or start one.
    if (!currentChatId) {
      if (chats.length > 0) {
        await selectChat(chats[0].id);
      } else {
        await createNewChat();
      }
    }
  });
}

async function createNewChat() {
  if (!currentUser) {
    // Not logged in — just reset the in-memory chat, nothing to save.
    chatHistory = [];
    renderChatWindowFromHistory(chatHistory);
    return;
  }
  const ref = await addDoc(chatsCol(currentUser.uid), {
    title: "New Chat",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  currentChatId = ref.id;
  chatHistory = [];
  renderChatWindowFromHistory(chatHistory);
  // onSnapshot from watchChatList will pick up the new doc and re-render
  // the sidebar; just make sure the highlight lands on it once it does.
  setTimeout(highlightActiveChat, 300);
}

async function handleDeleteChat(chatId) {
  if (!currentUser) return;
  if (!confirm("Delete this chat? This can't be undone.")) return;

  const wasActive = chatId === currentChatId;

  // Delete the chat's messages, then the chat doc itself.
  const msgSnap = await getDocs(messagesCol(currentUser.uid, chatId));
  await Promise.all(msgSnap.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(doc(db, "users", currentUser.uid, "chats", chatId));

  if (wasActive) {
    currentChatId = null;
    // Let the sidebar listener pick the next chat automatically, or
    // create a fresh one if that was the last one.
    const remaining = await getDocs(query(chatsCol(currentUser.uid), orderBy("updatedAt", "desc"), limit(1)));
    if (remaining.empty) {
      await createNewChat();
    } else {
      await selectChat(remaining.docs[0].id);
    }
  }
}

async function saveMessagePair(uid, chatId, userText, replyText, isFirstMessage) {
  await addDoc(messagesCol(uid, chatId), {
    role: "user",
    text: userText,
    createdAt: serverTimestamp(),
  });
  await addDoc(messagesCol(uid, chatId), {
    role: "model",
    text: replyText,
    createdAt: serverTimestamp(),
  });

  const chatRef = doc(db, "users", uid, "chats", chatId);
  const update = { updatedAt: serverTimestamp() };
  if (isFirstMessage) {
    // Auto-title the chat from the first user message, like ChatGPT does.
    update.title = userText.length > 42 ? userText.slice(0, 42) + "…" : userText;
  }
  await updateDoc(chatRef, update);
}

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
  const isFirstMessage = chatHistory.length === 0;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        history: chatHistory,
        profile: profileForApi(),
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

    if (currentUser && currentChatId) {
      saveMessagePair(currentUser.uid, currentChatId, message, data.reply, isFirstMessage).catch(
        (err) => console.error("Failed to save chat:", err),
      );
    }
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
    createNewChat();
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

        profile: profileForApi(),
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
    currentUser = user;
    watchChatList(user.uid);
    loadProfile(user.uid);

    console.log("Logged in:", user.email);
  } else {
    modal.classList.remove("hidden");

    // Reset all chat state on logout so nothing leaks into the next session.
    currentUser = null;
    currentChatId = null;
    chatHistory = [];
    if (unsubscribeChatList) {
      unsubscribeChatList();
      unsubscribeChatList = null;
    }
    chatWindow.innerHTML = `<div class="msg assistant">${DEFAULT_GREETING}</div>`;
    chatListEl.innerHTML = '<div class="chat-list-empty">Log in to see your saved chats</div>';
    clearProfileUI();
    closeCustomize();

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