// ==========================================
// Punch AI - Chat Module
// ==========================================
import { auth, db, storage } from "./firebase.js";
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

import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
let chatHistory = [];

const chatWindow = document.getElementById("chat-window");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

// ==========================================
// Punch AI - Chat Attachments (images + files)
// ==========================================
const chatAttachInput = document.getElementById("chat-attach-input");
const chatAttachBtn = document.getElementById("chat-attach-btn");
const chatAttachPreview = document.getElementById("chat-attach-preview");
const chatAttachThumb = document.getElementById("chat-attach-thumb");
const chatAttachName = document.getElementById("chat-attach-name");
const chatAttachRemove = document.getElementById("chat-attach-remove");

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB, matches the server-side cap
let pendingAttachment = null; // { file, isImage, mimeType, name, localPreviewUrl }

function clearPendingAttachment() {
  if (pendingAttachment && pendingAttachment.localPreviewUrl) {
    URL.revokeObjectURL(pendingAttachment.localPreviewUrl);
  }
  pendingAttachment = null;
  chatAttachPreview.classList.add("hidden");
  chatAttachThumb.classList.add("hidden");
  chatAttachThumb.src = "";
  chatAttachName.textContent = "";
  chatAttachBtn.classList.remove("has-attachment");
}

chatAttachBtn.addEventListener("click", () => {
  chatAttachInput.click();
});

// Shared by both the file picker and drag-and-drop, so a dropped file goes
// through the exact same size check / preview / pendingAttachment setup.
function handleSelectedFile(file) {
  if (!file) return;

  if (file.size > MAX_ATTACHMENT_BYTES) {
    alert("That file is too large — please use something under 5 MB.");
    return;
  }

  const isImage = file.type.startsWith("image/");
  clearPendingAttachment();
  pendingAttachment = {
    file,
    isImage,
    mimeType: file.type || "application/octet-stream",
    name: file.name,
    localPreviewUrl: isImage ? URL.createObjectURL(file) : null,
  };

  chatAttachName.textContent = file.name;
  if (isImage) {
    chatAttachThumb.src = pendingAttachment.localPreviewUrl;
    chatAttachThumb.classList.remove("hidden");
  } else {
    chatAttachThumb.classList.add("hidden");
  }
  chatAttachPreview.classList.remove("hidden");
  chatAttachBtn.classList.add("has-attachment");
}

chatAttachInput.addEventListener("change", () => {
  const file = chatAttachInput.files[0];
  chatAttachInput.value = "";
  handleSelectedFile(file);
});

chatAttachRemove.addEventListener("click", clearPendingAttachment);

// ==========================================
// Punch AI - Drag & Drop
// ==========================================
const dropOverlay = document.getElementById("drop-overlay");
let dragCounter = 0; // tracks nested dragenter/dragleave firing on child elements

function showDropOverlay() {
  dropOverlay.classList.remove("hidden");
}
function hideDropOverlay() {
  dropOverlay.classList.add("hidden");
  dragCounter = 0;
}

window.addEventListener("dragenter", (e) => {
  // Ignore drags that aren't carrying files (e.g. dragging selected text).
  if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
  e.preventDefault();
  dragCounter++;
  showDropOverlay();
});

window.addEventListener("dragover", (e) => {
  // Required or the browser's default action (opening the file) fires
  // instead of our drop handler.
  if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
  e.preventDefault();
});

window.addEventListener("dragleave", (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) hideDropOverlay();
});

window.addEventListener("drop", (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
  e.preventDefault();
  hideDropOverlay();

  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;

  handleSelectedFile(file);

  // Bring the dropped file into view in the chat card and focus the
  // input so the person can just start typing their prompt about it.
  document.getElementById("chat")?.scrollIntoView({ behavior: "smooth", block: "center" });
  chatInput.focus();
});

// Reads a File as a base64 string (no "data:...;base64," prefix), for
// sending images to the backend for Gemini vision analysis.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Uploads the attachment to Firebase Storage (only when logged in, so it can
// be shown again if the chat is reopened later) and returns its download URL.
async function uploadAttachmentToStorage(uid, chatId, file) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `users/${uid}/chats/${chatId}/attachments/${Date.now()}_${safeName}`;
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, file, { contentType: file.type || undefined });
  return getDownloadURL(fileRef);
}

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
const customizePhotoFile = document.getElementById("customize-photo-file");
const customizePhotoBtn = document.getElementById("customize-photo-btn");
const customizePhotoStatus = document.getElementById("customize-photo-status");
const customizeName = document.getElementById("customize-name");
const customizeHobby = document.getElementById("customize-hobby");
const customizeWant = document.getElementById("customize-want");
const customizeGoal = document.getElementById("customize-goal");
const customizeAbout = document.getElementById("customize-about");
const customizeNote = document.getElementById("customize-note");

