import os
import random
import re
import threading
import time
from urllib.parse import quote

import requests
from flask import Flask, jsonify, request, send_from_directory

APP_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND = os.path.join(APP_DIR, "..", "frontend")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
MODELS = [
    m.strip()
    for m in os.environ.get(
        "TRANSLATE_MODELS", "gemini-3.8-flash,gemini-3.5-flash-lite"
    ).split(",")
    if m.strip()
]
MAX_EVENTS = 500
MAX_TEXT = 2000
MAX_ATTEMPTS = 4  # attempts per model
RETRYABLE = {429, 500, 502, 503, 504}
ROOM_RE = re.compile(r"^[A-Za-z0-9_-]{3,32}$")

app = Flask(__name__)
lock = threading.Lock()
rooms = {}  # room code -> {"seq": int, "events": [dict]}


def room_for(code):
    with lock:
        return rooms.setdefault(code, {"seq": 0, "events": []})


def add_event(code, event):
    room = room_for(code)
    with lock:
        room["seq"] += 1
        event["seq"] = room["seq"]
        room["events"].append(event)
        del room["events"][:-MAX_EVENTS]
    return event


def valid_room(code):
    return bool(ROOM_RE.match(code or ""))


def build_prompt(text, source, target):
    return (
        f"Translate this message from {source} to {target}.\n"
        "It is one side of a real, heated argument between two people who do not share a language.\n"
        "Keep everything the speaker did: tone, anger, sarcasm, hedging, repetition, trailing off, "
        "interruptions, and the same strength of swearing. Do not soften, sanitize, moralize, or add "
        "politeness. Do not add notes. If a slang phrase has no equivalent, use the closest natural one.\n"
        "Output only the translation.\n\nMessage:\n\"\"\"" + text + "\"\"\""
    )


def call_model(model, prompt):
    """Call one model with backoff. Raises HTTPError/RequestException on final failure."""
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{quote(model, safe='')}:generateContent"
    )
    for attempt in range(MAX_ATTEMPTS):
        try:
            response = requests.post(
                url,
                params={"key": GEMINI_API_KEY},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"maxOutputTokens": 1024},
                },
                timeout=30,
            )
            response.raise_for_status()
            return response
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else None
            if status not in RETRYABLE or attempt == MAX_ATTEMPTS - 1:
                raise
            wait = min(2 ** attempt + random.uniform(0, 1), 15)
            app.logger.warning(
                "Gemini %s HTTP %s; retrying in %.1fs (%s/%s)",
                model, status, wait, attempt + 1, MAX_ATTEMPTS - 1,
            )
            time.sleep(wait)
        except requests.ConnectionError:
            if attempt == MAX_ATTEMPTS - 1:
                raise
            wait = min(2 ** attempt + random.uniform(0, 1), 15)
            app.logger.warning("Gemini %s connection error; retrying in %.1fs", model, wait)
            time.sleep(wait)


def translate_text(text, source, target):
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not set on the server")
    prompt = build_prompt(text, source, target)
    last_error = None
    for model in MODELS:
        try:
            response = call_model(model, prompt)
        except requests.RequestException as e:
            last_error = e
            app.logger.warning("Gemini model %s failed; trying next model", model)
            continue
        data = response.json()
        candidates = data.get("candidates", [])
        parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
        translation = "".join(part.get("text", "") for part in parts).strip()
        if translation:
            return translation
        app.logger.warning(
            "Gemini %s returned no text; finishReason=%s, promptFeedback=%s",
            model,
            candidates[0].get("finishReason") if candidates else None,
            data.get("promptFeedback"),
        )
        last_error = ValueError("Gemini returned no translation")
    if last_error is None:
        raise ValueError("Gemini returned no translation")
    raise last_error


@app.get("/")
def index():
    return send_from_directory(FRONTEND, "index.html")


@app.get("/<path:name>")
def static_files(name):
    return send_from_directory(FRONTEND, name)


@app.post("/api/rooms/<code>/messages")
def post_message(code):
    if not valid_room(code):
        return jsonify(error="bad room code"), 400
    body = request.get_json(silent=True) or {}
    msg_id = str(body.get("id", ""))[:64]
    sender = str(body.get("sender", ""))[:64]
    lang = str(body.get("lang", "en-US"))[:16]
    text = str(body.get("text", "")).strip()
    if not msg_id or not sender or not text:
        return jsonify(error="id, sender and text are required"), 400
    if len(text) > MAX_TEXT:
        return jsonify(error="message too long"), 413
    add_event(code, {"type": "msg", "id": msg_id, "sender": sender, "lang": lang, "text": text})
    return jsonify(ok=True)


@app.post("/api/rooms/<code>/retract")
def post_retract(code):
    if not valid_room(code):
        return jsonify(error="bad room code"), 400
    body = request.get_json(silent=True) or {}
    msg_id = str(body.get("id", ""))[:64]
    sender = str(body.get("sender", ""))[:64]
    room = room_for(code)
    with lock:
        owned = any(
            e["type"] == "msg" and e["id"] == msg_id and e["sender"] == sender
            for e in room["events"]
        )
    if not owned:
        return jsonify(error="message not found or not yours"), 403
    add_event(code, {"type": "retract", "id": msg_id})
    return jsonify(ok=True)


@app.get("/api/rooms/<code>/events")
def get_events(code):
    if not valid_room(code):
        return jsonify(error="bad room code"), 400
    after = request.args.get("after", default=0, type=int)
    room = room_for(code)
    with lock:
        events = [e for e in room["events"] if e["seq"] > after][:200]
    return jsonify(events=events)


@app.post("/api/translate")
def post_translate():
    body = request.get_json(silent=True) or {}
    text = str(body.get("text", "")).strip()
    source = str(body.get("source", ""))[:40]
    target = str(body.get("target", ""))[:40]
    if not text or not target:
        return jsonify(error="text and target are required"), 400
    if len(text) > MAX_TEXT:
        return jsonify(error="message too long"), 413
    try:
        out = translate_text(text, source or "the original language", target)
    except RuntimeError as e:
        return jsonify(error=str(e)), 503
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else None
        app.logger.error("Gemini API returned HTTP %s on all models", status)
        return jsonify(error="Gemini translation failed"), 502
    except requests.RequestException as e:
        app.logger.error("Gemini request failed (%s)", type(e).__name__)
        return jsonify(error="Gemini translation failed"), 502
    except ValueError as e:
        app.logger.error("Gemini response could not be used: %s", e)
        return jsonify(error="Gemini translation failed"), 502
    return jsonify(text=out)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)