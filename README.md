# Verve — AI Chat Assistant Website

A dark, glowing-orb themed chatbot website with two ways to interact:

- **Chat section** — type a prompt, get a text reply from Gemini. If the question needs
  up-to-date info (news, prices, "latest", "today", etc.), it automatically pulls real-time
  Google results via SearchAPI before answering.
- **Voice section** — press the orb, speak your question (browser speech recognition), and
  Verve answers back out loud using an ElevenLabs-generated voice.

## Where to paste your API keys

Open the file **`.env.example`**, fill in your keys, then rename it to **`.env`** (or just set
these as environment variables before running). This is the ONLY place you need to touch:

| Key | Where to get it |
|---|---|
| `GOOGLE_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — free |
| `SEARCHAPI_KEY` | [searchapi.io](https://www.searchapi.io) — sign up, copy from dashboard |
| `ELEVENLABS_API_KEY` | [elevenlabs.io](https://elevenlabs.io) — sign up → Profile → API Keys |
| `SECRET_KEY` | any random text you make up |

None of these go inside `app.py` or any code file — they're read automatically from the
environment via `os.environ.get(...)`.

## 1. Run it locally

```bash
cd verve-ai
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate

pip install -r requirements.txt

export GOOGLE_API_KEY="your-key"        # Windows: set GOOGLE_API_KEY=your-key
export SEARCHAPI_KEY="your-key"
export ELEVENLABS_API_KEY="your-key"
export SECRET_KEY="any-random-text"

python app.py
```

Open **http://localhost:5000**.

## 2. How the two modes work

- **`/api/chat`** — plain text in, text out. Keeps conversation context in the browser
  (sent back each request), so nothing is stored server-side.
- **`/api/voice_chat`** — takes your spoken question (converted to text by the browser),
  sends it to Gemini (with search context if needed), then converts the reply to speech
  with ElevenLabs and sends the audio back to play automatically. If `ELEVENLABS_API_KEY`
  isn't set, it automatically falls back to the browser's built-in voice so it still works.

## 3. Put it online

**Render.com (free tier):**
1. Push this folder to GitHub.
2. render.com → New → Web Service → connect the repo.
3. Build command: `pip install -r requirements.txt`
4. Start command: `gunicorn app:app`
5. Under Environment, add the same 4 keys from the table above.
6. Deploy — you get a public HTTPS URL (required for voice input to work in the browser).

## 4. Customizing

- Change `ASSISTANT_NAME` env var to rename it everywhere on the site.
- Edit `SEARCH_TRIGGER_WORDS` in `app.py` to change when it decides to search the web.
- Swap `ELEVENLABS_VOICE_ID` for any voice from your ElevenLabs "Voices" library.
- Colors/fonts live in `static/style.css` under the `:root` block at the top.
