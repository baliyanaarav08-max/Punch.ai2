import os
import base64
import time
import threading

import requests
from flask import Flask, request, jsonify, render_template

app = Flask(__name__)

# --- Gemini (Google AI Studio) ---
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash-lite")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

# --- Groq (backup AI, used only if Gemini fails) ---
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

# --- Cerebras (second backup AI, free, used only if both Gemini and Groq fail) ---
CEREBRAS_API_KEY = os.environ.get("CEREBRAS_API_KEY")
CEREBRAS_MODEL = os.environ.get("CEREBRAS_MODEL", "llama-3.3-70b")
CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions"

# --- SearchAPI.io (real-time Google search) ---
SEARCHAPI_KEY = os.environ.get("SEARCHAPI_KEY")
SEARCHAPI_URL = "https://www.searchapi.io/api/v1/search"

# --- ElevenLabs (voice output) ---
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "OtEfb2LVzIE45wdYe54M")
ELEVENLABS_URL = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"

ASSISTANT_NAME = os.environ.get("ASSISTANT_NAME", "Punch")

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


def build_system_prompt(voice_mode, context_block):
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
    if voice_mode:
        base += (
            " Your reply will be read aloud by a text-to-speech voice, so keep it short, "
            "natural, and conversational. No markdown, no bullet points, no numbered lists."
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
        f"prices, and key specs when recommending anything. Compare options clearly when "
        f"asked (e.g. pros/cons, price-to-performance). If asked about something unrelated "
        f"to tech, gently redirect the conversation back to tech news or product advice. "
        f"ALWAYS quote prices in Indian Rupees (₹), using Indian market pricing — never "
        f"dollars. If a search result only gives a price in another currency, convert it "
        f"to an approximate ₹ figure and say it's approximate."
    )
    if context_block:
        base += (
            "\n\nHere are real-time web search results relevant to the user's question — "
            f"use them for current prices, specs, and news, since your own knowledge may be "
            f"outdated for recently launched products:\n{context_block}"
        )
    return base


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


def ask_gemini(system_prompt, contents):
    if not GOOGLE_API_KEY:
        raise RuntimeError("Server is missing GOOGLE_API_KEY")
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 2048,
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


def ask_groq(system_prompt, contents):
    if not GROQ_API_KEY:
        raise RuntimeError("No GROQ_API_KEY set — can't use backup AI")
    messages = _gemini_contents_to_groq_messages(system_prompt, contents)
    resp = requests.post(
        GROQ_URL,
        headers={
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json",
        },
        json={"model": GROQ_MODEL, "messages": messages, "temperature": 0.7, "max_tokens": 2048},
        timeout=60,
    )
    resp.raise_for_status()
    result = resp.json()
    return result["choices"][0]["message"]["content"]


def ask_cerebras(system_prompt, contents):
    if not CEREBRAS_API_KEY:
        raise RuntimeError("No CEREBRAS_API_KEY set — can't use second backup AI")
    messages = _gemini_contents_to_groq_messages(system_prompt, contents)
    resp = requests.post(
        CEREBRAS_URL,
        headers={
            "Authorization": f"Bearer {CEREBRAS_API_KEY}",
            "Content-Type": "application/json",
        },
        json={"model": CEREBRAS_MODEL, "messages": messages, "temperature": 0.7, "max_tokens": 2048},
        timeout=60,
    )
    resp.raise_for_status()
    result = resp.json()
    return result["choices"][0]["message"]["content"]


def get_ai_reply(system_prompt, contents):
    """Tries Gemini -> Groq -> Cerebras, in that order, until one succeeds."""
    errors = []
    for name, fn in (("gemini", ask_gemini), ("groq", ask_groq), ("cerebras", ask_cerebras)):
        try:
            return fn(system_prompt, contents)
        except (requests.RequestException, RuntimeError) as e:
            errors.append(f"{name}: {e}")
    raise RuntimeError(" | ".join(errors))


@app.route("/")
def home():
    return render_template("index.html", assistant_name=ASSISTANT_NAME)


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
        reply = get_ai_reply(system_prompt, contents)
    except (requests.RequestException, RuntimeError) as e:
        return jsonify({"error": "AI request failed", "detail": str(e)}), 500

    return jsonify({"reply": reply})


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(force=True)
    message = (data.get("message") or "").strip()
    history = data.get("history") or []  # list of {role, parts:[{text}]}
    if not message:
        return jsonify({"error": "Empty message"}), 400

    context_block = web_search(message) if needs_search(message) else None
    system_prompt = build_system_prompt(voice_mode=False, context_block=context_block)
    contents = (history + [{"role": "user", "parts": [{"text": message}]}])[-20:]

    try:
        reply = get_ai_reply(system_prompt, contents)
    except (requests.RequestException, RuntimeError) as e:
        return jsonify({"error": "AI request failed", "detail": str(e)}), 500

    return jsonify({"reply": reply})


@app.route("/api/voice_chat", methods=["POST"])
def voice_chat():
    data = request.get_json(force=True)
    message = (data.get("message") or "").strip()
    history = data.get("history") or []
    if not message:
        return jsonify({"error": "Empty message"}), 400

    context_block = web_search(message) if needs_search(message) else None
    system_prompt = build_system_prompt(voice_mode=True, context_block=context_block)
    contents = (history + [{"role": "user", "parts": [{"text": message}]}])[-20:]

    try:
        reply = get_ai_reply(system_prompt, contents)
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


if __name__ == "__main__":
    app.run(debug=True, port=5000)