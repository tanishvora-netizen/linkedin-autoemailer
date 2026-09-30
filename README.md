# LinkedIn Note Drafter

Press F2 on a LinkedIn profile to get a Claude-written connection note.
Press F2 again to paste it into Connect > Add a note. You click Send.

## Setup (one time)

1. Fill in `me.md` with real details about you.
2. Backend:
       cd backend
       python -m venv venv
       source venv/bin/activate        # Windows: venv\Scripts\activate
       pip install -r requirements.txt
       cp .env.example .env            # then paste your API key into .env
       uvicorn main:app --port 8000 --reload
   Check http://localhost:8000/health shows {"ok": true}.
3. Extension: chrome://extensions -> Developer mode ON -> Load unpacked -> choose `extension/`.

## Daily use

1. Start the backend (step 2's last command).
2. Open a profile, press F2, read/edit the draft, press F2 again, review, click Send.
3. Every note is logged to backend/drafts.csv.

## When it breaks

LinkedIn changes its page structure often. If the Connect/Add-a-note step fails,
the note is copied to your clipboard so you can paste it by hand. To fix it,
right-click the button -> Inspect, and give Cursor the new HTML for
`openConnectDialog()` / `findNoteBox()` in content.js.
After editing the extension, hit the reload icon on chrome://extensions and refresh LinkedIn.
