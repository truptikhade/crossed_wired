const API =
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1" ||
  location.hostname.startsWith("192.168.")
    ? `http://${location.hostname}:8000`
    : "https://crossed-wired-nnm2.vercel.app";

const LANGS = [
  ["en-US", "English"],
  ["hi-IN", "Hindi"],
  ["ur-PK", "Urdu"],
  ["bn-IN", "Bengali"],
  ["ta-IN", "Tamil"],
  ["es-ES", "Spanish"],
  ["fr-FR", "French"],
  ["de-DE", "German"],
  ["ar-SA", "Arabic"],
  ["zh-CN", "Chinese (Mandarin)"],
  ["ja-JP", "Japanese"],
  ["pt-BR", "Portuguese"],
  ["ru-RU", "Russian"],
  ["sw-KE", "Swahili"],
];

const $ = (id) => document.getElementById(id);
const el = {
  room: $("room"),
  join: $("join"),
  me: $("me"),
  them: $("them"),
  status: $("status"),
  log: $("log"),
  box: $("box"),
  send: $("send"),
  mic: $("mic"),
};

for (const s of [el.me, el.them]) {
  for (const [code, name] of LANGS) {
    const o = document.createElement("option");
    o.value = code;
    o.textContent = name;
    s.appendChild(o);
  }
}
el.me.value = "en-US";
el.them.value = "hi-IN";

const newId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);
// sessionStorage is per tab, so each tab gets its own sender ID.
let sender = sessionStorage.getItem("cw_sender");
if (!sender) {
  sender = newId();
  sessionStorage.setItem("cw_sender", sender);
}

const state = { room: "", after: 0, items: new Map(), order: [], timer: null };
const langName = (c) => (LANGS.find((l) => l[0] === c) || [0, c])[1];
const sameLang = (a, b) => a.split("-")[0] === b.split("-")[0];
const setStatus = (t) => {
  el.status.textContent = t;
};

function joinRoom() {
  const code = el.room.value.trim();
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(code)) {
    setStatus("Room code: 3 to 32 letters, numbers, - or _.");
    return;
  }
  state.room = code;
  state.after = 0;
  state.items.clear();
  state.order = [];
  history.replaceState(null, "", "?room=" + encodeURIComponent(code));
  clearInterval(state.timer);
  state.timer = setInterval(poll, 1000);
  setStatus("Joined " + code + ". Share this code with the other person.");
  poll();
}
el.join.onclick = joinRoom;
el.room.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinRoom();
});

const fromUrl = new URLSearchParams(location.search).get("room");
if (fromUrl) {
  el.room.value = fromUrl;
  joinRoom();
}

async function poll() {
  if (!state.room) return;
  try {
    const r = await fetch(
      `${API}/api/rooms/${encodeURIComponent(state.room)}/events?after=${state.after}`,
    );
    if (!r.ok) throw new Error(r.status);
    const { events } = await r.json();
    for (const ev of events) {
      state.after = Math.max(state.after, ev.seq);
      if (ev.type === "msg") receive(ev);
      else if (ev.type === "retract") {
        const m = state.items.get(ev.id);
        if (m) m.retracted = true;
      }
    }
    if (events.length) render();
  } catch (e) {
    setStatus("Connection problem, retrying…");
  }
}

function receive(ev) {
  if (state.items.has(ev.id)) return; // our own message echoing back, or a duplicate
  const mine = ev.sender === sender;
  const m = {
    id: ev.id,
    lang: ev.lang || "en-US",
    text: String(ev.text),
    tr: null,
    state: mine ? "own" : "pending",
    retracted: false,
    mine,
  };
  state.items.set(m.id, m);
  state.order.push(m.id);
  if (!mine) translateInto(m);
  else render();
}

function add(m) {
  state.items.set(m.id, m);
  state.order.push(m.id);
  render();
}