const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB
let pendingPhotoURL = ""; // holds the uploaded download URL until Save is pressed

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
  pendingPhotoURL = userProfile.photoURL || "";
  customizeName.value = userProfile.name || "";
  customizeHobby.value = userProfile.hobby || "";
  customizeWant.value = userProfile.wantToBecome || "";
  customizeGoal.value = userProfile.goal || "";
  customizeAbout.value = userProfile.about || "";
  customizePhotoStatus.textContent = "";
  customizePhotoStatus.className = "upload-status";
  applyAvatar(pendingPhotoURL);
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

customizePhotoBtn.addEventListener("click", () => {
  if (!currentUser) return;
  customizePhotoFile.click();
});

customizePhotoFile.addEventListener("change", async () => {
  const file = customizePhotoFile.files[0];
  customizePhotoFile.value = ""; // allow re-selecting the same file later
  if (!file || !currentUser) return;

  if (!file.type.startsWith("image/")) {
    customizePhotoStatus.textContent = "Please choose an image file.";
    customizePhotoStatus.className = "upload-status error";
    return;
  }
  if (file.size > MAX_PHOTO_BYTES) {
    customizePhotoStatus.textContent = "That image is too large — please use one under 5 MB.";
    customizePhotoStatus.className = "upload-status error";
    return;
  }

  // Show an instant local preview while the upload runs.
  const localPreview = URL.createObjectURL(file);
  applyAvatar(localPreview);

  customizePhotoBtn.disabled = true;
  customizePhotoStatus.textContent = "Uploading...";
  customizePhotoStatus.className = "upload-status";

  try {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `users/${currentUser.uid}/profile/avatar.${ext}`;
    const fileRef = storageRef(storage, path);
    await uploadBytes(fileRef, file, { contentType: file.type });
    const url = await getDownloadURL(fileRef);

    pendingPhotoURL = url;
    applyAvatar(url);
    customizePhotoStatus.textContent = "Photo uploaded — press Save to keep it.";
    customizePhotoStatus.className = "upload-status success";
  } catch (err) {
    console.error("Photo upload failed:", err);
    applyAvatar(pendingPhotoURL); // revert preview to last saved photo
    customizePhotoStatus.textContent = "Upload failed — please try again.";
    customizePhotoStatus.className = "upload-status error";
  } finally {
    customizePhotoBtn.disabled = false;
    URL.revokeObjectURL(localPreview);
  }
});

customizeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUser) return;

  const saveBtn = document.getElementById("customize-save");
  saveBtn.disabled = true;

  const newProfile = {
    name: customizeName.value.trim(),
    photoURL: pendingPhotoURL,
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
  const displayMessages = [];
  snap.forEach((docSnap) => {
    const m = docSnap.data();
    chatHistory.push({ role: m.role, parts: [{ text: m.text }] });
    displayMessages.push({
      sender: m.role === "model" ? "assistant" : "user",
      text: m.text,
      attachmentURL: m.attachmentURL || null,
      attachmentType: m.attachmentType || null,
      attachmentName: m.attachmentName || null,
    });
  });

  chatWindow.innerHTML = "";
  if (displayMessages.length === 0) {
    addMessage(chatWindow, DEFAULT_GREETING, "assistant");
  } else {
    displayMessages.forEach((m) => {
      addMessage(chatWindow, m.text, m.sender, {
        url: m.attachmentURL,
        type: m.attachmentType,
        name: m.attachmentName,
      });
    });
  }
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

async function saveMessagePair(uid, chatId, userText, replyText, isFirstMessage, attachmentInfo) {
  const userDoc = {
    role: "user",
    text: userText,
    createdAt: serverTimestamp(),
  };
  if (attachmentInfo && attachmentInfo.url) {
    userDoc.attachmentURL = attachmentInfo.url;
    userDoc.attachmentType = attachmentInfo.isImage ? "image" : "file";
    userDoc.attachmentName = attachmentInfo.name;
  }
  await addDoc(messagesCol(uid, chatId), userDoc);
  await addDoc(messagesCol(uid, chatId), {
    role: "model",
    text: replyText,
    createdAt: serverTimestamp(),
  });

  const chatRef = doc(db, "users", uid, "chats", chatId);
  const update = { updatedAt: serverTimestamp() };
  if (isFirstMessage) {
    // Auto-title the chat from the first user message, like ChatGPT does.
    const titleSource = userText || (attachmentInfo ? attachmentInfo.name : "New Chat");
    update.title = titleSource.length > 42 ? titleSource.slice(0, 42) + "…" : titleSource;
  }
  await updateDoc(chatRef, update);
}

function addMessage(container, message, sender, attachment) {
  const div = document.createElement("div");
  div.className = `msg ${sender}`;

  if (attachment && (attachment.url || attachment.name)) {
    if ((attachment.type === "image" || attachment.isImage) && attachment.url) {
      const img = document.createElement("img");
      img.className = "msg-attachment-img";
      img.src = attachment.url;
      img.alt = attachment.name || "Attached image";
      div.appendChild(img);
    } else if (attachment.name) {
      const chip = document.createElement("div");
      chip.className = "msg-attachment-file";
      chip.textContent = `📎 ${attachment.name}`;
      div.appendChild(chip);
    }
  }

  if (message) {
    const textNode = document.createElement("div");
    textNode.textContent = message;
    div.appendChild(textNode);
  }

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

async function sendChatMessage(message, attachment) {
  chatInput.disabled = true;
  chatAttachBtn.disabled = true;
  const isFirstMessage = chatHistory.length === 0;

  // Snapshot the attachment before clearing the input area, and build a
  // local preview URL immediately so the user's bubble shows the image
  // right away instead of waiting on any network round trip.
  let displayUrl = attachment ? attachment.localPreviewUrl : null;
  addMessage(chatWindow, message, "user", attachment ? { url: displayUrl, isImage: attachment.isImage, name: attachment.name } : null);

  try {
    let attachmentPayload = null;
    let base64Data = null;

    if (attachment) {
      if (attachment.isImage) {
        base64Data = await fileToBase64(attachment.file);
      }
      attachmentPayload = {
        mimeType: attachment.mimeType,
        name: attachment.name,
        data: base64Data, // only present for images — backend ignores it otherwise
      };
    }

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        history: chatHistory,
        profile: profileForApi(),
        attachment: attachmentPayload,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Server Error");
    }

    // Keep the API-facing history text-only — the image is only needed for
    // the turn it was sent on, not replayed into every future request.
    const historyText = attachment
      ? `${message}${message ? "\n\n" : ""}[Attached: ${attachment.name}]`
      : message;

    chatHistory.push({
      role: "user",
      parts: [{ text: historyText }],
    });

    chatHistory.push({
      role: "model",
      parts: [{ text: data.reply }],
    });

    await typeMessage(chatWindow, data.reply);

    if (currentUser && currentChatId) {
      (async () => {
        let attachmentInfo = null;
        if (attachment) {
          try {
            const storedUrl = await uploadAttachmentToStorage(currentUser.uid, currentChatId, attachment.file);
            attachmentInfo = { url: storedUrl, isImage: attachment.isImage, name: attachment.name };
          } catch (err) {
            console.error("Attachment upload to Storage failed:", err);
          }
        }
        return saveMessagePair(currentUser.uid, currentChatId, message, data.reply, isFirstMessage, attachmentInfo);
      })().catch((err) => console.error("Failed to save chat:", err));
    }
  } catch (error) {
    console.error(error);

    addMessage(chatWindow, "⚠️ Unable to contact the server.", "system");
  } finally {
    chatInput.disabled = false;
    chatAttachBtn.disabled = false;
    chatInput.focus();
    // Don't revoke displayUrl here — the bubble in chatWindow still uses it
    // for this session; it'll be released naturally on page reload.
    pendingAttachment = null;
    chatAttachPreview.classList.add("hidden");
    chatAttachThumb.classList.add("hidden");
    chatAttachName.textContent = "";
    chatAttachBtn.classList.remove("has-attachment");
  }
}

const newChatBtn = document.getElementById("new-chat-btn");
if (newChatBtn) {
  newChatBtn.addEventListener("click", () => {
    clearPendingAttachment();
    createNewChat();
  });
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();

  const message = chatInput.value.trim();
  const attachment = pendingAttachment;

  if (message === "" && !attachment) return;

  chatInput.value = "";

  sendChatMessage(message, attachment);
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