// static/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Replace these placeholders with your actual keys from Firebase Console
const firebaseConfig = {
  apiKey: "AIzaSyCCCR0uImdGlEnzhbcY5pJZzCNN9rORCLA",
  authDomain: "punch-ai-17e4e.firebaseapp.com",
  projectId: "punch-ai-17e4e",
  storageBucket: "punch-ai-17e4e.firebasestorage.ap",
  messagingSenderId: "638975465606",
  appId: "1:638975465606:web:20610317d8a04b06fe9907"
  measurementId: "G-QFCXP9CLBC"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Export instances to be used by auth.js
export const auth = getAuth(app);
export const db = getFirestore(app);