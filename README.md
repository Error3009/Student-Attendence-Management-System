# Student Attendance Management System — RKGIT

Browser-only project (HTML + CSS + JavaScript). Face recognition runs inside the browser using
face-api.js; no server or database is needed.

## Files
- `index.html` – page structure
- `style.css`  – styling (light/dark)
- `script.js`  – enrollment, live recognition, attendance, records, CSV export

## Run
Camera access needs `localhost` or HTTPS, so serve the folder instead of double-clicking the file:

    python -m http.server 8000      # then open http://localhost:8000
    (or use the VS Code "Live Server" extension)

Internet is needed on first load to fetch the face-api.js library and models from the jsDelivr CDN.
For offline use, download the model files into a `models/` folder and set `MODEL_URL = "models/"` in `script.js`.

## Use
1. **Enroll Student** – roll number + name → *Capture & enroll* (6 frames).
2. **Live Attendance** – *Start recognition*; recognised students are marked present once per day.
3. **Records** – pick a date, mark present/absent manually, remove students, **Download CSV** (opens in Excel).

## Notes
- Data lives in this browser's localStorage. Clearing site data deletes it; download the CSV regularly.
- Tune `MATCH_DISTANCE` in `script.js` (lower = stricter).
