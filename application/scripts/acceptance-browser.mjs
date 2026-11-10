// The canonical browser gate creates a new disposable SQLite database and image
// on every run. It uses the installed Playwright Chromium shell by default.
// No named Docker stage, pre-existing document, saved date label or Chrome channel.
import './ocr-browser-smoke.mjs';
