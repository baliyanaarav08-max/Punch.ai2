import { auth, db } from "./firebase.js";
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