async function translateInto(m) {
  const target = el.me.value;
  if (sameLang(m.lang, target)) {
    m.state = "same";
    render();
    return;
  }
  m.state = "pending";
  m.tr = null;
  render();
  try {
    const r = await fetch(`${API}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: m.text,
        source: langName(m.lang),
        target: langName(target),
      }),
    });
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    if (target !== el.me.value) return; // language changed mid-request; a newer translation is coming
    m.tr = data.text;
    m.state = "done";
  } catch (e) {
    if (target !== el.me.value) return;
    m.state = "none";
  }
  render();
}

el.me.addEventListener("change", () => {
  for (const m of state.items.values()) if (!m.mine) translateInto(m);
});

async function send() {
  const text = el.box.value.trim();
  if (!text) return;
  if (!state.room) {
    setStatus("Join a room first.");
    return;
  }
  el.box.value = "";
  stopMic();
  const id = newId();
  const m = {
    id,
    lang: el.me.value,
    text,
    tr: null,
    state: "own",
    retracted: false,
    mine: true,
  };
  add(m);
  try {
    const r = await fetch(
      `${API}/api/rooms/${encodeURIComponent(state.room)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, sender, lang: m.lang, text }),
      },
    );
    if (!r.ok) throw new Error(r.status);
  } catch (e) {
    m.state = "failed";
    render();
    setStatus("Message not sent. Check the connection.");
  }
}
el.send.onclick = send;
el.box.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

async function retract(id) {
  const m = state.items.get(id);
  if (!m || !m.mine || m.retracted) return;
  m.retracted = true;
  render();
  try {
    const r = await fetch(
      `${API}/api/rooms/${encodeURIComponent(state.room)}/retract`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, sender }),
      },
    );
    if (!r.ok) throw new Error(r.status);
  } catch (e) {
    setStatus("Take-back did not reach the other person.");
  }
}

function render() {
  el.log.textContent = "";
  for (const id of state.order) {
    const m = state.items.get(id);
    const div = document.createElement("div");
    div.className =
      "msg" + (m.mine ? " mine" : "") + (m.retracted ? " retracted" : "");

    const head = document.createElement("div");
    head.className = "head";
    const who = document.createElement("span");
    who.textContent =
      (m.mine ? "You" : "Them") +
      " · " +
      langName(m.lang) +
      (m.retracted ? " · taken back" : "") +
      (m.state === "failed" ? " · not sent" : "");
    head.appendChild(who);
    if (m.mine && !m.retracted && m.state !== "failed") {
      const b = document.createElement("button");
      b.className = "linkbtn";
      b.textContent = "Take back";
      b.onclick = () => retract(m.id);
      head.appendChild(b);
    }
    div.appendChild(head);

    const orig = document.createElement("div");
    orig.className = "orig";
    orig.textContent = m.text;
    div.appendChild(orig);

    if (!m.mine && m.state !== "same") {
      const tr = document.createElement("div");
      tr.className = "tr";
      tr.textContent =
        m.state === "pending"
          ? "translating…"
          : m.state === "done"
            ? m.tr
            : "(translation unavailable)";
      div.appendChild(tr);
    }
    el.log.appendChild(div);
  }
  window.scrollTo(0, document.body.scrollHeight);
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let base = "";
function stopMic() {
  if (rec) rec.stop();
}
if (!SR) {
  el.mic.disabled = true;
  el.mic.title = "Dictation is not supported in this browser";
} else {
  el.mic.onclick = () => {
    if (rec) {
      rec.stop();
      return;
    }
    rec = new SR();
    rec.lang = el.me.value;
    rec.continuous = true;
    rec.interimResults = true;
    base = el.box.value ? el.box.value + " " : "";
    rec.onresult = (e) => {
      let s = "";
      for (let i = 0; i < e.results.length; i++)
        s += e.results[i][0].transcript;
      el.box.value = base + s;
    };
    rec.onend = () => {
      rec = null;
      el.mic.classList.remove("on");
      el.mic.textContent = "Mic";
    };
    rec.onerror = () =>
      setStatus(
        "Dictation stopped. Check mic permission and that the language is installed.",
      );
    rec.start();
    el.mic.classList.add("on");
    el.mic.textContent = "Stop";
  };
}
