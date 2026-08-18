// ==========================================
// Punch AI - Pricing / Upgrade flow (Cashfree)
// ==========================================
import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { load as loadCashfree } from "https://sdk.cashfree.com/js/v3/cashfree.js";

const upgradeBtn = document.getElementById("upgrade-btn");
const pricingNote = document.getElementById("pricing-note");

let currentUser = null;
let cashfreeInstance = null;
let cashfreeMode = "sandbox";

function setNote(text, type) {
  pricingNote.textContent = text || "";
  pricingNote.className = "pricing-note" + (type ? ` ${type}` : "");
}

function markAsAlreadyPro() {
  upgradeBtn.textContent = "You're on Punch Pro";
  upgradeBtn.disabled = true;
  upgradeBtn.classList.add("pricing-cta-ghost");
  setNote("Thanks for being a Punch Pro member!", "success");
}

async function getCashfree(mode) {
  // The SDK is tied to a mode (sandbox/production) at load time, so if the
  // server ever reports a different mode than what we last loaded, reload it.
  if (!cashfreeInstance || cashfreeMode !== mode) {
    cashfreeMode = mode;
    cashfreeInstance = await loadCashfree({ mode });
  }
  return cashfreeInstance;
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) return;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const plan = snap.exists() ? snap.data().plan : null;
    if (plan === "pro") markAsAlreadyPro();
  } catch (err) {
    console.error("Failed to check plan:", err);
  }
});

upgradeBtn.addEventListener("click", async () => {
  if (!currentUser) {
    setNote("Please log in first — taking you to the home page...", "error");
    setTimeout(() => {
      window.location.href = "/";
    }, 1200);
    return;
  }

  upgradeBtn.disabled = true;
  setNote("Starting checkout...");

  let idToken;
  try {
    idToken = await currentUser.getIdToken();

    const orderRes = await fetch("/api/create_order", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    });
    const order = await orderRes.json();
    if (!orderRes.ok) throw new Error(order.error || "Could not start checkout");
    if (!order.payment_session_id) throw new Error("Could not start checkout");

    const cashfree = await getCashfree(order.mode || "sandbox");

    setNote("Opening secure checkout...");
    const result = await cashfree.checkout({
      paymentSessionId: order.payment_session_id,
      redirectTarget: "_modal",
    });

    if (result && result.error) {
      // User closed the checkout modal, or it failed outright — no charge.
      upgradeBtn.disabled = false;
      setNote("Checkout closed — no charge was made.");
      return;
    }

    setNote("Verifying payment...");
    const verifyRes = await fetch("/api/verify_payment", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ order_id: order.order_id }),
    });
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok || !verifyData.success) {
      throw new Error(verifyData.error || "Payment verification failed");
    }

    markAsAlreadyPro();
    setNote("You're now on Punch Pro! Taking you back to chat...", "success");
    setTimeout(() => {
      window.location.href = "/";
    }, 1600);
  } catch (err) {
    console.error(err);
    setNote(err.message, "error");
    upgradeBtn.disabled = false;
  }
});