import os
import base64
import json
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

# Base64-encoded attachment data is ~33% larger than the original file, so
# cap the encoded string length to keep well under typical request-size
# limits (Gemini's inline-image limit and most hosting platforms' body caps).
MAX_ATTACHMENT_B64_CHARS = 7_000_000  # roughly a 5 MB original file

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


def build_system_prompt(voice_mode, context_block, profile=None, allow_clarify=False):
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
    if profile:
        name = (profile.get("name") or "").strip()
        hobby = (profile.get("hobby") or "").strip()
        goal = (profile.get("goal") or "").strip()
        want_to_become = (profile.get("wantToBecome") or "").strip()
        about = (profile.get("about") or "").strip()
        tone = (profile.get("tone") or "").strip().lower()

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


def build_user_parts(message, attachments):
    """Builds a Gemini-style 'parts' list for the user's turn.

    Accepts a list of attachments (0 or more). Image attachments have their
    base64 data included inline so Gemini's vision can see each one.
    Non-image files (PDF, docx, txt, etc.) aren't parsed — Gemini can't
    reliably read arbitrary file contents this way — so they're only
    referenced by name in the text.
    """
    text = message or "Please look at what I attached."
    attachments = attachments or []

    parts = [{"text": text}]
    file_names = []
    for att in attachments:
        if not att:
            continue
        if (att.get("mimeType") or "").startswith("image/") and att.get("data"):
            parts.append({"inlineData": {"mimeType": att["mimeType"], "data": att["data"]}})
        elif att.get("name"):
            file_names.append(att["name"])

    if file_names:
        names_str = ", ".join(f"'{n}'" for n in file_names)
        parts.append({"text": f"[The user also attached: {names_str}.]"})

    return parts


def build_fallback_text(message, attachments):
    """Text-only version of the user's turn, used when the request falls back
    to Groq/Cerebras — neither of which can see attached images."""
    text = message or "Please look at what I attached."
    attachments = attachments or []
    names = [att["name"] for att in attachments if att and att.get("name")]
    if names:
        kinds = {"image" if (att.get("mimeType") or "").startswith("image/") else "file" for att in attachments if att}
        kind_str = "/".join(sorted(kinds)) if kinds else "file"
        names_str = ", ".join(f"'{n}'" for n in names)
        return (
            f"{text}\n\n[The user attached {kind_str}(s): {names_str}. "
            "You can't view them right now — let them know you can't see attachments "
            "in this fallback mode if it's relevant, and answer the rest of their "
            "message as best you can.]"
        )
    return text


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


def get_ai_reply(system_prompt, contents, max_tokens=2048, contents_fallback=None):
    """Tries Gemini -> Groq -> Cerebras, in that order, until one succeeds.

    `contents` is used for Gemini (may include an inline image). If Gemini
    fails and we fall back to Groq/Cerebras, `contents_fallback` is used
    instead — those providers are text-only and can't see attached images.
    """
    fallback = contents_fallback if contents_fallback is not None else contents
    errors = []
    for name, fn, turns in (
        ("gemini", ask_gemini, contents),
        ("groq", ask_groq, fallback),
        ("cerebras", ask_cerebras, fallback),
    ):
        try:
            return fn(system_prompt, turns, max_tokens=max_tokens)
        except (requests.RequestException, RuntimeError) as e:
            errors.append(f"{name}: {e}")
    raise RuntimeError(" | ".join(errors))


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
            return jsonify({"error": "One of those files is too large — please use something under ~5 MB."}), 413

    context_block = web_search(message) if message and needs_search(message) else None
    system_prompt = build_system_prompt(
        voice_mode=False, context_block=context_block, profile=profile, allow_clarify=True
    )

    user_parts = build_user_parts(message, attachments)
    fallback_text = build_fallback_text(message, attachments)

    contents = (history + [{"role": "user", "parts": user_parts}])[-20:]
    contents_fallback = (history + [{"role": "user", "parts": [{"text": fallback_text}]}])[-20:]

    try:
        reply = get_ai_reply(system_prompt, contents, contents_fallback=contents_fallback)
    except (requests.RequestException, RuntimeError) as e:
        return jsonify({"error": "AI request failed", "detail": str(e)}), 500

    clarify_payload = parse_clarify_reply(reply)
    if clarify_payload:
        return jsonify(clarify_payload)

    return jsonify({"reply": reply})


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
        reply = get_ai_reply(system_prompt, contents, max_tokens=220)
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