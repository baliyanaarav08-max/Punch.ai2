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

const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024; // 18 MB, matches the server-side cap
const MAX_ATTACHMENTS_PER_MESSAGE = 4;
let pendingAttachments = []; // [{ file, isImage, mimeType, name, localPreviewUrl }, ...]

// Kept as a getter-style alias so any older single-attachment call site
// (there are none left, but future code may assume one) still degrades
// gracefully to "the first queued file".
function clearPendingAttachment() {
  pendingAttachments.forEach((a) => {
    if (a.localPreviewUrl) URL.revokeObjectURL(a.localPreviewUrl);
  });
  pendingAttachments = [];
  renderAttachPreview();
}

function renderAttachPreview() {
  chatAttachPreview.innerHTML = "";
  if (pendingAttachments.length === 0) {
    chatAttachPreview.classList.add("hidden");
    chatAttachBtn.classList.remove("has-attachment");
    return;
  }
  pendingAttachments.forEach((att, idx) => {
    const chip = document.createElement("div");
    chip.className = "chat-attach-chip";

    if (att.isImage && att.localPreviewUrl) {
      const thumb = document.createElement("img");
      thumb.className = "chat-attach-thumb";
      thumb.src = att.localPreviewUrl;
      thumb.alt = "";
      chip.appendChild(thumb);
    }

    const name = document.createElement("span");
    name.className = "chat-attach-name";
    const prefix = att.isVideo ? "🎬 " : att.mimeType === "application/pdf" ? "📄 " : "";
    name.textContent = prefix + att.name;
    chip.appendChild(name);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chat-attach-remove";
    remove.setAttribute("aria-label", "Remove attachment");
    remove.textContent = "\u00d7";
    remove.addEventListener("click", () => {
      if (att.localPreviewUrl) URL.revokeObjectURL(att.localPreviewUrl);
      pendingAttachments.splice(idx, 1);
      renderAttachPreview();
    });
    chip.appendChild(remove);

    chatAttachPreview.appendChild(chip);
  });
  chatAttachPreview.classList.remove("hidden");
  chatAttachBtn.classList.add("has-attachment");
}

chatAttachBtn.addEventListener("click", () => {
  chatAttachInput.click();
});

