import os
import base64
import json
import time
import threading
import io
import re
import secrets
import hashlib
from datetime import datetime, timedelta, timezone

import requests
from flask import Flask, request, jsonify, render_template

try:
    from pypdf import PdfReader
except ImportError:  # pragma: no cover - surfaced clearly at request time instead
    PdfReader = None

try:
    from fpdf import FPDF
except ImportError:  # pragma: no cover - surfaced clearly at request time instead
    FPDF = None

try:
    import firebase_admin
    from firebase_admin import credentials as fb_credentials, auth as fb_auth, firestore as fb_firestore
except ImportError:  # pragma: no cover - surfaced clearly at request time instead
    firebase_admin = None
    fb_auth = None
    fb_firestore = None

app = Flask(__name__)

# --- Gemini (Google AI Studio) ---
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

# --- Groq (backup AI, used only if Gemini fails) ---
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

# --- Cerebras (second backup AI, free, used only if both Gemini and Groq fail) ---
CEREBRAS_API_KEY = os.environ.get("CEREBRAS_API_KEY")
CEREBRAS_MODEL = os.environ.get("CEREBRAS_MODEL", "gpt-oss-120b")
CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions"

# --- SearchAPI.io (real-time Google search) ---
SEARCHAPI_KEY = os.environ.get("SEARCHAPI_KEY")
SEARCHAPI_URL = "https://www.searchapi.io/api/v1/search"

# --- ElevenLabs (voice output) ---
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "OtEfb2LVzIE45wdYe54M")
ELEVENLABS_URL = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"

ASSISTANT_NAME = os.environ.get("ASSISTANT_NAME", "Punch")

# --- Firebase Admin (server-side auth verification + authoritative plan/limit data) ---
# Needed so "free vs Pro" and the daily message cap can't just be spoofed by
# editing the request body in devtools — the server independently looks up
# the real plan from Firestore using a verified Firebase ID token, rather
# than trusting whatever the client claims. Paste the *service account*
# JSON (Firebase Console -> Project Settings -> Service Accounts -> Generate
# new private key) into FIREBASE_SERVICE_ACCOUNT_JSON as a single-line env
# var, or point FIREBASE_SERVICE_ACCOUNT_PATH at a mounted file instead.
_fb_admin_app = None
_fb_db = None
if firebase_admin is not None:
    try:
        service_account_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
        service_account_path = os.environ.get("FIREBASE_SERVICE_ACCOUNT_PATH")
        if service_account_json:
            cred = fb_credentials.Certificate(json.loads(service_account_json))
            _fb_admin_app = firebase_admin.initialize_app(cred)
        elif service_account_path:
            cred = fb_credentials.Certificate(service_account_path)
            _fb_admin_app = firebase_admin.initialize_app(cred)
    except Exception as e:  # pragma: no cover - surfaced clearly at request time instead
        print(f"[Punch] Firebase Admin not initialized: {e}")
if _fb_admin_app is not None:
    _fb_db = fb_firestore.client()

# --- Cashfree (Punch Pro payments) ---
# Cashfree's Orders API is plain REST, so it's called directly with
# `requests` instead of pulling in another SDK. Get your keys from
# Cashfree Dashboard -> Developers -> API Keys (separate keys for the
# Sandbox and Production tabs). Set CASHFREE_ENV to "production" when
# you're ready to take real payments; it defaults to "sandbox" so nothing
# accidentally goes live before it's meant to.
CASHFREE_APP_ID = os.environ.get("CASHFREE_APP_ID")
CASHFREE_SECRET_KEY = os.environ.get("CASHFREE_SECRET_KEY")
CASHFREE_ENV = os.environ.get("CASHFREE_ENV", "sandbox").strip().lower()
CASHFREE_API_VERSION = "2023-08-01"
CASHFREE_BASE_URL = (
    "https://api.cashfree.com/pg"
    if CASHFREE_ENV == "production"
    else "https://sandbox.cashfree.com/pg"
)
PRO_PRICE_INR = int(os.environ.get("CASHFREE_PRO_PRICE_INR", "199"))
CASHFREE_CONFIGURED = bool(CASHFREE_APP_ID and CASHFREE_SECRET_KEY)


def _cashfree_headers():
    return {
        "x-client-id": CASHFREE_APP_ID,
        "x-client-secret": CASHFREE_SECRET_KEY,
        "x-api-version": CASHFREE_API_VERSION,
        "Content-Type": "application/json",
    }


FREE_DAILY_MESSAGE_LIMIT = 20

# --- Resend (transactional email, used for price-drop alerts) ---
# Get a key from resend.com -> API Keys. FROM_EMAIL must be on a domain
# you've verified in Resend; without both set, send_price_drop_email()
# just logs and returns False rather than erroring the whole check.
RESEND_API_KEY = os.environ.get("RESEND_API_KEY")
RESEND_FROM_EMAIL = os.environ.get("RESEND_FROM_EMAIL", f"{ASSISTANT_NAME} <alerts@punch.ai>")


def _get_user_email(uid):
    """Firebase Auth is the source of truth for email, not Firestore, so
    this is a small Admin SDK lookup rather than trusting anything stored
    on the user's own document."""
    if fb_auth is None:
        return None
    try:
        return fb_auth.get_user(uid).email
    except Exception as e:
        print(f"[Punch] Failed to look up email for {uid}: {e}")
        return None


def send_price_drop_email(to_email, product_name, current_price, target_price):
    """Sends a price-drop alert via Resend's REST API. Returns True only on
    a confirmed send, so the caller can decide whether to mark this price
    level as already-alerted. Best-effort: any failure (missing config,
    network error, bad response) just returns False and logs, never raises
    into the check_all request."""
    if not (RESEND_API_KEY and to_email):
        return False
    try:
        resp = requests.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
            json={
                "from": RESEND_FROM_EMAIL,
                "to": [to_email],
                "subject": f"Price drop: {product_name} is now ₹{current_price:,}",
                "html": (
                    f"<p>Good news — <strong>{product_name}</strong> just dropped to "
                    f"<strong>₹{current_price:,}</strong>, at or below your target of "
                    f"₹{target_price:,.0f}.</p>"
                    f"<p><a href='https://punch.ai/tech'>Open Punch Tech Desk</a> to take a look.</p>"
                ),
            },
            timeout=15,
        )
        if resp.status_code >= 400:
            print(f"[Punch] Resend send failed ({resp.status_code}): {resp.text[:300]}")
            return False
        return True
    except requests.RequestException as e:
        print(f"[Punch] Resend send error: {e}")
        return False



def verify_request_uid():
    """Pulls a Firebase ID token from the Authorization: Bearer header and
    verifies it server-side. Returns the uid on success, or None if there's
    no token, it's invalid, or Firebase Admin isn't configured — callers
    should treat None as "anonymous/unverified" and fall back to free-tier,
    unauthenticated behavior rather than erroring out, since large parts of
    Punch (guest mode, etc.) intentionally work without an account."""
    if fb_auth is None:
        return None
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    token = header[7:].strip()
    if not token:
        return None
    try:
        decoded = fb_auth.verify_id_token(token)
        return decoded.get("uid")
    except Exception as e:
        print(f"[Punch] ID token verification failed: {e}")
        return None


def verify_request_token_with_contact():
    """Verifies the Firebase ID token from the Authorization: Bearer header
    and also returns whatever email/phone it carries, so Cashfree's
    (mandatory) customer_details can be prefilled without a separate
    Firestore round trip.

    Returns (uid, email, phone, error) — uid is None on any failure, and
    `error` tells you *why*, since "not logged in", "server misconfigured",
    and "expired session" all need different fixes and used to be
    indistinguishable from the client's point of view:
      - "admin_not_configured": Firebase Admin never initialized server-side
        (FIREBASE_SERVICE_ACCOUNT_JSON/PATH missing or invalid) — this is a
        deploy/config problem, not something the user can fix by logging in.
      - "no_token": no Authorization header was sent at all.
      - "invalid_token": a token was sent but Firebase rejected it (expired,
        malformed, wrong project, clock skew, etc). The real exception is
        printed to the server log so you can see the exact cause there.
    """
    if fb_auth is None:
        return None, None, None, "admin_not_configured"
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None, None, None, "no_token"
    token = header[7:].strip()
    if not token:
        return None, None, None, "no_token"
    try:
        decoded = fb_auth.verify_id_token(token)
    except Exception as e:
        print(f"[Punch] ID token verification failed: {e}")
        return None, None, None, "invalid_token"
    return decoded.get("uid"), decoded.get("email"), decoded.get("phone_number"), None


PRO_SUBSCRIPTION_DAYS = 30


