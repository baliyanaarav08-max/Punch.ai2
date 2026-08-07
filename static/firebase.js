// ==========================================
// Punch AI - Firebase Configuration
// ==========================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

// Firebase Configuration
const firebaseConfig = {
    apiKey: "AIzaSyCCCR0uImdGlEnzhbcY5pJZzCNN9rORCLA",
    authDomain: "punch-ai-17e4e.firebaseapp.com",
    projectId: "punch-ai-17e4e",
    storageBucket: "punch-ai-17e4e.appspot.com",
    messagingSenderId: "638975465606",
    appId: "1:638975465606:web:20610317d8a04b06fe9907",
    measurementId: "G-QFCXP9CLBC"
};

// Initialize Firebase only ONCE
const app = initializeApp(firebaseConfig);

// Services
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// Export
export { app, auth, db, storage };