// Shared by the file picker, drag-and-drop, and clipboard paste, so every
// entry point goes through the same size check / preview / queue setup.
// Accepts a single File (drag-drop) or a FileList/array (picker, paste).
function handleSelectedFile(fileOrFiles) {
  const files = fileOrFiles
    ? fileOrFiles instanceof FileList
      ? Array.from(fileOrFiles)
      : Array.isArray(fileOrFiles)
        ? fileOrFiles
        : [fileOrFiles]
    : [];
  if (files.length === 0) return;

  for (const file of files) {
    if (pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      alert(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`);
      break;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      alert(`"${file.name}" is too large — please use something under 18 MB.`);
      continue;
    }
    const mimeType = file.type || "application/octet-stream";
    const isImage = mimeType.startsWith("image/");
    const isVideo = mimeType.startsWith("video/");
    // These are the types the backend actually reads directly (Gemini's
    // native image/video/PDF understanding) — everything else is just
    // referenced by filename, so there's no point base64-encoding it.
    const sendFullData = isImage || isVideo || mimeType === "application/pdf";
    pendingAttachments.push({
      file,
      isImage,
      isVideo,
      sendFullData,
      mimeType,
      name: file.name,
      localPreviewUrl: isImage || isVideo ? URL.createObjectURL(file) : null,
    });
  }
  renderAttachPreview();
}

chatAttachInput.addEventListener("change", () => {
  handleSelectedFile(chatAttachInput.files);
  chatAttachInput.value = "";
});

// ---- Paste-to-attach: Ctrl/Cmd+V an image straight from the clipboard ----
chatInput.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) {
    handleSelectedFile(files);
  }
});

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

  const files = e.dataTransfer.files;
  if (!files || files.length === 0) return;

  handleSelectedFile(files);

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
const customizeToneWrap = document.getElementById("customize-tone");

const DEFAULT_TONE = "friendly";
let selectedTone = DEFAULT_TONE;

if (customizeToneWrap) {
  customizeToneWrap.querySelectorAll(".tone-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedTone = btn.dataset.tone;
      customizeToneWrap
        .querySelectorAll(".tone-option")
        .forEach((b) => b.classList.toggle("selected", b === btn));
    });
  });
}

function applyToneSelection(tone) {
  selectedTone = tone || DEFAULT_TONE;
  if (!customizeToneWrap) return;
  customizeToneWrap.querySelectorAll(".tone-option").forEach((b) => {
    b.classList.toggle("selected", b.dataset.tone === selectedTone);
  });
}

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
  applyToneSelection(userProfile.tone || DEFAULT_TONE);
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
  applyToneSelection(DEFAULT_TONE);
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
    tone: selectedTone,
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
  const { name, hobby, wantToBecome, goal, about, tone } = userProfile;
  return { name, hobby, wantToBecome, goal, about, tone: tone || DEFAULT_TONE };
}

// ==========================================
// Punch AI - Multiple Named Chats (Firestore)
// ==========================================

const chatListEl = document.getElementById("chat-list");
const chatSearchInput = document.getElementById("chat-search-input");

let currentUser = null;
let currentChatId = null;
let unsubscribeChatList = null;
let allChatsCache = [];
let chatSearchTerm = "";
const DEFAULT_GREETING =
  "Hey, I'm Punch. Ask me anything — I'll pull in live search results when a question needs current info.";

if (chatSearchInput) {
  chatSearchInput.addEventListener("input", () => {
    chatSearchTerm = chatSearchInput.value;
    applyChatListFilterAndRender();
  });
}

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
  history.forEach((turn, idx) => {
    const sender = turn.role === "model" ? "assistant" : "user";
    addMessage(chatWindow, turn.parts[0].text, sender, null, idx);
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
    // Newer messages store a full "attachments" list; older ones only have
    // the single attachmentURL/Type/Name fields — support both.
    const attachments =
      Array.isArray(m.attachments) && m.attachments.length > 0
        ? m.attachments.map((a) => ({ url: a.url, type: a.type, name: a.name }))
        : m.attachmentURL
          ? [{ url: m.attachmentURL, type: m.attachmentType, name: m.attachmentName }]
          : [];
    displayMessages.push({
      sender: m.role === "model" ? "assistant" : "user",
      text: m.text,
      attachments,
      reaction: m.reaction || null,
      docId: docSnap.id,
    });
  });

  chatWindow.innerHTML = "";
  if (displayMessages.length === 0) {
    addMessage(chatWindow, DEFAULT_GREETING, "assistant");
  } else {
    displayMessages.forEach((m, idx) => {
      const div = addMessage(chatWindow, m.text, m.sender, m.attachments, idx);
      if (m.sender === "assistant") {
        div.dataset.msgDocId = m.docId;
        if (m.reaction) applyReactionUI(div, m.reaction);
      }
    });
  }
}

async function selectChat(chatId) {
  if (!currentUser || chatId === currentChatId) return;
  currentChatId = chatId;
  highlightActiveChat();
  stopSpeaking();
  hideClarifyCard();
  await loadChatMessages(currentUser.uid, chatId);
}

function highlightActiveChat() {
  chatListEl.querySelectorAll(".chat-list-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.chatId === currentChatId);
  });
}

function renderChatList(chats) {
  allChatsCache = chats;
  applyChatListFilterAndRender();
}

function applyChatListFilterAndRender() {
  let chats = allChatsCache;
  const term = chatSearchTerm.trim().toLowerCase();
  if (term) {
    chats = chats.filter((c) => (c.title || "New Chat").toLowerCase().includes(term));
  }
  // Pinned chats float to the top, each group still newest-first.
  const pinned = chats.filter((c) => c.pinned);
  const rest = chats.filter((c) => !c.pinned);
  const ordered = [...pinned, ...rest];

  if (ordered.length === 0) {
    chatListEl.innerHTML = `<div class="chat-list-empty">${
      term ? "No chats match your search." : "No chats yet — start one!"
    }</div>`;
    return;
  }
  chatListEl.innerHTML = "";
  ordered.forEach((c) => {
    const item = document.createElement("div");
    item.className = "chat-list-item";
    item.dataset.chatId = c.id;

    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "chat-list-item-pin" + (c.pinned ? " pinned" : "");
    pinBtn.title = c.pinned ? "Unpin chat" : "Pin chat";
    pinBtn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2c-1.1 0-2 .9-2 2v6.28L7.34 13H7v2h4v6l1 1 1-1v-6h4v-2h-.34L14 10.28V4c0-1.1-.9-2-2-2z"/></svg>';
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePinChat(c.id, !c.pinned);
    });

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

    item.appendChild(pinBtn);
    item.appendChild(title);
    item.appendChild(del);
    item.addEventListener("click", () => selectChat(c.id));
    chatListEl.appendChild(item);
  });
  highlightActiveChat();
}

async function togglePinChat(chatId, pinned) {
  if (!currentUser) return;
  try {
    await updateDoc(doc(db, "users", currentUser.uid, "chats", chatId), { pinned });
  } catch (err) {
    console.error("Failed to pin/unpin chat:", err);
  }
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

async function saveMessagePair(uid, chatId, userText, replyText, isFirstMessage, attachmentInfos) {
  const list = Array.isArray(attachmentInfos) ? attachmentInfos.filter((a) => a && a.url) : [];
  const userDoc = {
    role: "user",
    text: userText,
    createdAt: serverTimestamp(),
  };
  if (list.length > 0) {
    // Keep the old single-attachment fields for backward compatibility with
    // any existing reads, plus a full list for multi-attachment messages.
    userDoc.attachmentURL = list[0].url;
    userDoc.attachmentType = list[0].isVideo ? "video" : list[0].isImage ? "image" : "file";
    userDoc.attachmentName = list[0].name;
    userDoc.attachments = list.map((a) => ({
      url: a.url,
      type: a.isVideo ? "video" : a.isImage ? "image" : "file",
      name: a.name,
    }));
  }
  await addDoc(messagesCol(uid, chatId), userDoc);
  const modelDocRef = await addDoc(messagesCol(uid, chatId), {
    role: "model",
    text: replyText,
    createdAt: serverTimestamp(),
  });

  const chatRef = doc(db, "users", uid, "chats", chatId);
  const update = { updatedAt: serverTimestamp() };
  if (isFirstMessage) {
    // Auto-title the chat from the first user message, like ChatGPT does.
    const titleSource = userText || (list[0] ? list[0].name : "New Chat");
    update.title = titleSource.length > 42 ? titleSource.slice(0, 42) + "…" : titleSource;
  }
  await updateDoc(chatRef, update);
  return modelDocRef.id; // so the caller can attach it to the rendered bubble for reactions
}

// ==========================================
// Punch AI - Rich text rendering (markdown + code highlighting)
// ==========================================

// Renders raw AI text as sanitized markdown with syntax-highlighted code
// blocks, and adds a small "Copy" button to each code block.
function renderRichText(el, rawText) {
  if (window.marked && window.DOMPurify) {
    const html = marked.parse(rawText, { breaks: true });
    el.innerHTML = DOMPurify.sanitize(html);
  } else {
    // Libraries failed to load (e.g. offline) — fall back to plain text
    // instead of leaving the message blank.
    el.textContent = rawText;
    return;
  }
  if (window.hljs) {
    el.querySelectorAll("pre code").forEach((block) => {
      hljs.highlightElement(block);
      const pre = block.parentElement;
      if (pre.querySelector(".code-copy-btn")) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "code-copy-btn";
      btn.textContent = "Copy";
      btn.addEventListener("click", () => {
        navigator.clipboard.writeText(block.textContent).then(() => {
          btn.textContent = "Copied!";
          setTimeout(() => (btn.textContent = "Copy"), 1400);
        });
      });
      pre.style.position = "relative";
      pre.appendChild(btn);
    });
  }
}

// ==========================================
// Punch AI - Message action toolbar (copy / regenerate / edit / read aloud)
// ==========================================

let speakingBtn = null; // the currently-active read-aloud button, if any

function stopSpeaking() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (speakingBtn) {
    speakingBtn.classList.remove("speaking");
    speakingBtn.title = "Read aloud";
    speakingBtn = null;
  }
}

function toggleReadAloud(btn, text) {
  if (!("speechSynthesis" in window)) return;
  if (speakingBtn === btn) {
    stopSpeaking();
    return;
  }
  stopSpeaking();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.onend = () => stopSpeaking();
  utterance.onerror = () => stopSpeaking();
  speakingBtn = btn;
  btn.classList.add("speaking");
  btn.title = "Stop reading";
  speechSynthesis.speak(utterance);
}

function iconBtn(className, title, svgPath) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `msg-action-btn ${className}`;
  btn.title = title;
  btn.innerHTML = svgPath;
  return btn;
}

const ICON_COPY =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_REGENERATE =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
const ICON_EDIT =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const ICON_SPEAK =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
const ICON_THUMBS_UP =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>';
const ICON_THUMBS_DOWN =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/></svg>';

// Applies the visual "pressed" state for a stored/selected reaction to a
// rendered assistant message bubble's toolbar. `reaction` is "up", "down",
// or null/undefined to clear both.
function applyReactionUI(msgDiv, reaction) {
  const upBtn = msgDiv.querySelector(".msg-action-btn.reaction.up");
  const downBtn = msgDiv.querySelector(".msg-action-btn.reaction.down");
  if (upBtn) upBtn.classList.toggle("active", reaction === "up");
  if (downBtn) downBtn.classList.toggle("active", reaction === "down");
}

// Persists a thumbs up/down on an assistant message. Clicking an already-
// active reaction clears it. Silently a no-op if the message was never
// saved to Firestore (e.g. logged-out session) — the UI still updates.
async function setMessageReaction(msgDiv, historyIndex, reaction) {
  const current = msgDiv.dataset.reaction || null;
  const next = current === reaction ? null : reaction;
  msgDiv.dataset.reaction = next || "";
  applyReactionUI(msgDiv, next);

  const docId = msgDiv.dataset.msgDocId;
  if (currentUser && currentChatId && docId) {
    try {
      await updateDoc(doc(db, "users", currentUser.uid, "chats", currentChatId, "messages", docId), {
        reaction: next,
      });
    } catch (err) {
      console.error("Failed to save reaction:", err);
    }
  }
}

function buildMessageToolbar(sender, rawText, historyIndex) {
  const bar = document.createElement("div");
  bar.className = "msg-actions";

  const copyBtn = iconBtn("copy", "Copy", ICON_COPY);
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(rawText).then(() => {
      copyBtn.title = "Copied!";
      setTimeout(() => (copyBtn.title = "Copy"), 1400);
    });
  });
  bar.appendChild(copyBtn);

  if (sender === "assistant") {
    const speakBtn = iconBtn("speak", "Read aloud", ICON_SPEAK);
    speakBtn.addEventListener("click", () => toggleReadAloud(speakBtn, rawText));
    bar.appendChild(speakBtn);

    const upBtn = iconBtn("reaction up", "Good response", ICON_THUMBS_UP);
    const downBtn = iconBtn("reaction down", "Bad response", ICON_THUMBS_DOWN);
    upBtn.addEventListener("click", () => setMessageReaction(bar.closest(".msg"), historyIndex, "up"));
    downBtn.addEventListener("click", () => setMessageReaction(bar.closest(".msg"), historyIndex, "down"));
    bar.appendChild(upBtn);
    bar.appendChild(downBtn);

    if (historyIndex != null) {
      const regenBtn = iconBtn("regenerate", "Regenerate", ICON_REGENERATE);
      regenBtn.addEventListener("click", () => regenerateMessage(historyIndex));
      bar.appendChild(regenBtn);
    }
  } else if (sender === "user" && historyIndex != null) {
    const editBtn = iconBtn("edit", "Edit & resend", ICON_EDIT);
    editBtn.addEventListener("click", (e) => startEditMessage(e.target.closest(".msg"), historyIndex, rawText));
    bar.appendChild(editBtn);
  }

  return bar;
}

function addMessage(container, message, sender, attachment, historyIndex) {
  const div = document.createElement("div");
  div.className = `msg ${sender}`;
  if (historyIndex != null) div.dataset.historyIndex = String(historyIndex);

  // Accept a single attachment object (older call sites) or a list of them
  // (multi-attachment messages) — normalize to a list either way.
  const attachmentList = !attachment ? [] : Array.isArray(attachment) ? attachment : [attachment];

  attachmentList.forEach((att) => {
    if (!att || (!att.url && !att.name)) return;
    if ((att.type === "image" || att.isImage) && att.url) {
      const img = document.createElement("img");
      img.className = "msg-attachment-img";
      img.src = att.url;
      img.alt = att.name || "Attached image";
      div.appendChild(img);
    } else if ((att.type === "video" || att.isVideo) && att.url) {
      const video = document.createElement("video");
      video.className = "msg-attachment-video";
      video.src = att.url;
      video.controls = true;
      div.appendChild(video);
    } else if (att.name) {
      const chip = document.createElement("div");
      chip.className = "msg-attachment-file";
      chip.textContent = `📎 ${att.name}`;
      div.appendChild(chip);
    }
  });

  if (message) {
    const textNode = document.createElement("div");
    textNode.className = "msg-text";
    if (sender === "assistant") {
      renderRichText(textNode, message);
    } else {
      textNode.textContent = message;
    }
    div.appendChild(textNode);
  }

  if (sender === "assistant" || sender === "user") {
    div.appendChild(buildMessageToolbar(sender, message, historyIndex));
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

// Removes every rendered message whose history index is >= fromIndex —
// used by regenerate/edit to drop the stale tail before resending.
function removeMessagesFromIndex(fromIndex) {
  chatWindow.querySelectorAll("[data-history-index]").forEach((el) => {
    if (Number(el.dataset.historyIndex) >= fromIndex) el.remove();
  });
}

function startEditMessage(msgEl, historyIndex, rawText) {
  if (!msgEl || msgEl.querySelector(".msg-edit-area")) return;
  const textEl = msgEl.querySelector(".msg-text");
  if (!textEl) return;

  const original = textEl.textContent;
  textEl.classList.add("hidden");

  const wrap = document.createElement("div");
  wrap.className = "msg-edit-area";

  const textarea = document.createElement("textarea");
  textarea.className = "msg-edit-textarea";
  textarea.value = original;

  const actions = document.createElement("div");
  actions.className = "msg-edit-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "msg-edit-save";
  saveBtn.textContent = "Save & resend";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "msg-edit-cancel";
  cancelBtn.textContent = "Cancel";

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  wrap.appendChild(textarea);
  wrap.appendChild(actions);
  msgEl.insertBefore(wrap, msgEl.querySelector(".msg-actions"));
  textarea.focus();

  cancelBtn.addEventListener("click", () => {
    wrap.remove();
    textEl.classList.remove("hidden");
  });

  saveBtn.addEventListener("click", () => {
    const newText = textarea.value.trim();
    if (!newText) return;
    wrap.remove();
    editAndResend(historyIndex, newText);
  });
}

async function editAndResend(historyIndex, newText) {
  hideClarifyCard();
  const keepCount = historyIndex;
  chatHistory = chatHistory.slice(0, keepCount);
  removeMessagesFromIndex(historyIndex);
  if (currentUser && currentChatId) {
    truncateFirestoreMessages(currentUser.uid, currentChatId, keepCount).catch((err) =>
      console.error("Failed to truncate saved chat:", err),
    );
  }
  await sendChatMessage(newText, null);
}

async function regenerateMessage(assistantIndex) {
  if (assistantIndex < 1) return;
  const userTurn = chatHistory[assistantIndex - 1];
  if (!userTurn || userTurn.role !== "user") return;
  const messageText = userTurn.parts[0].text;

  hideClarifyCard();
  const keepCount = assistantIndex - 1;
  chatHistory = chatHistory.slice(0, keepCount);
  removeMessagesFromIndex(keepCount);
  if (currentUser && currentChatId) {
    truncateFirestoreMessages(currentUser.uid, currentChatId, keepCount).catch((err) =>
      console.error("Failed to truncate saved chat:", err),
    );
  }
  await sendChatMessage(messageText, null);
}

// Deletes every saved message doc past `keepCount` turns, so Firestore
// stays in sync after a regenerate or edit truncates the local history.
async function truncateFirestoreMessages(uid, chatId, keepCount) {
  const q = query(messagesCol(uid, chatId), orderBy("createdAt", "asc"));
  const snap = await getDocs(q);
  const toDelete = snap.docs.slice(keepCount);
  await Promise.all(toDelete.map((d) => deleteDoc(d.ref)));
}

// Types the assistant's reply out word-by-word instead of dumping it
// instantly, matching how the chat product should feel. Renders as
// sanitized markdown once the full text has streamed in.
function typeMessage(container, fullText, historyIndex, speedMs = 18) {
  const div = document.createElement("div");
  div.className = "msg assistant";
  if (historyIndex != null) div.dataset.historyIndex = String(historyIndex);
  const textNode = document.createElement("div");
  textNode.className = "msg-text";
  const cursor = document.createElement("span");
  cursor.className = "typing-cursor";
  div.appendChild(textNode);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  const words = fullText.split(" ");
  let i = 0;

  return new Promise((resolve) => {
    textNode.appendChild(cursor);

    function step() {
      if (i < words.length) {
        const chunk = (i === 0 ? "" : " ") + words[i];
        cursor.insertAdjacentText("beforebegin", chunk);
        i++;
        container.scrollTop = container.scrollHeight;
        setTimeout(step, speedMs);
      } else {
        cursor.remove();
        renderRichText(textNode, fullText);
        div.appendChild(buildMessageToolbar("assistant", fullText, historyIndex));
        container.scrollTop = container.scrollHeight;
        resolve(div);
      }
    }
    step();
  });
}

// ==========================================
// Punch AI - "Working on it" status indicator
// ==========================================
// Drops a small shimmering status line into a chat window while a request
// is in flight, cycling through a few varied phrases instead of a single
// static "Loading..." — call .stop() the moment the real reply is ready
// (or on error) to remove it. Safe to call .stop() more than once.
function showStatusIndicator(container, phrases) {
  const div = document.createElement("div");
  div.className = "msg assistant status-msg";
  const textSpan = document.createElement("span");
  textSpan.className = "status-text";
  textSpan.textContent = phrases[0];
  div.appendChild(textSpan);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  let i = 0;
  let stopped = false;
  const timer = setInterval(() => {
    textSpan.classList.add("status-fade");
    setTimeout(() => {
      if (stopped) return;
      i = (i + 1) % phrases.length;
      textSpan.textContent = phrases[i];
      textSpan.classList.remove("status-fade");
      container.scrollTop = container.scrollHeight;
    }, 200);
  }, 2000);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      div.remove();
    },
  };
}

const CHAT_STATUS_PHRASES = [
  "Reading your message...",
  "Thinking it through...",
  "Working out the best answer...",
  "Piecing the reply together...",
  "Almost done...",
];

async function sendChatMessage(message, attachmentOrList) {
  hideClarifyCard();
  chatInput.disabled = true;
  chatAttachBtn.disabled = true;
  const isFirstMessage = chatHistory.length === 0;

  // Accept either a single attachment object (older call sites, e.g. the
  // clarify-card options) or an array of them (multi-attachment send).
  const attachments = !attachmentOrList
    ? []
    : Array.isArray(attachmentOrList)
      ? attachmentOrList
      : [attachmentOrList];

  const userIndex = chatHistory.length;
  // The bubble shows every attached file; only the first gets an inline
  // image preview to keep the bubble compact, the rest render as chips.
  addMessage(
    chatWindow,
    message,
    "user",
    attachments.length > 0
      ? attachments.map((a) => ({ url: a.localPreviewUrl, isImage: a.isImage, isVideo: a.isVideo, name: a.name }))
      : null,
    userIndex,
  );

  const statusHandle = showStatusIndicator(chatWindow, CHAT_STATUS_PHRASES);

  try {
    // Images, videos, and PDFs are sent inline as base64 so Gemini can read
    // them directly; other file types are sent as name/mimeType only.
    const attachmentPayloads = await Promise.all(
      attachments.map(async (att) => ({
        mimeType: att.mimeType,
        name: att.name,
        data: att.sendFullData ? await fileToBase64(att.file) : null,
      })),
    );

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        history: chatHistory,
        profile: profileForApi(),
        attachment: attachmentPayloads[0] || null, // back-compat single field
        attachments: attachmentPayloads,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Server Error");
    }

    // Keep the API-facing history text-only — attached files are only
    // needed for the turn they were sent on, not replayed into future
    // requests.
    const attachmentNames = attachments.map((a) => a.name).join(", ");
    const historyText = attachments.length
      ? `${message}${message ? "\n\n" : ""}[Attached: ${attachmentNames}]`
      : message;

    chatHistory.push({ role: "user", parts: [{ text: historyText }] });

    statusHandle.stop();

    if (data.clarify) {
      // The AI wants more detail before answering — save its question as
      // the "reply" for this turn so context/history stay consistent, then
      // show the floating clarify card instead of a normal typed answer.
      chatHistory.push({ role: "model", parts: [{ text: data.question }] });
      showClarifyCard(data.question, data.options || []);

      if (currentUser && currentChatId) {
        saveMessagePair(currentUser.uid, currentChatId, message, data.question, isFirstMessage, null).catch(
          (err) => console.error("Failed to save chat:", err),
        );
      }
      return;
    }

    chatHistory.push({ role: "model", parts: [{ text: data.reply }] });

    const assistantIndex = userIndex + 1;
    const assistantDiv = await typeMessage(chatWindow, data.reply, assistantIndex);

    if (currentUser && currentChatId) {
      (async () => {
        const attachmentInfos = [];
        for (const att of attachments) {
          try {
            const storedUrl = await uploadAttachmentToStorage(currentUser.uid, currentChatId, att.file);
            attachmentInfos.push({ url: storedUrl, isImage: att.isImage, isVideo: att.isVideo, name: att.name });
          } catch (err) {
            console.error("Attachment upload to Storage failed:", err);
          }
        }
        const modelDocId = await saveMessagePair(
          currentUser.uid,
          currentChatId,
          message,
          data.reply,
          isFirstMessage,
          attachmentInfos,
        );
        // So the thumbs up/down buttons on this bubble can write straight
        // to the right Firestore doc without a reload.
        if (assistantDiv && modelDocId) assistantDiv.dataset.msgDocId = modelDocId;
      })().catch((err) => console.error("Failed to save chat:", err));
    }
  } catch (error) {
    console.error(error);

    statusHandle.stop();
    addMessage(chatWindow, "⚠️ Unable to contact the server.", "system");
  } finally {
    chatInput.disabled = false;
    chatAttachBtn.disabled = false;
    chatInput.focus();
    // Don't revoke the local preview URLs here — the bubble in chatWindow
    // still uses them for this session; they're released on page reload.
    pendingAttachments = [];
    renderAttachPreview();
  }
}

// ==========================================
// Punch AI - Clarifying question card
// ==========================================
const clarifyCard = document.getElementById("clarify-card");
const clarifyQuestionEl = document.getElementById("clarify-question");
const clarifyOptionsEl = document.getElementById("clarify-options");

function showClarifyCard(question, options) {
  clarifyQuestionEl.textContent = question;
  clarifyOptionsEl.innerHTML = "";
  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "clarify-option-btn";
    btn.textContent = opt;
    btn.addEventListener("click", () => {
      hideClarifyCard();
      sendChatMessage(opt, null);
    });
    clarifyOptionsEl.appendChild(btn);
  });
  clarifyCard.classList.remove("hidden");
}

function hideClarifyCard() {
  clarifyCard.classList.add("hidden");
}

const newChatBtn = document.getElementById("new-chat-btn");
if (newChatBtn) {
  newChatBtn.addEventListener("click", () => {
    clearPendingAttachment();
    hideClarifyCard();
    createNewChat();
  });
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();

  const message = chatInput.value.trim();
  const attachments = pendingAttachments;

  if (message === "" && attachments.length === 0) return;

  chatInput.value = "";

  sendChatMessage(message, attachments);
});

// ==========================================
// Punch AI - Keyboard shortcuts
// ==========================================
// Cmd/Ctrl+K: new chat. "/" : focus the input (unless already typing
// somewhere). Up arrow on an empty input: reopen the last user message
// for editing, matching the ChatGPT-style shortcut people expect.
document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const target = e.target;
  const isTyping =
    target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    clearPendingAttachment();
    hideClarifyCard();
    createNewChat();
    chatInput.focus();
    return;
  }

  if (e.key === "/" && !isTyping) {
    e.preventDefault();
    chatInput.focus();
    return;
  }

  if (e.key === "Escape" && document.activeElement === chatInput) {
    chatInput.blur();
    return;
  }

  if (e.key === "ArrowUp" && target === chatInput && chatInput.value === "") {
    // Find the most recent user message still in the DOM and load it back
    // into the input for a quick edit-and-resend.
    const userBubbles = chatWindow.querySelectorAll(".msg.user[data-history-index]");
    if (userBubbles.length === 0) return;
    const lastBubble = userBubbles[userBubbles.length - 1];
    const textEl = lastBubble.querySelector(".msg-text");
    if (!textEl) return;
    e.preventDefault();
    chatInput.value = textEl.textContent || "";
    chatInput.focus();
    chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
  }
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
const VOICE_STATUS_PHRASES = [
  "Thinking...",
  "Working on it...",
  "Almost ready...",
];

// Cycles voiceStatus through a few short phrases (with the shimmer style
// from .voice-status.thinking) while waiting on the server. Returns a
// function that stops the cycle — safe to call more than once.
function startVoiceStatusCycle() {
  let i = 0;
  let stopped = false;
  voiceStatus.classList.add("thinking");
  voiceStatus.textContent = VOICE_STATUS_PHRASES[0];
  const timer = setInterval(() => {
    i = (i + 1) % VOICE_STATUS_PHRASES.length;
    voiceStatus.textContent = VOICE_STATUS_PHRASES[i];
  }, 1700);

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    voiceStatus.classList.remove("thinking");
  };
}

async function sendVoiceMessage(message) {
  const stopStatusCycle = startVoiceStatusCycle();

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

    stopStatusCycle();

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

    stopStatusCycle();
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
    allChatsCache = [];
    chatSearchTerm = "";
    if (chatSearchInput) chatSearchInput.value = "";
    if (unsubscribeChatList) {
      unsubscribeChatList();
      unsubscribeChatList = null;
    }
    chatWindow.innerHTML = `<div class="msg assistant">${DEFAULT_GREETING}</div>`;
    chatListEl.innerHTML = '<div class="chat-list-empty">Log in to see your saved chats</div>';
    clearProfileUI();
    closeCustomize();
    stopSpeaking();
    hideClarifyCard();

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