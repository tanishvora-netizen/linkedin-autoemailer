"""
Local backend: receives the text of a LinkedIn profile from the Chrome
extension, asks Claude for a connection note, logs it, and returns it.

Run:  uvicorn main:app --port 8000 --reload
"""
import csv
import datetime
import os
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

ROOT = Path(__file__).parent
ME_FILE = ROOT.parent / "me.md"
LOG_FILE = ROOT / "drafts.csv"

MODEL = os.getenv("MODEL", "claude-sonnet-5")
CHAR_LIMIT = int(os.getenv("CHAR_LIMIT", "300"))  # LinkedIn connection-note limit

client = Anthropic()  # reads ANTHROPIC_API_KEY from the environment / .env

SYSTEM_PROMPT = f"""You write LinkedIn connection-request notes from a UC Berkeley
student to a professional (usually a Berkeley alum).

You will get: (1) info about the student, (2) the raw text of the person's
LinkedIn profile, which may include page clutter you should ignore.

Rules:
- Reference ONE specific, real detail from their profile (a role, company,
  career move, project, or cause). Never invent or guess details.
- If they went to Berkeley, mention it naturally once. If they did not, don't.
- End with a light, low-pressure ask (e.g. would love to connect / hear how
  they got into X). No calendar links, no multi-part asks.
- Use their first name. Plain, warm, specific. No flattery, no buzzwords,
  no "I hope this finds you well", no emojis.
- HARD LIMIT: {CHAR_LIMIT} characters including spaces. Aim for {CHAR_LIMIT - 40}.
- Output ONLY the note text. No quotes, no preamble."""


class DraftRequest(BaseModel):
    url: str
    name: str = ""
    profile_text: str


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL}


def ask_claude(user_content: str) -> str:
    msg = client.messages.create(
        model=MODEL,
        max_tokens=400,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_content}],
    )
    text = "".join(b.text for b in msg.content if b.type == "text")
    return text.strip().strip('"').strip()


@app.post("/draft")
def draft(req: DraftRequest):
    if not ME_FILE.exists():
        raise HTTPException(500, f"Missing {ME_FILE}. Fill in me.md first.")
    if len(req.profile_text.strip()) < 50:
        raise HTTPException(400, "Profile text looks empty. Is the page fully loaded?")

    base = (
        f"ABOUT ME (the sender):\n{ME_FILE.read_text()}\n\n"
        f"THEIR PROFILE ({req.url}):\n{req.profile_text[:15000]}"
    )

    note = ask_claude(base)
    # If it's too long, ask for a tighter rewrite (up to 2 retries).
    for _ in range(2):
        if len(note) <= CHAR_LIMIT:
            break
        note = ask_claude(
            base
            + f"\n\nA previous draft was {len(note)} characters, which is too long:\n"
            + note
            + f"\n\nRewrite it under {CHAR_LIMIT - 30} characters."
        )

    new_file = not LOG_FILE.exists()
    with LOG_FILE.open("a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new_file:
            w.writerow(["timestamp", "name", "url", "chars", "note"])
        w.writerow([datetime.datetime.now().isoformat(timespec="seconds"),
                    req.name, req.url, len(note), note])

    return {"draft": note, "length": len(note), "limit": CHAR_LIMIT}
