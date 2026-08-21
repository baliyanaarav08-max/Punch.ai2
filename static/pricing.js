// ==========================================
// Punch AI - Pricing / Upgrade + Renewal flow (Cashfree)
// ==========================================
import { auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
// Cashfree's SDK is loaded as a plain <script> tag in pricing.html (it's a
// UMD build, not an ES module), which exposes a global `Cashfree(...)`
// function — see getCashfree() below.

const upgradeBtn = document.getElementById("upgrade-btn");
const pricingNote = document.getElementById("pricing-note");
const subscriptionStatusEl = document.getElementById("subscription-status");

let currentUser = null;
let cashfreeInstance = null;
let cashfreeMode = "sandbox";
let isRenewalFlow = false; // true once we know the user is an active Pro member renewing early

function setNote(text, type) {
  pricingNote.textContent = text || "";
  pricingNote.className = "pricing-note" + (type ? ` ${type}` : "");
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return iso;
  }
}

// Reads plan status through /api/subscription_status (server-side, expiry-
// aware — see get_user_plan_and_usage in app.py) rather than reading the
// Firestore doc directly, so a lapsed subscription is never shown as
// active just because the client hasn't re-checked yet.
async function refreshSubscriptionStatus() {
  if (!currentUser || !subscriptionStatusEl) return;
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch("/api/subscription_status", { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();

    if (data.plan === "pro") {
      isRenewalFlow = true;
      upgradeBtn.textContent = "Renew Pro";
      upgradeBtn.disabled = false;
      upgradeBtn.classList.remove("pricing-cta-ghost");

      const daysLeft = data.daysLeft;
      subscriptionStatusEl.classList.remove("hidden");
      if (daysLeft !== null && daysLeft <= 5) {
        subscriptionStatusEl.classList.add("expiring-soon");
        subscriptionStatusEl.textContent =
          daysLeft <= 0
            ? "Your Pro period ends today — renew to keep unlimited access."
            : `Pro renews in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (${formatDate(data.expiresAt)}). Renew early and it stacks onto your current period.`;
      } else {
        subscriptionStatusEl.classList.remove("expiring-soon");
        subscriptionStatusEl.textContent = data.expiresAt
          ? `You're on Punch Pro — renews on ${formatDate(data.expiresAt)}.`
          : "You're on Punch Pro.";
      }
    } else {
      isRenewalFlow = false;
      upgradeBtn.textContent = "Upgrade to Pro";
      upgradeBtn.disabled = false;
      upgradeBtn.classList.remove("pricing-cta-ghost");
      subscriptionStatusEl.classList.add("hidden");
    }
  } catch (err) {
    console.error("Failed to load subscription status:", err);
  }
}

function getCashfree(mode) {
  // The SDK is tied to a mode (sandbox/production) at init time, so if the
  // server ever reports a different mode than what we last initialized,
  // re-initialize it.
  if (!cashfreeInstance || cashfreeMode !== mode) {
    cashfreeMode = mode;
    cashfreeInstance = Cashfree({ mode });
  }
  return cashfreeInstance;
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) return;
  refreshSubscriptionStatus();
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
  setNote(isRenewalFlow ? "Starting renewal..." : "Starting checkout...");

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

    setNote(
      isRenewalFlow
        ? "Renewed! Your Pro period has been extended. Taking you back to chat..."
        : "You're now on Punch Pro! Taking you back to chat...",
      "success",
    );
    await refreshSubscriptionStatus();
    setTimeout(() => {
      window.location.href = "/";
    }, 1600);
  } catch (err) {
    console.error(err);
    setNote(err.message, "error");
    upgradeBtn.disabled = false;
  }
});