def _parse_dt(value):
    """Firestore gives back a proper datetime for timestamp fields, but this
    stays defensive in case a value ever arrives as something else."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return None


def get_user_plan_and_usage(uid):
    """Authoritative (server-side) lookup of a user's plan, today's message
    count, and any unused referral bonus messages — straight from
    Firestore, never trusted from the client. Returns
    (plan, message_count_today, bonus_messages_remaining).

    Pro is time-boxed: a successful payment sets proExpiresAt ~30 days out
    (see /api/verify_payment). Every plan check compares against that, so a
    lapsed subscription is treated as free immediately — no separate
    "downgrade" job needed. When a lapsed Pro account is spotted, this also
    writes plan back to "free" in Firestore so the rest of the app (e.g. the
    client-side plan reads in tech.js/pricing.js) stays in sync rather than
    only ever being correct through this one function."""
    if _fb_db is None or not uid:
        return "free", 0, 0
    try:
        ref = _fb_db.collection("users").document(uid)
        snap = ref.get()
        data = snap.to_dict() or {}
        plan = data.get("plan") or "free"

        if plan == "pro":
            expires_at = _parse_dt(data.get("proExpiresAt"))
            if expires_at and datetime.now(timezone.utc) > expires_at:
                plan = "free"
                try:
                    ref.set({"plan": "free"}, merge=True)
                except Exception as e:
                    print(f"[Punch] Failed to downgrade expired Pro user {uid}: {e}")

        today = time.strftime("%Y-%m-%d")
        count = data.get("dailyMessageCount") or 0
        if (data.get("dailyMessageDate") or "") != today:
            count = 0
        bonus_remaining = max(0, int(data.get("bonusMessagesRemaining") or 0))
        return plan, count, bonus_remaining
    except Exception as e:
        print(f"[Punch] Failed to read plan/usage for {uid}: {e}")
        return "free", 0, 0


def increment_daily_message_count(uid):
    """Best-effort — a failed write here shouldn't fail the chat request
    that already succeeded, it just means the count might undercount by
    one for this user today."""
    if _fb_db is None or not uid:
        return
    try:
        today = time.strftime("%Y-%m-%d")
        ref = _fb_db.collection("users").document(uid)
        snap = ref.get()
        data = snap.to_dict() or {}
        count = data.get("dailyMessageCount") or 0
        if (data.get("dailyMessageDate") or "") != today:
            count = 0
        ref.set({"dailyMessageCount": count + 1, "dailyMessageDate": today}, merge=True)
    except Exception as e:
        print(f"[Punch] Failed to increment daily count for {uid}: {e}")


def consume_bonus_message(uid):
    """Spends one referral bonus message. Best-effort like the daily
    counter above — worst case on a write failure is the user gets one
    extra free message, which isn't worth failing the request over."""
    if _fb_db is None or not uid:
        return
    try:
        ref = _fb_db.collection("users").document(uid)
        snap = ref.get()
        data = snap.to_dict() or {}
        remaining = max(0, int(data.get("bonusMessagesRemaining") or 0))
        if remaining > 0:
            ref.set({"bonusMessagesRemaining": remaining - 1}, merge=True)
    except Exception as e:
        print(f"[Punch] Failed to consume bonus message for {uid}: {e}")


# --- Referral rewards ---
REFERRAL_BONUS_MESSAGES = 10


def _generate_referral_code():
    # 8 hex chars keeps codes short enough to read aloud/type, while the
    # dedicated referral_codes collection (checked for collisions below)
    # makes a same-code collision a non-issue even for a large user base.
    return secrets.token_hex(4).upper()


@app.route("/api/referral/code", methods=["GET"])
def referral_code():
    """Returns the caller's own referral code, generating and persisting
    one on first request. Codes live in their own top-level collection
    (code -> uid) so redeeming one is a single cheap document lookup
    instead of a query across all users."""
    uid = verify_request_uid()
    if not uid:
        return jsonify({"error": "Please log in to get your referral link."}), 401
    if _fb_db is None:
        return jsonify({"error": "This feature isn't configured on this server yet."}), 500

    user_ref = _fb_db.collection("users").document(uid)
    data = user_ref.get().to_dict() or {}
    code = data.get("referralCode")
    if not code:
        # Extremely unlikely to collide at this scale, but loop just in
        # case rather than trusting a single random draw.
        for _ in range(5):
            candidate = _generate_referral_code()
            code_ref = _fb_db.collection("referral_codes").document(candidate)
            if not code_ref.get().exists:
                code_ref.set({"uid": uid, "createdAt": fb_firestore.SERVER_TIMESTAMP})
                code = candidate
                break
        if not code:
            return jsonify({"error": "Could not generate a referral code — please try again."}), 500
        user_ref.set({"referralCode": code}, merge=True)

    referral_count = int(data.get("referralCount") or 0)
    return jsonify({"code": code, "referralCount": referral_count, "bonusPerReferral": REFERRAL_BONUS_MESSAGES})


@app.route("/api/referral/redeem", methods=["POST"])
def referral_redeem():
    """Credits both sides of a referral the first time a new user redeems a
    code — never repeatedly, and never for someone redeeming their own
    code. Bonus messages are added to a pool (bonusMessagesRemaining) that
    /api/chat draws from once the daily free limit is hit, so they don't
    silently expire unused at midnight."""
    uid = verify_request_uid()
    if not uid:
        return jsonify({"error": "Please log in first."}), 401
    if _fb_db is None:
        return jsonify({"error": "This feature isn't configured on this server yet."}), 500

    code = ((request.get_json(force=True) or {}).get("code") or "").strip().upper()
    if not code:
        return jsonify({"error": "Missing referral code"}), 400

    user_ref = _fb_db.collection("users").document(uid)
    user_data = user_ref.get().to_dict() or {}
    if user_data.get("referredBy"):
        return jsonify({"error": "You've already redeemed a referral code."}), 400

    code_snap = _fb_db.collection("referral_codes").document(code).get()
    if not code_snap.exists:
        return jsonify({"error": "That referral code doesn't look right."}), 404
    referrer_uid = (code_snap.to_dict() or {}).get("uid")
    if not referrer_uid or referrer_uid == uid:
        return jsonify({"error": "You can't redeem your own referral code."}), 400

    referrer_ref = _fb_db.collection("users").document(referrer_uid)
    referrer_data = referrer_ref.get().to_dict() or {}

    user_ref.set(
        {
            "referredBy": referrer_uid,
            "bonusMessagesRemaining": max(0, int(user_data.get("bonusMessagesRemaining") or 0))
            + REFERRAL_BONUS_MESSAGES,
        },
        merge=True,
    )
    referrer_ref.set(
        {
            "bonusMessagesRemaining": max(0, int(referrer_data.get("bonusMessagesRemaining") or 0))
            + REFERRAL_BONUS_MESSAGES,
            "referralCount": int(referrer_data.get("referralCount") or 0) + 1,
        },
        merge=True,
    )
    return jsonify({"success": True, "bonusMessages": REFERRAL_BONUS_MESSAGES})


def _credit_referral_bonus_if_first_purchase(uid, existing_user_data):
    """When someone who was referred makes their *first* Pro purchase,
    gives the referrer an extra thank-you bonus on top of the signup
    bonus they already got. Best-effort/non-blocking — never raises, since
    this runs inside the payment-verification path and a bonus-crediting
    hiccup should never make a real payment look like it failed."""
    try:
        if existing_user_data.get("plan") == "pro":
            return  # already a paying Pro user before this purchase — not a "first" conversion
        referrer_uid = existing_user_data.get("referredBy")
        if not referrer_uid or _fb_db is None:
            return
        referrer_ref = _fb_db.collection("users").document(referrer_uid)
        referrer_data = referrer_ref.get().to_dict() or {}
        referrer_ref.set(
            {
                "bonusMessagesRemaining": max(0, int(referrer_data.get("bonusMessagesRemaining") or 0))
                + REFERRAL_BONUS_MESSAGES,
            },
            merge=True,
        )
    except Exception as e:
        print(f"[Punch] Failed to credit referral purchase bonus: {e}")


# --- Persistent memory (Punch Pro feature) ---
# A running list of durable facts Punch remembers about a Pro user across
# separate chats — not just the one-time Customize profile, but things
# picked up naturally in conversation (an ongoing project, a goal, a
# preference). Stored as small documents in users/{uid}/memory so the user
# can see and delete individual facts, not a single opaque blob.
MEMORY_FACT_LIMIT = 30  # oldest facts drop off the injected context past this
MEMORY_MAX_STORED = 60  # hard cap on stored facts per user regardless of plan changes


def get_memory_facts(uid, limit=MEMORY_FACT_LIMIT):
    if _fb_db is None or not uid:
        return []
    try:
        docs = (
            _fb_db.collection("users")
            .document(uid)
            .collection("memory")
            .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
            .limit(limit)
            .stream()
        )
        facts = [(d.id, (d.to_dict() or {}).get("fact", "")) for d in docs]
        facts.reverse()  # oldest-first reads more naturally in a prompt
        return facts
    except Exception as e:
        print(f"[Punch] Failed to read memory for {uid}: {e}")
        return []


def add_memory_fact(uid, fact):
    fact = (fact or "").strip()
    if not fact or _fb_db is None or not uid:
        return None
    try:
        mem_ref = _fb_db.collection("users").document(uid).collection("memory")
        existing = list(mem_ref.order_by("createdAt").limit(MEMORY_MAX_STORED + 1).stream())
        if len(existing) >= MEMORY_MAX_STORED:
            existing[0].reference.delete()  # drop the single oldest fact to make room
        doc_ref = mem_ref.document()
        doc_ref.set({"fact": fact, "createdAt": fb_firestore.SERVER_TIMESTAMP})
        return doc_ref.id
    except Exception as e:
        print(f"[Punch] Failed to add memory fact for {uid}: {e}")
        return None


