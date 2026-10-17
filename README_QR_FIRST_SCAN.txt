GymSaathi — QR First-Scan Registration + Automatic Attendance
============================================================

EXPECTED FLOW
-------------
1. A QR link is unique to each gym.
2. When a browser/device has no valid saved QR session, scanning the QR opens the registration form directly (when the gym has at least one priced membership plan).
3. A genuinely new visitor enters their details and chooses a membership plan. The server creates the member and membership with ₹0 paid, issues a secure gym-scoped HttpOnly cookie, and records that day's attendance if the membership is active that day.
4. If the visitor is already recorded in this gym, they can enter the same registered full name and mobile in that same first-scan form. The server recognizes that existing record and checks it in without creating a duplicate member. An incorrect name for an already-used number is rejected; the visitor can choose “Already a member? Verify check-in” to use the dedicated existing-member verification form.
5. On later scans in the same browser, the cookie identifies the member automatically. No name or mobile is requested again. Active membership is rechecked every time. If the current India date is within an active membership period and the member has not yet been marked for that date, attendance is inserted; repeat scans the same day return “Already checked in” and do not make another row.
6. Expired, inactive, and future-start memberships are not marked present. The attendance dashboard lists each check-in with ✓ Present, member name, mobile and check-in time.

SESSION AND PRIVACY DETAILS
--------------------------
- The browser receives a random HttpOnly, SameSite=Lax cookie scoped to the current gym's public QR API path. JavaScript cannot read this cookie.
- The server stores only a SHA-256 hash of the random secret in `member_qr_sessions`, tied to the gym and member IDs. It does not trust an ID provided by the browser.
- Clearing cookies, using private browsing, a different browser, or another device makes the registration/first-step form show again. Same-browser cookie behavior depends on opening the QR link in that same browser.
- A phone number already belonging to a member in another gym does not identify the member in this gym; gym IDs are kept separate.
- First-time existing-member matching uses registered name + mobile, not OTP. This is safer against accidental duplicates but does not prove phone ownership. Add SMS/WhatsApp OTP or staff-issued activation codes for stronger identity verification.
- The public QR page does not expose management APIs, member lists or payments.
- Public QR self-registration never records a payment. It starts at ₹0 paid and the fee remains due until gym staff records payment in GymSaathi.
- If no valid public plan price is configured, new self-registration is disabled; the page falls back to existing-member verification instead.

FILES CHANGED FOR THIS FLOW
---------------------------
- `server.js`: recognize existing same-gym members submitted from first-scan form without duplicate creation; issue remembered-device cookie and mark attendance.
- `public/join.html`: editable mobile number, revised first-scan registration copy, existing-member alternate action.
- `public/join.js`: first visit opens registration directly when plans are available; successful existing-member match shows check-in result; subsequent scans automatically show attendance result.
- `public/app.js`: Settings copy explains first scan and automatic repeat scans; dashboard attendance table keeps visible ✓ Present per member.
- `lib/ai.js`: QR assistant guidance follows the updated flow.
- All other included server/library/frontend files are from the reviewed GymSaathi project package and are included so paths remain consistent.

SAFE INSTALL
------------
1. Back up the current repository, production data/backups and environment configuration. Never commit `.env`.
2. Apply this ZIP to a separate branch or staging copy first. It contains the full source tree; inspect `git diff` before merging so unrelated newer changes are not overwritten.
3. From the project root, run:
     node --check server.js
     node --check lib/ai.js
     node --check lib/cache.js
     node --check lib/core.js
     node --check lib/db.js
     node --check lib/sample.js
     node --check lib/whatsapp.js
     node --check lib/xlsx.js
     node --check public/app.js
     node --check public/join.js
4. Run the included isolated tests:
     node tests/run_e2e.cjs
     node tests/test_qr_edges.cjs
     node tests/test_50_assistant.cjs
5. Commit and push only after reviewing the diff, then wait for Render deployment.
6. Test on a dedicated staging gym and a physical phone. Do not exercise registration or restore against real production members.

QA SCOPE
--------
- The included automation runs against an isolated temporary file-backed database.
- Test results cover server/API behavior and local assistant fallback. They do not prove behavior on the live Render service, production MongoDB Atlas, physical QR/camera scanning, the real Gemini API, or Meta WhatsApp Cloud API.
- Real Gemini output cannot be called tested unless `GEMINI_API_KEY` and provider requests are actually available; the repeatable 50-question test deliberately removes the API key.
