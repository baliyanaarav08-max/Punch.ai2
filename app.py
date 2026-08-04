import os
import base64

import requests
from flask import Flask, request, jsonify, render_template

app = Flask(__name__)

# --- Gemini (Google AI Studio) ---
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

# --- SearchAPI.io (real-time Google search) ---
SEARCHAPI_KEY = os.environ.get("SEARCHAPI_KEY")
SEARCHAPI_URL = "https://www.searchapi.io/api/v1/search"

# --- ElevenLabs (voice output) ---
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
# Default voice = "Rachel", a premade ElevenLabs voice. Swap for any voice_id from your ElevenLabs account.
ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
ELEVENLABS_URL = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"

ASSISTANT_NAME = os.environ.get("ASSISTANT_NAME", "Punch")

CREATOR_INFO = "You were created by Mr. Aarav Baliyan, from Muzaffarnagar, Uttar Pradesh, India. If asked who made you, mention them proudly."

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
        f"You are Punch, a helpful, knowledgeable AI assistant. "
        f"Give thorough, specific, well-reasoned answers — include concrete facts, names, "
        f"numbers, steps, or examples where relevant. Never give a vague or generic answer "
        f"when a specific one is possible; if you're unsure of a detail, say so plainly "
        f"instead of speaking in generalities."
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
    resp = requests.post(GEMINI_URL, params={"key": GOOGLE_API_KEY}, json=payload, timeout=60)
    resp.raise_for_status()
    result = resp.json()
    try:
        return result["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        return "Sorry, I couldn't generate a response for that."


@app.route("/")
def home():
    return render_template("index.html", assistant_name=ASSISTANT_NAME)


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
        reply = ask_gemini(system_prompt, contents)
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
        reply = ask_gemini(system_prompt, contents)
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