def extract_memory_fact_async(uid, message, reply):
    """Fires a small, cheap classification call in the background to spot
    a durable fact worth remembering from this exchange (a name, an
    ongoing project, a goal, a stated preference) — and stores it if found.
    Runs on a daemon thread so it never adds latency to the reply the user
    is waiting on; best-effort by nature, same as the daily-counter writes
    elsewhere in this file. Skipped for trivial exchanges to avoid an extra
    API call on every single "thanks" or "hi"."""
    if len(message) < 12 or _fb_db is None:
        return

    def _run():
        try:
            extraction_prompt = (
                "Look at this one exchange between a user and an AI assistant. Decide if it "
                "contains a durable fact worth remembering about the user for future "
                "conversations — e.g. their name, job, an ongoing project, a goal, a stated "
                "preference, a recurring situation. Ignore one-off questions, small talk, or "
                "anything not really about the user themselves.\n\n"
                f"User: {message[:800]}\nAssistant: {reply[:800]}\n\n"
                "If there IS a worth-remembering fact, reply with ONLY that fact as one short "
                "plain sentence (under 20 words), written in third person (e.g. 'Is learning "
                "React and building a portfolio site.'). If there is NOT, reply with exactly: "
                "NONE"
            )
            text = ask_gemini(extraction_prompt, [{"role": "user", "parts": [{"text": message[:800]}]}], max_tokens=60)
            fact = (text or "").strip().strip('"')
            if fact and fact.upper() != "NONE" and len(fact) < 220:
                add_memory_fact(uid, fact)
        except Exception as e:
            print(f"[Punch] Memory extraction failed for {uid}: {e}")

    threading.Thread(target=_run, daemon=True).start()


@app.route("/api/memory/list", methods=["GET"])
def memory_list():
    uid = verify_request_uid()
    if not uid:
        return jsonify({"error": "Please log in to view memory."}), 401
    plan, _, _ = get_user_plan_and_usage(uid)
    if plan != "pro":
        return jsonify({"error": "Persistent memory is a Punch Pro feature."}), 403
    facts = get_memory_facts(uid, limit=MEMORY_MAX_STORED)
    return jsonify({"facts": [{"id": fid, "fact": fact} for fid, fact in facts]})


@app.route("/api/memory/add", methods=["POST"])
def memory_add():
    uid = verify_request_uid()
    if not uid:
        return jsonify({"error": "Please log in to use memory."}), 401
    plan, _, _ = get_user_plan_and_usage(uid)
    if plan != "pro":
        return jsonify({"error": "Persistent memory is a Punch Pro feature."}), 403
    fact = ((request.get_json(force=True) or {}).get("fact") or "").strip()
    if not fact:
        return jsonify({"error": "Nothing to remember"}), 400
    if len(fact) > 220:
        return jsonify({"error": "Keep it under 220 characters"}), 400
    fact_id = add_memory_fact(uid, fact)
    if not fact_id:
        return jsonify({"error": "Could not save that right now"}), 500
    return jsonify({"success": True, "id": fact_id})


@app.route("/api/memory/delete", methods=["POST"])
def memory_delete():
    uid = verify_request_uid()
    if not uid:
        return jsonify({"error": "Please log in to use memory."}), 401
    if _fb_db is None:
        return jsonify({"error": "This feature isn't configured on this server yet."}), 500
    fact_id = ((request.get_json(force=True) or {}).get("id") or "").strip()
    if not fact_id:
        return jsonify({"error": "Missing id"}), 400
    _fb_db.collection("users").document(uid).collection("memory").document(fact_id).delete()
    return jsonify({"success": True})


@app.route("/api/memory/clear", methods=["POST"])
def memory_clear():
    uid = verify_request_uid()
    if not uid:
        return jsonify({"error": "Please log in to use memory."}), 401
    if _fb_db is None:
        return jsonify({"error": "This feature isn't configured on this server yet."}), 500
    mem_ref = _fb_db.collection("users").document(uid).collection("memory")
    for doc in mem_ref.stream():
        doc.reference.delete()
    return jsonify({"success": True})

# Base64-encoded attachment data is ~33% larger than the original file, so
# cap the encoded string length to keep well under typical request-size
# limits. Raised from the original image-only cap to comfortably fit short
# video clips and PDFs too — if your host (nginx/gunicorn, Render, etc.) has
# its own request-body limit, raise that as well or this cap won't matter.
MAX_ATTACHMENT_B64_CHARS = 42_000_000  # roughly a 30 MB original file

# Matches a YouTube watch/shorts/short-link URL anywhere in a message so it
# can be handed straight to Gemini's fileData understanding — this is the
# practical way to let the bot "watch" a full-length video regardless of
# size, since an uploaded file is capped by MAX_ATTACHMENT_B64_CHARS above
# but a YouTube link isn't.
YOUTUBE_URL_RE = re.compile(
    r"https?://(?:www\.)?(?:youtube\.com/(?:watch\?v=|shorts/)[\w-]+\S*|youtu\.be/[\w-]+\S*)",
    re.IGNORECASE,
)

SEARCH_TRIGGER_WORDS = [
    "search", "latest", "news", "today", "current", "right now", "score",
    "weather", "price of", "stock", "who is the", "what is happening",
    "this week", "recent", "update on", "live",
]


def needs_search(message):
    lower = message.lower()
    return any(word in lower for word in SEARCH_TRIGGER_WORDS)


