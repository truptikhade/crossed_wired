# Crossed Wires

Two people, two languages, one room. Each person types or dictates in their own language and reads the other in theirs. Messages arrive instantly, keep their tone, and can be taken back.

## Layout

- `backend/app.py`: Flask server. Holds rooms in memory, relays messages, and translates with the Gemini API.
- `backend/requirements.txt`: Python dependencies.
- `frontend/`: plain HTML, CSS and JavaScript. No build step.

## Run it

1. Install Python 3.10 or newer.
2. Set up and start the server:

```bash
cd crossed-wires/backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export GEMINI_API_KEY="your-gemini-api-key"
python app.py
```

3. Open http://localhost:8000 in a browser.
4. Type the same room code on both devices (for example `kitchen-table`). Each person picks their language under "I speak" and "They speak". Both devices need to reach the server, so for a second phone on the same Wi-Fi use your computer's local IP, such as http://192.168.1.20:8000.

## Configuration

- `GEMINI_API_KEY`: required for translation. Without it, messages still send but show "translation unavailable." Create a key in [Google AI Studio](https://aistudio.google.com/apikey); keep it private and do not commit it.
- `TRANSLATE_MODELS`: optional comma-separated Gemini models to try in order. Defaults to `gemini-3.8-flash`.
- `PORT`: optional, defaults to `8000`.

## Known limits

- Rooms and messages live in memory. Restarting the server clears them.
- Dictation (the Mic button) needs a secure context. On a phone over plain http on a local network it may not work. Use localhost on the computer, or serve over https.
- Dictation support depends on the browser. Chrome and Safari work best.
- There is no login. Anyone with a room code can read and post to that room. Use hard-to-guess codes.
- For real use, add HTTPS, a persistent store, and rate limits before deploying.