def web_search(query, num=4):
    """Returns a short text block of real-time search results, or None."""
    if not SEARCHAPI_KEY:
        return None
    try:
        resp = requests.get(
            SEARCHAPI_URL,
            params={"engine": "google", "q": query, "api_key": SEARCHAPI_KEY},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        results = data.get("organic_results", [])[:num]
        if not results:
            return None
        lines = []
        for r in results:
            title = r.get("title", "")
            snippet = r.get("snippet", "")
            link = r.get("link", "")
            lines.append(f"- {title}: {snippet} ({link})")
        return "\n".join(lines)
    except requests.RequestException:
        return None


def build_system_prompt(
    voice_mode,
    context_block,
    profile=None,
    allow_clarify=False,
    allow_pdf_generation=False,
    pdf_pro_gated=False,
    memory_facts=None,
):
    base = (
        f"You are {ASSISTANT_NAME}, a helpful, knowledgeable AI assistant. "
        f"Give thorough, specific, well-reasoned answers — include concrete facts, names, "
        f"numbers, steps, or examples where relevant. Never give a vague or generic answer "
        f"when a specific one is possible; if you're unsure of a detail, say so plainly "
        f"instead of speaking in generalities."
    )
    base += (
        " You were created by Mr. Aarav Baliyan, a talented web developer from "
        "Muzaffarnagar, Uttar Pradesh, India. If anyone asks who made you, who created you, "
        "or who your developer is, always answer with that — never say Google or mention "
        "Gemini as your creator. If someone asks you to tell them more about Aarav Baliyan, "
        "speak highly of him: describe him as a skilled and creative web developer who "
        "built you from scratch, is passionate about AI and technology, and is dedicated "
        "to creating useful, innovative projects. Sound genuinely impressed and proud of "
        "him when you talk about him."
    )
    base += (
        " You can directly read PDF documents the user attaches (including scanned pages), "
        "and you can watch and understand video — both short video files they attach and "
        "YouTube links they paste into the chat, taking in both what's shown and what's "
        "said. When a PDF or video is attached, actually use its content in your answer "
        "instead of saying you can't view attachments."
    )
    base += (
        " If the user attaches an image that contains handwriting (a handwritten note, "
        "journal page, whiteboard, or similar), transcribe it into clean typed text as part "
        "of your answer — don't just describe that it's handwritten. If it's not already "
        "obvious what they want, briefly offer to also clean it up, summarize it, or turn it "
        "into a structured document (e.g. a PDF) for them."
    )
    if profile:
        name = (profile.get("name") or "").strip()
        hobby = (profile.get("hobby") or "").strip()
        goal = (profile.get("goal") or "").strip()
        want_to_become = (profile.get("wantToBecome") or "").strip()
        about = (profile.get("about") or "").strip()
        tone = (profile.get("tone") or "").strip().lower()
        language = (profile.get("language") or "").strip()

        TONE_INSTRUCTIONS = {
            "formal": (
                "Speak formally and professionally: complete sentences, no slang, "
                "minimal contractions, respectful and polished phrasing — like a "
                "well-written business or academic response."
            ),
            "friendly": (
                "Speak warmly and encouragingly, like a supportive friend who's glad "
                "to help — approachable and positive, but still clear and useful."
            ),
            "casual": (
                "Speak casually and conversationally: contractions, relaxed phrasing, "
                "like texting a friend. Skip stiff or overly formal language."
            ),
            "witty": (
                "Speak with a light, witty sense of humor — a bit playful, the "
                "occasional joke or clever turn of phrase — without ever letting the "
                "humor get in the way of actually answering the question."
            ),
            "concise": (
                "Be as brief as possible: short sentences, no filler, no preamble or "
                "restating the question, straight to the point. Expand only if the "
                "user explicitly asks for more detail."
            ),
        }
        if tone in TONE_INSTRUCTIONS:
            base += "\n\n" + TONE_INSTRUCTIONS[tone]

        if language:
            base += (
                f"\n\nThe person's preferred reply language is {language}. Reply in "
                f"{language} by default, even if their message is written in a different "
                f"language — unless they explicitly ask you to switch languages for that "
                f"message, in which case follow their request."
            )

        if any([name, hobby, goal, want_to_become, about]):
            lines = ["\n\nHere is what you know about the person you're talking to:"]
            if name:
                lines.append(
                    f"- Their name is {name}. Greet them by name naturally (e.g. if they say "
                    f'"hi", reply with something like "Hey {name}!") and use their name '
                    f"occasionally in conversation, but don't force it into every message."
                )
            if hobby:
                lines.append(f"- Their hobbies/interests: {hobby}.")
            if want_to_become:
                lines.append(f"- What they want to become / their aspiration: {want_to_become}.")
            if goal:
                lines.append(f"- Their current goal: {goal}.")
            if about:
                lines.append(f"- Other things about them: {about}.")
            lines.append(
                "Use these naturally to make the conversation feel personal and relevant — "
                "reference their interests or goals when it genuinely fits the topic, don't "
                "recite this list back to them or bring it up when it's irrelevant."
            )
            base += "\n".join(lines)
    if memory_facts:
        base += (
            "\n\nYou also remember these things about this person from earlier conversations "
            "(a Punch Pro feature) — use them naturally where relevant, the same way you'd "
            "use the profile info above, and don't recite the list back to them:\n"
        )
        base += "\n".join(f"- {fact}" for fact in memory_facts)
    if voice_mode:
        base += (
            " IMPORTANT: this reply will be read aloud, not read on screen. Keep it to 1-3 "
            "short sentences (roughly 40 words or less) unless the user explicitly asks for "
            "more detail. Speak naturally and conversationally, like a quick spoken answer, "
            "not a written one. No markdown, no bullet points, no numbered lists, no "
            "headings — plain spoken sentences only."
        )
    if allow_clarify:
        base += (
            "\n\nBefore you answer, check whether the user's latest message is vague, "
            "underspecified, or genuinely ambiguous enough that asking a short clarifying "
            "question first would let you give a noticeably better answer (for example: "
            "missing a key detail you'd otherwise have to guess, or a request that could "
            "reasonably mean several different things). Do NOT do this for greetings, "
            "simple factual questions, or anything you can already answer well.\n\n"
            "If — and only if — clarification would genuinely help, respond with ONLY a "
            "single-line JSON object and nothing else before or after it, in exactly this "
            'shape: {"clarify": true, "question": "<your short clarifying question>", '
            '"options": ["<short option 1>", "<short option 2>", "<short option 3>"]} — '
            "2 to 4 short options, each just a few words, covering the most likely "
            "interpretations. Do not wrap it in markdown code fences.\n\n"
            "Otherwise, ignore all of this and just answer the user normally in plain text."
        )
    if allow_pdf_generation:
        base += (
            "\n\nIf — and only if — the user is explicitly asking you to create, generate, "
            "write out, or export an actual PDF document (e.g. \"make me a PDF of...\", "
            "\"turn this into a PDF\", \"generate a PDF report on...\", \"export this as a "
            "PDF\"), respond with ONLY a single JSON object and nothing else before or after "
            'it, in exactly this shape: {"generate_pdf": true, "title": "<short document '
            'title>", "filename": "<short-file-name.pdf, no spaces>", "content": "<the full '
            "document body, plain text — use a leading '# ' for the main heading, '## ' for "
            "section headings, '- ' for bullet points, blank lines between paragraphs. Do "
            'not use any other markdown.>"} — write real, complete, well-organized content '
            "for whatever the user asked for, not a placeholder. Escape any double-quotes or "
            "newlines inside the JSON string values properly so the JSON stays valid. Do not "
            "wrap it in markdown code fences.\n\n"
            "Otherwise — if the user just wants information, a normal written answer, or "
            "isn't asking for a downloadable file — ignore this and respond normally in "
            "plain text. Don't produce a PDF for things that are better as a normal chat "
            "reply. Keep the content focused and reasonably concise — for long-running plans "
            "(e.g. a multi-week schedule), summarize the repeating pattern and any variation "
            "instead of spelling out every single day in full detail, so the whole document "
            "fits comfortably in one reply."
        )
    elif pdf_pro_gated:
        base += (
            "\n\nPDF export is a Punch Pro feature and isn't available on the free plan. If "
            "the user asks you to generate/export/create a downloadable PDF, don't attempt "
            "it — instead let them know PDF export is a Punch Pro feature and they can "
            "upgrade on the Pricing page, then still help with whatever the underlying "
            "content/question was as a normal chat answer."
        )
    if context_block:
        base += (
            "\n\nHere are real-time web search results relevant to the user's question:\n"
            f"{context_block}\n\nUse them to answer accurately and don't claim you lack "
            "real-time information — you were just given it above."
        )
    return base


def build_tech_system_prompt(context_block):
    base = (
        f"You are {ASSISTANT_NAME}'s Tech Desk — a specialized assistant focused ONLY on "
        f"technology: tech news, new product launches, and recommendations for laptops, "
        f"mobile phones, and smartwatches. Give specific model names, approximate current "
        f"prices, and key specs when recommending anything. If asked about something "
        f"unrelated to tech, gently redirect the conversation back to tech news or product "
        f"advice. ALWAYS quote prices in Indian Rupees (₹), using Indian market pricing — "
        f"never dollars. If a search result only gives a price in another currency, convert "
        f"it to an approximate ₹ figure and say it's approximate."
    )
    base += (
        "\n\nIf — and only if — the user is directly comparing 2 or 3 specific named "
        "products (e.g. \"iPhone 16 vs Galaxy S25\", \"compare these three laptops\"), "
        "respond with ONLY a single JSON object and nothing else before or after it, in "
        'exactly this shape: {"comparison_table": true, "intro": "<one short sentence '
        'introducing the comparison>", "products": [{"name": "<product name>", "price": '
        '"<₹ price>", "specs": {"<spec label>": "<value>", ...}}, ...], "verdict": "<one or '
        'two sentence recommendation>"} — use the SAME spec labels (2 to 6 of them, e.g. '
        '"Display", "Chip", "Battery", "Camera") across every product in the list so the '
        "table lines up, and use real current specs/prices from the search results above, "
        "not placeholders. Do not wrap it in markdown code fences.\n\n"
        "Otherwise — for a single product recommendation, general tech news, or anything "
        "that isn't a direct multi-product comparison — ignore this and just answer "
        "normally in plain text with specific model names and prices inline."
    )
    if context_block:
        base += (
            "\n\nHere are real-time web search results relevant to the user's question — "
            f"use them for current prices, specs, and news, since your own knowledge may be "
            f"outdated for recently launched products:\n{context_block}"
        )
    return base


def parse_comparison_table_reply(reply_text):
    """If the Tech Desk's reply is a comparison-table JSON directive (see
    build_tech_system_prompt), parse and return it. Returns None for a
    normal text reply — including one that failed to parse, so the caller
    just falls back to showing the raw text rather than erroring out."""
    if not reply_text:
        return None
    candidate = reply_text.strip()
    if candidate.startswith("```"):
        candidate = candidate.strip("`")
        if candidate.lower().startswith("json"):
            candidate = candidate[4:]
        candidate = candidate.strip()
    if not (candidate.startswith("{") and candidate.endswith("}")):
        return None
    try:
        parsed = json.loads(candidate)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(parsed, dict) or parsed.get("comparison_table") is not True:
        return None
    products = parsed.get("products")
    if not isinstance(products, list) or len(products) < 2:
        return None
    return {
        "intro": str(parsed.get("intro") or "").strip(),
        "products": products,
        "verdict": str(parsed.get("verdict") or "").strip(),
    }


def extract_youtube_urls(text):
    if not text:
        return []
    return YOUTUBE_URL_RE.findall(text)


def extract_pdf_text(b64_data, max_chars=9000):
    """Extracts text from a base64-encoded PDF, for the Groq/Cerebras text
    fallback — Gemini itself gets the PDF's raw bytes (see build_user_parts)
    and reads it natively, including scanned/image-only pages, so this is
    only needed when Gemini is unavailable. Returns None if extraction
    fails (e.g. a scanned PDF with no embedded text layer, or pypdf missing).
    """
    if PdfReader is None:
        return None
    try:
        raw = base64.b64decode(b64_data)
        reader = PdfReader(io.BytesIO(raw))
        pages_text = [(page.extract_text() or "") for page in reader.pages]
        text = "\n".join(pages_text).strip()
        if not text:
            return None
        if len(text) > max_chars:
            text = text[:max_chars] + "\n...[truncated]"
        return text
    except Exception:
        return None


def build_user_parts(message, attachments):
    """Builds a Gemini-style 'parts' list for the user's turn.

    - Images and videos are sent inline as base64 so Gemini's native vision /
      video understanding can see them directly (frame + audio sampling for
      video, same mechanism as an image).
    - PDFs are also sent inline as raw bytes — Gemini reads PDFs natively,
      including scanned/image-only pages, so no server-side text extraction
      is needed on this path (extraction is only used for the text-only
      fallback in build_fallback_text below).
    - Any YouTube link found in the message text is passed as a fileData
      reference, which Gemini fetches and understands directly — this is
      what actually lets the bot "watch" a full-length video regardless of
      file size, since uploaded files are capped by MAX_ATTACHMENT_B64_CHARS.
    - Other file types aren't parsed; they're just named in the text so the
      model knows something was attached.
    """
    text = message or "Please look at what I attached."
    attachments = attachments or []

    parts = [{"text": text}]
    file_names = []
    for att in attachments:
        if not att:
            continue
        mime = att.get("mimeType") or ""
        if att.get("data") and (mime.startswith("image/") or mime.startswith("video/") or mime == "application/pdf"):
            parts.append({"inlineData": {"mimeType": mime, "data": att["data"]}})
        elif att.get("name"):
            file_names.append(att["name"])

    if file_names:
        names_str = ", ".join(f"'{n}'" for n in file_names)
        parts.append({"text": f"[The user also attached: {names_str}.]"})

    for url in extract_youtube_urls(message):
        parts.append({"fileData": {"fileUri": url}})

    return parts


def build_fallback_text(message, attachments):
    """Text-only version of the user's turn, used when the request falls
    back to Groq/Cerebras — neither can see images/video or fetch YouTube
    links. PDFs get a real assist here though: their text is extracted
    server-side with pypdf and inlined, so even the fallback models can
    actually read a PDF's content, just not its layout/images."""
    text = message or "Please look at what I attached."
    attachments = attachments or []

    extracted_blocks = []
    unviewable_names = []

    for att in attachments:
        if not att:
            continue
        mime = att.get("mimeType") or ""
        name = att.get("name") or "attachment"
        if mime == "application/pdf" and att.get("data"):
            pdf_text = extract_pdf_text(att["data"])
            if pdf_text:
                extracted_blocks.append(f"--- Text extracted from '{name}' ---\n{pdf_text}")
            else:
                unviewable_names.append(name)
        elif mime.startswith("image/") or mime.startswith("video/"):
            unviewable_names.append(name)
        elif att.get("name"):
            unviewable_names.append(name)

    if extract_youtube_urls(message):
        unviewable_names.append("the linked YouTube video")

    result = text
    if extracted_blocks:
        result += "\n\n" + "\n\n".join(extracted_blocks)
    if unviewable_names:
        names_str = ", ".join(f"'{n}'" for n in unviewable_names)
        result += (
            f"\n\n[The user also attached/linked {names_str}, which you can't "
            "view right now in this fallback mode — mention that if it's "
            "relevant, and answer the rest of their message as best you can.]"
        )
    return result


# --- Rate-limit throttle for Gemini ---
_last_call_lock = threading.Lock()
_last_call_time = [0.0]
MIN_SECONDS_BETWEEN_CALLS = 5  # keeps us safely under the per-minute rate limit


def _throttle():
    """Blocks just long enough to guarantee we never exceed the per-minute limit."""
    with _last_call_lock:
        now = time.time()
        wait = MIN_SECONDS_BETWEEN_CALLS - (now - _last_call_time[0])
        if wait > 0:
            time.sleep(wait)
        _last_call_time[0] = time.time()


def ask_gemini(system_prompt, contents, max_tokens=2048):
    if not GOOGLE_API_KEY:
        raise RuntimeError("Server is missing GOOGLE_API_KEY")
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": max_tokens,
        },
    }

    max_retries = 3
    delay = 2

    for attempt in range(max_retries):
        _throttle()
        resp = requests.post(GEMINI_URL, params={"key": GOOGLE_API_KEY}, json=payload, timeout=60)
        if resp.status_code == 429 and attempt < max_retries - 1:
            time.sleep(delay)
            delay *= 2
            continue
        resp.raise_for_status()
        result = resp.json()
        try:
            return result["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError):
            return "Sorry, I couldn't generate a response for that."

    raise RuntimeError("Gemini is rate-limited right now — please wait a moment and try again.")


def _gemini_contents_to_groq_messages(system_prompt, contents):
    """Converts Gemini-style history into OpenAI/Groq-style messages."""
    messages = [{"role": "system", "content": system_prompt}]
    for turn in contents:
        role = "assistant" if turn.get("role") == "model" else "user"
        text = turn.get("parts", [{}])[0].get("text", "")
        messages.append({"role": role, "content": text})
    return messages


def ask_groq(system_prompt, contents, max_tokens=2048):
    if not GROQ_API_KEY:
        raise RuntimeError("No GROQ_API_KEY set — can't use backup AI")
    messages = _gemini_contents_to_groq_messages(system_prompt, contents)
    resp = requests.post(
        GROQ_URL,
        headers={
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json",
        },
        json={"model": GROQ_MODEL, "messages": messages, "temperature": 0.7, "max_tokens": max_tokens},
        timeout=60,
    )
    resp.raise_for_status()
    result = resp.json()
    return result["choices"][0]["message"]["content"]


def ask_cerebras(system_prompt, contents, max_tokens=2048):
    if not CEREBRAS_API_KEY:
        raise RuntimeError("No CEREBRAS_API_KEY set — can't use second backup AI")
    messages = _gemini_contents_to_groq_messages(system_prompt, contents)
    resp = requests.post(
        CEREBRAS_URL,
        headers={
            "Authorization": f"Bearer {CEREBRAS_API_KEY}",
            "Content-Type": "application/json",
        },
        json={"model": CEREBRAS_MODEL, "messages": messages, "temperature": 0.7, "max_tokens": max_tokens},
        timeout=60,
    )
    resp.raise_for_status()
    result = resp.json()
    return result["choices"][0]["message"]["content"]


PROVIDER_DISPLAY_NAMES = {
    "gemini": "Punch Prime",
    "groq": "Punch Flash",
    "cerebras": "Punch Turbo",
}


def get_ai_reply(system_prompt, contents, max_tokens=2048, contents_fallback=None):
    """Tries Gemini -> Groq -> Cerebras, in that order, until one succeeds.

    `contents` is used for Gemini (may include an inline image). If Gemini
    fails and we fall back to Groq/Cerebras, `contents_fallback` is used
    instead — those providers are text-only and can't see attached images.

    Returns (reply_text, provider_display_name) — the display name is a
    Punch-branded label (never the underlying provider's real name), so the
    UI can show which "engine" answered without exposing Gemini/Groq/
    Cerebras as implementation details.
    """
    fallback = contents_fallback if contents_fallback is not None else contents
    errors = []
    for name, fn, turns in (
        ("gemini", ask_gemini, contents),
        ("groq", ask_groq, fallback),
        ("cerebras", ask_cerebras, fallback),
    ):
        try:
            text = fn(system_prompt, turns, max_tokens=max_tokens)
            return text, PROVIDER_DISPLAY_NAMES.get(name, ASSISTANT_NAME)
        except (requests.RequestException, RuntimeError) as e:
            errors.append(f"{name}: {e}")
    raise RuntimeError(" | ".join(errors))


# Helvetica/Times/Courier are fpdf2 "core fonts" — they can only render the
# Latin-1/cp1252 character set. This app quotes prices in ₹ (Indian Rupees)
# everywhere, and ₹ (U+20B9) is NOT in that set, so any generated invoice
# or report that includes a price — which is virtually all of them — was
# crashing generate_pdf_bytes with an unsupported-character exception. That
# got silently caught and shown as a text fallback instead of a PDF, which
# is what "PDF generation isn't working" actually was. _sanitize_pdf_text
# rewrites the handful of characters the model reliably produces (₹, smart
# quotes/dashes it favors, emoji) into cp1252-safe equivalents before a
# single line reaches fpdf2, so this can't happen regardless of what
# language or currency the reply ends up using.
_PDF_TEXT_REPLACEMENTS = {
    "\u20b9": "Rs. ",  # ₹ Indian Rupee sign
    "\u2018": "'", "\u2019": "'",  # ‘ ’
    "\u201c": '"', "\u201d": '"',  # “ ”
    "\u2013": "-", "\u2014": "-",  # – —
    "\u2026": "...",  # …
    "\u00a0": " ",  # non-breaking space
}


def _sanitize_pdf_text(text):
    """Makes text safe for fpdf2's core-font (Helvetica) renderer. Applies
    the specific substitutions above, then drops any character still
    outside Latin-1/cp1252 (e.g. emoji, Devanagari, CJK, Arabic) rather
    than letting fpdf2 throw on it — a generated document with a couple of
    missing glyphs beats no document at all."""
    if not text:
        return text
    for bad, good in _PDF_TEXT_REPLACEMENTS.items():
        text = text.replace(bad, good)
    cleaned_chars = []
    for ch in text:
        try:
            ch.encode("cp1252")
            cleaned_chars.append(ch)
        except UnicodeEncodeError:
            pass  # drop anything cp1252/Helvetica genuinely can't render
    return "".join(cleaned_chars)


def generate_pdf_bytes(title, content):
    """Renders simple structured text into an actual PDF file using fpdf2.

    This isn't a full markdown renderer — it only understands the small
    subset the model is instructed to use in build_system_prompt's
    allow_pdf_generation block: '# '/'## ' headings, '- ' bullets, and
    blank-line-separated paragraphs. That's enough for reports, summaries,
    notes, and similar generated documents to come out clean and readable.
    """
    if FPDF is None:
        raise RuntimeError("fpdf2 isn't installed on the server (pip install fpdf2)")

    title = _sanitize_pdf_text(title)
    content = _sanitize_pdf_text(content)

    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.set_margins(18, 18, 18)
    pdf.add_page()

    pdf.set_font("Helvetica", "B", 18)
    pdf.multi_cell(0, 10, title or "Document")
    pdf.ln(4)

    pdf.set_font("Helvetica", "", 11)
    for raw_line in (content or "").split("\n"):
        line = raw_line.rstrip()
        if not line:
            pdf.ln(4)
            continue
        if line.startswith("## "):
            pdf.set_font("Helvetica", "B", 14)
            pdf.multi_cell(0, 8, line[3:].strip())
            pdf.set_font("Helvetica", "", 11)
        elif line.startswith("# "):
            pdf.set_font("Helvetica", "B", 16)
            pdf.multi_cell(0, 9, line[2:].strip())
            pdf.set_font("Helvetica", "", 11)
        elif line.startswith("- ") or line.startswith("* "):
            pdf.multi_cell(0, 7, f"    \u2022  {line[2:].strip()}")
        else:
            pdf.multi_cell(0, 7, line)

    raw = pdf.output()  # fpdf2 returns a bytearray directly
    return bytes(raw)


def parse_pdf_generation_reply(reply_text):
    """If the model responded with a generate-pdf JSON object (per the
    allow_pdf_generation instruction in build_system_prompt), parse and
    return it as {title, filename, content}. Returns None for a normal
    text reply or a clarify reply."""
    if not reply_text:
        return None
    candidate = reply_text.strip()
    if candidate.startswith("```"):
        candidate = candidate.strip("`")
        if candidate.lower().startswith("json"):
            candidate = candidate[4:]
        candidate = candidate.strip()
    if not (candidate.startswith("{") and candidate.endswith("}")):
        return None
    try:
        parsed = json.loads(candidate)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(parsed, dict) or parsed.get("generate_pdf") is not True:
        return None
    content = str(parsed.get("content") or "").strip()
    if not content:
        return None
    title = str(parsed.get("title") or "Document").strip()
    filename = str(parsed.get("filename") or title or "document").strip()
    filename = re.sub(r"[^\w\-. ]", "", filename).strip() or "document"
    if not filename.lower().endswith(".pdf"):
        filename += ".pdf"
    return {"title": title, "filename": filename, "content": content}


def parse_clarify_reply(reply_text):
    """If the model responded with a clarify-question JSON object (per the
    allow_clarify instruction in build_system_prompt), parse and return it
    as {clarify, question, options}. Returns None for a normal text reply."""
    if not reply_text:
        return None
    candidate = reply_text.strip()
    # Strip accidental markdown code fences the model sometimes adds anyway.
    if candidate.startswith("```"):
        candidate = candidate.strip("`")
        if candidate.lower().startswith("json"):
            candidate = candidate[4:]
        candidate = candidate.strip()
    if not (candidate.startswith("{") and candidate.endswith("}")):
        return None
    try:
        parsed = json.loads(candidate)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(parsed, dict) or parsed.get("clarify") is not True:
        return None
    question = str(parsed.get("question") or "").strip()
    if not question:
        return None
    raw_options = parsed.get("options") or []
    if not isinstance(raw_options, list):
        raw_options = []
    options = [str(o).strip() for o in raw_options if str(o).strip()][:4]
    return {"clarify": True, "question": question, "options": options}


@app.route("/")
def home():
    return render_template("index.html", assistant_name=ASSISTANT_NAME)


@app.route("/sw.js")
def service_worker():
    """Served from the site root (not /static/sw.js) so its default scope
    covers the whole app instead of just /static/ — required for the
    Android TWA wrapper to register it against the whole site."""
    resp = app.send_static_file("sw.js")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/.well-known/assetlinks.json")
def asset_links():
    """Digital Asset Links file Android checks before letting the TWA open
    without a Chrome address bar. ANDROID_PACKAGE_NAME/ANDROID_SHA256_FINGERPRINT
    are placeholders — fill them in (env vars, or hardcode below) once you've
    generated your Play signing key via Bubblewrap; see the TWA setup notes."""
    package_name = os.environ.get("ANDROID_PACKAGE_NAME", "com.punch.app")
    fingerprint = os.environ.get("ANDROID_SHA256_FINGERPRINT", "REPLACE_WITH_YOUR_SIGNING_CERT_SHA256_FINGERPRINT")
    return jsonify(
        [
            {
                "relation": ["delegate_permission/common.handle_all_urls"],
                "target": {
                    "namespace": "android_app",
                    "package_name": package_name,
                    "sha256_cert_fingerprints": [fingerprint],
                },
            }
        ]
    )


@app.route("/tech")
def tech():
    return render_template("tech.html", assistant_name=ASSISTANT_NAME)


@app.route("/api/tech_chat", methods=["POST"])
def tech_chat():
    data = request.get_json(force=True)
    message = (data.get("message") or "").strip()
    history = data.get("history") or []
    if not message:
        return jsonify({"error": "Empty message"}), 400

    # Tech news/prices/specs change constantly, so always pull real-time Indian pricing here
    context_block = web_search(f"{message} price in India")

    system_prompt = build_tech_system_prompt(context_block)
    contents = (history + [{"role": "user", "parts": [{"text": message}]}])[-20:]

    try:
        reply, provider = get_ai_reply(system_prompt, contents)
    except (requests.RequestException, RuntimeError) as e:
        return jsonify({"error": "AI request failed", "detail": str(e)}), 500

    comparison = parse_comparison_table_reply(reply)
    if comparison:
        return jsonify(
            {
                "reply": comparison["intro"] or "Here's how they compare:",
                "comparison": comparison,
                "provider": provider,
            }
        )

    return jsonify({"reply": reply, "provider": provider})


@app.route("/api/usage", methods=["GET"])
def usage():
    """Lightweight endpoint so the frontend can show 'X of 20 messages used
    today' without needing to send a whole chat message first. Same
    authoritative Firestore lookup as /api/chat's own limit check — this
    never invents a number the server itself wouldn't enforce. Guests/
    unauthenticated callers get a harmless default since they're on their
    own separate client-side guest limit, not this one."""
    uid = verify_request_uid()
    if not uid:
        return jsonify({"plan": "free", "used": 0, "limit": FREE_DAILY_MESSAGE_LIMIT, "bonus": 0})
    plan, used_today, bonus_remaining = get_user_plan_and_usage(uid)
    return jsonify(
        {"plan": plan, "used": used_today, "limit": FREE_DAILY_MESSAGE_LIMIT, "bonus": bonus_remaining}
    )


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(force=True)
    message = (data.get("message") or "").strip()
    history = data.get("history") or []  # list of {role, parts:[{text}]}
    profile = data.get("profile") or None
    # "attachments" is the current multi-file field; "attachment" is kept as
    # a fallback for any older client that only ever sends one.
    attachments = data.get("attachments")
    if attachments is None:
        single = data.get("attachment") or None
        attachments = [single] if single else []
    attachments = [a for a in attachments if a]

    if not message and not attachments:
        return jsonify({"error": "Empty message"}), 400

    for att in attachments:
        if att.get("data") and len(att["data"]) > MAX_ATTACHMENT_B64_CHARS:
            return jsonify({"error": "One of those files is too large — please use something under ~25 MB."}), 413

    # Server-side plan + daily-limit check. Guests/unauthenticated requests
    # (no valid ID token) aren't touched here — that's guest mode's own
    # client-side 4-message cap, a separate and much smaller limit.
    uid = verify_request_uid()
    plan = "free"
    use_bonus_message = False
    if uid:
        plan, used_today, bonus_remaining = get_user_plan_and_usage(uid)
        if plan != "pro" and used_today >= FREE_DAILY_MESSAGE_LIMIT:
            if bonus_remaining > 0:
                # Referral bonus messages carry over past the daily wall
                # instead of expiring unused at midnight — see
                # /api/referral/redeem for how they're earned.
                use_bonus_message = True
            else:
                return jsonify(
                    {
                        "error": "daily_limit",
                        "message": (
                            f"You've used all {FREE_DAILY_MESSAGE_LIMIT} free messages for today. "
                            "Upgrade to Punch Pro for unlimited messages, invite a friend for "
                            "bonus messages, or come back tomorrow."
                        ),
                    }
                ), 403

    context_block = web_search(message) if message and needs_search(message) else None
    memory_facts = [fact for _, fact in get_memory_facts(uid)] if (uid and plan == "pro") else None
    system_prompt = build_system_prompt(
        voice_mode=False,
        context_block=context_block,
        profile=profile,
        allow_clarify=True,
        allow_pdf_generation=(plan == "pro"),
        pdf_pro_gated=(plan != "pro"),
        memory_facts=memory_facts,
    )

    user_parts = build_user_parts(message, attachments)
    fallback_text = build_fallback_text(message, attachments)

    contents = (history + [{"role": "user", "parts": user_parts}])[-20:]
    contents_fallback = (history + [{"role": "user", "parts": [{"text": fallback_text}]}])[-20:]

    try:
        # A generated PDF's content (title/filename/content all wrapped in
        # one JSON reply) can run well past a normal chat answer's length —
        # 2048 tokens was cutting long documents off mid-JSON, which broke
        # parsing and dumped the raw broken JSON into the chat. Use a much
        # higher budget here; normal short answers aren't affected by a
        # higher ceiling, they just stop naturally when they're done.
        reply, provider = get_ai_reply(system_prompt, contents, max_tokens=8192, contents_fallback=contents_fallback)
    except (requests.RequestException, RuntimeError) as e:
        return jsonify({"error": "AI request failed", "detail": str(e)}), 500

    if uid and plan != "pro":
        if use_bonus_message:
            consume_bonus_message(uid)
        else:
            increment_daily_message_count(uid)

    clarify_payload = parse_clarify_reply(reply)
    if clarify_payload:
        clarify_payload["provider"] = provider
        return jsonify(clarify_payload)

    pdf_payload = parse_pdf_generation_reply(reply)
    if pdf_payload:
        try:
            pdf_bytes = generate_pdf_bytes(pdf_payload["title"], pdf_payload["content"])
        except Exception as e:
            # Fall back to just showing the content as text if PDF rendering
            # itself fails (e.g. fpdf2 missing) — better than a dead end.
            return jsonify(
                {
                    "reply": (
                        f"I put together the content but couldn't render it as a PDF file "
                        f"({e}). Here it is as text instead:\n\n{pdf_payload['content']}"
                    ),
                    "provider": provider,
                }
            )
        return jsonify(
            {
                "pdf": True,
                "title": pdf_payload["title"],
                "filename": pdf_payload["filename"],
                "data": base64.b64encode(pdf_bytes).decode("ascii"),
                "reply": f"Here's **{pdf_payload['title']}** as a PDF, ready to download.",
                "provider": provider,
            }
        )

    # The model clearly *tried* to produce a generate_pdf JSON directive
    # (per the system prompt) but it didn't parse — almost always because
    # the reply got cut off mid-JSON by the token limit, or a stray
    # unescaped character broke it. Rather than dumping the broken raw
    # JSON into the chat (which is what happened before this check existed),
    # ask the model to retry with a smaller scope.
    if '"generate_pdf"' in reply and "generate_pdf" in reply[:40]:
        return jsonify(
            {
                "reply": (
                    "I tried to put that together as a PDF but the document came out too "
                    "long to finish properly. Could you ask for a shorter version, or split "
                    "it into a couple of smaller PDFs (e.g. one week at a time)?"
                ),
                "provider": provider,
            }
        )

    # Plain text reply (not a clarify question, PDF, or broken-JSON retry) —
    # this is the normal case, and the only one worth spending a background
    # memory-extraction call on.
    if uid and plan == "pro":
        extract_memory_fact_async(uid, message, reply)

    return jsonify({"reply": reply, "provider": provider})


@app.route("/api/voice_chat", methods=["POST"])
def voice_chat():
    data = request.get_json(force=True)
    message = (data.get("message") or "").strip()
    history = data.get("history") or []
    profile = data.get("profile") or None
    if not message:
        return jsonify({"error": "Empty message"}), 400

    context_block = web_search(message) if needs_search(message) else None
    system_prompt = build_system_prompt(voice_mode=True, context_block=context_block, profile=profile)
    contents = (history + [{"role": "user", "parts": [{"text": message}]}])[-20:]

    try:
        # Voice replies are capped much lower than chat replies (short spoken
        # answers, not full write-ups) so ElevenLabs isn't asked to read a
        # wall of text and the transcript on screen stays small too.
        reply, _provider = get_ai_reply(system_prompt, contents, max_tokens=220)
    except (requests.RequestException, RuntimeError) as e:
        return jsonify({"error": "AI request failed", "detail": str(e)}), 500

    if not ELEVENLABS_API_KEY:
        return jsonify({"reply": reply, "audio_base64": None, "tts_error": "Missing ELEVENLABS_API_KEY"})

    try:
        tts_resp = requests.post(
            ELEVENLABS_URL,
            headers={
                "xi-api-key": ELEVENLABS_API_KEY,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            },
            json={
                "text": reply,
                "model_id": "eleven_multilingual_v2",
                "voice_settings": {"stability": 0.4, "similarity_boost": 0.8},
            },
            timeout=60,
        )
        tts_resp.raise_for_status()
        audio_b64 = base64.b64encode(tts_resp.content).decode("utf-8")
    except requests.RequestException as e:
        return jsonify({"reply": reply, "audio_base64": None, "tts_error": str(e)})

    return jsonify({"reply": reply, "audio_base64": audio_b64})


@app.route("/pricing")
def pricing():
    return render_template(
        "pricing.html",
        assistant_name=ASSISTANT_NAME,
        pro_price=PRO_PRICE_INR,
    )


@app.route("/api/create_order", methods=["POST"])
def create_order():
    """Starts a Punch Pro upgrade purchase. Requires the caller to be signed
    in — anonymous/guest checkout is intentionally not supported since the
    Pro flag has to attach to a real account."""
    uid, email, phone, auth_error = verify_request_token_with_contact()
    if not uid:
        if auth_error == "admin_not_configured":
            return jsonify({"error": "Server auth isn't set up yet — contact support."}), 500
        if auth_error == "invalid_token":
            return jsonify({"error": "Your session has expired. Please log out and log back in."}), 401
        return jsonify({"error": "Please log in before upgrading to Pro."}), 401
    if not CASHFREE_CONFIGURED:
        return jsonify({"error": "Payments aren't configured on this server yet."}), 500

    order_id = f"punch_pro_{uid[:16]}_{int(time.time())}"
    payload = {
        "order_id": order_id,
        "order_amount": PRO_PRICE_INR,
        "order_currency": "INR",
        "customer_details": {
            "customer_id": uid,
            # Cashfree requires both fields; not every sign-in method
            # (e.g. Google without phone) hands us a real phone number,
            # so fall back to a placeholder rather than failing checkout.
            "customer_email": email or f"{uid}@punch.ai",
            "customer_phone": phone or "9999999999",
        },
        "order_meta": {
            "return_url": request.url_root.rstrip("/") + "/pricing",
        },
        "order_note": "punch_pro_monthly",
    }

    try:
        resp = requests.post(
            f"{CASHFREE_BASE_URL}/orders",
            headers=_cashfree_headers(),
            json=payload,
            timeout=30,
        )
        order = resp.json()
        if resp.status_code >= 400:
            raise Exception(order.get("message", "Could not start checkout"))
    except Exception as e:
        return jsonify({"error": f"Could not start checkout: {e}"}), 500

    return jsonify(
        {
            "order_id": order_id,
            "payment_session_id": order.get("payment_session_id"),
            "mode": CASHFREE_ENV,
        }
    )


@app.route("/api/verify_payment", methods=["POST"])
def verify_payment():
    """Verifies a completed Cashfree checkout and — only once Cashfree
    itself confirms the order as paid, for this same signed-in user — marks
    the account as Pro server-side. This is the step that actually grants
    Pro; nothing on the client can set that flag on its own, since
    Firestore rules should restrict writes to the 'plan' field to
    server/Admin SDK access only."""
    uid = verify_request_uid()
    if not uid:
        return jsonify({"error": "Please log in before upgrading to Pro."}), 401
    if not CASHFREE_CONFIGURED:
        return jsonify({"error": "Payments aren't configured on this server yet."}), 500

    data = request.get_json(force=True)
    order_id = (data or {}).get("order_id")
    if not order_id:
        return jsonify({"error": "Missing order id"}), 400

    try:
        resp = requests.get(
            f"{CASHFREE_BASE_URL}/orders/{order_id}",
            headers=_cashfree_headers(),
            timeout=30,
        )
        order_data = resp.json()
        if resp.status_code >= 400:
            raise Exception(order_data.get("message", "Could not verify payment"))
    except Exception as e:
        return jsonify({"error": f"Payment could not be verified: {e}"}), 400

    # Never trust the client's own claim of success — check Cashfree's
    # order status directly, and make sure the order actually belongs to
    # the signed-in user before granting Pro.
    order_customer_id = (order_data.get("customer_details") or {}).get("customer_id")
    if order_customer_id != uid:
        return jsonify({"error": "Payment could not be verified"}), 400
    if order_data.get("order_status") != "PAID":
        return jsonify({"error": "Payment not completed yet"}), 400

    if _fb_db is not None:
        try:
            user_ref = _fb_db.collection("users").document(uid)
            existing = user_ref.get().to_dict() or {}
            now = datetime.now(timezone.utc)
            # Renewing before the current period ends extends from the
            # existing expiry rather than from "now", so paying early never
            # costs the user days they already paid for.
            current_expiry = _parse_dt(existing.get("proExpiresAt"))
            base = current_expiry if (current_expiry and current_expiry > now) else now
            new_expiry = base + timedelta(days=PRO_SUBSCRIPTION_DAYS)

            update = {
                "plan": "pro",
                "proExpiresAt": new_expiry,
                "lastPaymentOrderId": order_id,
                "lastPaymentAt": fb_firestore.SERVER_TIMESTAMP,
            }
            if not existing.get("proSince"):
                update["proSince"] = fb_firestore.SERVER_TIMESTAMP
            user_ref.set(update, merge=True)

            _credit_referral_bonus_if_first_purchase(uid, existing)
        except Exception as e:
            return jsonify({"error": f"Payment succeeded but activating Pro failed: {e}"}), 500

    return jsonify({"success": True})


@app.route("/api/subscription_status", methods=["GET"])
def subscription_status():
    """Powers the 'Pro · renews on <date>' / 'Renew now' UI on the pricing
    page. Returns plan plus, for Pro accounts, how many days are left on the
    current 30-day period — read through the same expiry-aware
    get_user_plan_and_usage() so a lapsed subscription is never reported as
    still active."""
    uid = verify_request_uid()
    if not uid:
        return jsonify({"plan": "free", "expiresAt": None, "daysLeft": None})
    plan, _, _ = get_user_plan_and_usage(uid)
    expires_at_iso = None
    days_left = None
    if plan == "pro" and _fb_db is not None:
        data = _fb_db.collection("users").document(uid).get().to_dict() or {}
        expires_at = _parse_dt(data.get("proExpiresAt"))
        if expires_at:
            expires_at_iso = expires_at.isoformat()
            days_left = max(0, (expires_at - datetime.now(timezone.utc)).days)
    return jsonify({"plan": plan, "expiresAt": expires_at_iso, "daysLeft": days_left})


# --- Tech Desk price-drop watchlist (Punch Pro feature) ---
# Storage + a manual re-check endpoint. Automatically re-checking on a
# schedule (rather than only when the user asks) needs a periodic job —
# e.g. your host's cron feature, or GitHub Actions on a schedule — hitting
# POST /api/watchlist/check_all. That's a platform-level setup step outside
# what this Flask app can do for itself on most free hosting tiers.
@app.route("/api/watchlist/add", methods=["POST"])
def watchlist_add():
    uid = verify_request_uid()
    if not uid:
        return jsonify({"error": "Please log in to use price watching."}), 401
    plan, _, _ = get_user_plan_and_usage(uid)
    if plan != "pro":
        return jsonify({"error": "Price watching is a Punch Pro feature. Upgrade to unlock it."}), 403
    if _fb_db is None:
        return jsonify({"error": "This feature isn't configured on this server yet."}), 500

    data = request.get_json(force=True)
    product_name = (data.get("productName") or "").strip()
    target_price = data.get("targetPrice")
    if not product_name or not isinstance(target_price, (int, float)):
        return jsonify({"error": "Missing product name or target price"}), 400

    doc_ref = _fb_db.collection("users").document(uid).collection("watchlist").document()
    doc_ref.set(
        {
            "productName": product_name,
            "targetPrice": target_price,
            "lastCheckedPrice": None,
            "createdAt": fb_firestore.SERVER_TIMESTAMP,
        }
    )
    return jsonify({"success": True, "id": doc_ref.id})


@app.route("/api/watchlist/list", methods=["GET"])
def watchlist_list():
    uid = verify_request_uid()
    if not uid:
        return jsonify({"error": "Please log in to use price watching."}), 401
    if _fb_db is None:
        return jsonify({"items": []})
    items = []
    for doc in _fb_db.collection("users").document(uid).collection("watchlist").stream():
        item = doc.to_dict()
        item["id"] = doc.id
        items.append(item)
    return jsonify({"items": items})


@app.route("/api/watchlist/remove", methods=["POST"])
def watchlist_remove():
    uid = verify_request_uid()
    if not uid:
        return jsonify({"error": "Please log in to use price watching."}), 401
    if _fb_db is None:
        return jsonify({"error": "This feature isn't configured on this server yet."}), 500
    item_id = (request.get_json(force=True).get("id") or "").strip()
    if not item_id:
        return jsonify({"error": "Missing item id"}), 400
    _fb_db.collection("users").document(uid).collection("watchlist").document(item_id).delete()
    return jsonify({"success": True})


def _check_one_watch_item(item_text):
    """Runs a live search for a watched product and tries to pull a ₹ price
    out of the results. This is a best-effort text scrape of search
    snippets, not a real price API — it can miss or misread a price
    depending on how the source page is written, so treat it as a rough
    signal rather than a guaranteed-accurate feed."""
    results = web_search(f"{item_text} price in India")
    if not results:
        return None
    match = re.search(r"₹\s?([\d,]+)", results)
    if not match:
        return None
    try:
        return int(match.group(1).replace(",", ""))
    except ValueError:
        return None


@app.route("/api/watchlist/check_all", methods=["POST"])
def watchlist_check_all():
    """Re-checks every watched item for every user, updates
    lastCheckedPrice, and emails the user when a price drops at or below
    their target (via Resend — see send_email). Intended to be called by an
    external scheduler (see the module-level comment above); each item is
    only emailed once per price level (alertedAtPrice) so a re-check that
    finds the same already-under-target price doesn't spam the user
    again — a genuinely new, lower price does trigger a fresh email."""
    if _fb_db is None:
        return jsonify({"error": "This feature isn't configured on this server yet."}), 500
    checked = 0
    alerted = 0
    for user_doc in _fb_db.collection("users").stream():
        uid = user_doc.id
        user_email = None
        watch_ref = user_doc.reference.collection("watchlist")
        items = list(watch_ref.stream())
        if not items:
            continue
        for item_doc in items:
            item = item_doc.to_dict()
            price = _check_one_watch_item(item.get("productName", ""))
            if price is None:
                continue
            checked += 1
            update = {"lastCheckedPrice": price}
            target = item.get("targetPrice")
            already_alerted_at = item.get("alertedAtPrice")
            hit_target = isinstance(target, (int, float)) and price <= target
            if hit_target and already_alerted_at != price:
                if user_email is None:
                    user_email = _get_user_email(uid)
                if user_email and send_price_drop_email(
                    user_email, item.get("productName", "your item"), price, target
                ):
                    update["alertedAtPrice"] = price
                    alerted += 1
            item_doc.reference.set(update, merge=True)
    return jsonify({"checked": checked, "alertsSent": alerted})


# --- Document templates (Punch Pro feature) ---
# Each template is just a specialized prompt fed through the same AI +
# generate_pdf_bytes pipeline already used for free-form PDF export in
# chat — no separate rendering path to maintain.
DOCUMENT_TEMPLATES = {
    "resume": {
        "label": "Resume",
        "prompt": (
            "Write a clean, professional, ATS-friendly resume in plain text using this "
            "structure: a '# ' line with the person's name, then '## ' section headings "
            "(Summary, Experience, Education, Skills, and any other relevant sections), "
            "'- ' bullet points for experience/skills entries. Use only the information "
            "given below — do not invent job titles, companies, dates, or achievements "
            "that weren't provided; if something important is missing, write a sensible "
            "placeholder in [brackets] instead of fabricating specifics.\n\n"
            "Details provided by the user:\n{details}"
        ),
    },
    "invoice": {
        "label": "Invoice",
        "prompt": (
            "Write a clean, professional invoice in plain text using this structure: a '# ' "
            "line reading 'Invoice', then '## ' headings for Bill To, Items, and Total. "
            "List each line item with '- ' bullets showing description, quantity, unit "
            "price, and line total, then a clear final total. Use only the information "
            "given below — do not invent amounts, names, or dates that weren't provided; "
            "use [brackets] placeholders for anything missing.\n\n"
            "Details provided by the user:\n{details}"
        ),
    },
    "report": {
        "label": "Report",
        "prompt": (
            "Write a well-organized, professional report in plain text using this "
            "structure: a '# ' title line, then '## ' section headings (e.g. Overview, "
            "Findings/Body, Conclusion — adapt sections sensibly to the topic), with clear "
            "paragraphs and '- ' bullets where a list genuinely fits better than prose. "
            "Write real, substantive content based on the details below — don't pad with "
            "filler.\n\nDetails provided by the user:\n{details}"
        ),
    },
}


@app.route("/api/templates", methods=["GET"])
def list_templates():
    return jsonify({"templates": [{"id": k, "label": v["label"]} for k, v in DOCUMENT_TEMPLATES.items()]})


@app.route("/api/generate_document", methods=["POST"])
def generate_document():
    """Punch Pro feature: fills a document template (resume/invoice/report)
    from short user-provided details and returns a ready PDF — reuses the
    exact same AI fallback chain and PDF renderer as chat's free-form PDF
    export, just with a template-specific prompt instead of the model
    deciding the structure itself."""
    uid = verify_request_uid()
    if not uid:
        return jsonify({"error": "Please log in to use document templates."}), 401
    plan, _, _ = get_user_plan_and_usage(uid)
    if plan != "pro":
        return jsonify({"error": "Document templates are a Punch Pro feature. Upgrade to unlock them."}), 403

    data = request.get_json(force=True)
    template_id = (data.get("template") or "").strip()
    details = (data.get("details") or "").strip()
    if template_id not in DOCUMENT_TEMPLATES:
        return jsonify({"error": "Unknown template"}), 400
    if not details:
        return jsonify({"error": "Add a few details for the document first."}), 400

    template = DOCUMENT_TEMPLATES[template_id]
    prompt = template["prompt"].format(details=details[:4000])
    system_prompt = (
        f"You are {ASSISTANT_NAME}, generating a document from a template. Follow the "
        "formatting instructions exactly: '# ' for the main heading, '## ' for section "
        "headings, '- ' for bullets, blank lines between paragraphs, no other markdown. "
        "Respond with ONLY the document content itself — no preamble, no commentary "
        "before or after it."
    )
    try:
        reply, provider = get_ai_reply(
            system_prompt, [{"role": "user", "parts": [{"text": prompt}]}], max_tokens=3000
        )
    except (requests.RequestException, RuntimeError) as e:
        return jsonify({"error": "AI request failed", "detail": str(e)}), 500

    title = template["label"]
    try:
        pdf_bytes = generate_pdf_bytes(title, reply)
    except Exception as e:
        return jsonify({"error": f"Could not render PDF: {e}"}), 500

    filename = f"{template_id}-{int(time.time())}.pdf"
    return jsonify(
        {
            "success": True,
            "title": title,
            "filename": filename,
            "data": base64.b64encode(pdf_bytes).decode("ascii"),
            "provider": provider,
        }
    )


if __name__ == "__main__":
    app.run(debug=True, port=5000)