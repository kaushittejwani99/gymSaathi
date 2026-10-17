GymSaathi — E2E Reviewed Fixes
==============================

What this package changes
-------------------------
- Uses India (Asia/Kolkata) dates consistently in server-side member/payment/reminder/chat/backup flows. This prevents a UTC server's date from disagreeing with QR attendance around midnight in India.
- Assistant: recognises common English help questions, reports member-state groups without confusing names like "Expired Guest" with a state word, gives a specific answer for QR duplicate scans and inactive membership, identifies QR link location, and answers attendance from database-backed daily rows.
- Dashboard: displays a visible "✓ Present" label on each attendance row, with member name, mobile and check-in time.
- Chat bubbles: natural text-driven height; no forced vertical whitespace.

Install safely
--------------
1. Back up the current repository, including data/backups and .env. Do not commit .env.
2. Apply the files in this archive over a separate branch/staging copy first. This archive contains the current uploaded project files plus the fixes above; inspect `git diff` before merging so work added after those uploads is not overwritten.
3. Check syntax from project root:
     node --check server.js
     node --check lib/ai.js
     node --check public/app.js
     node --check public/join.js
     node --check lib/core.js
     node --check lib/db.js
4. Commit and push the reviewed files, then wait for Render deployment.
5. Test on a staging gym or a dedicated test gym. Do not run registration/restore tests against a production gym's real member records.
6. Confirm Render is serving HTTPS, `COOKIE_SECURE`/proxy behavior is correct, and use a real phone to scan the printed QR.

Local test commands (from the QA harness archive, copied into project root as `tests/`)
--------------------------------------------------------------------------------------
  node tests/run_e2e.cjs
  node tests/test_qr_edges.cjs
  node tests/test_50_assistant.cjs

The assistant prompt suite deliberately disables Gemini and uses the built-in local fallback to make results repeatable and avoid provider/API costs. It is not a live Gemini evaluation. Local integration tests use a temporary file-backed database, not the real Render/Atlas database.

QR flow expected
----------------
- Existing active member, first scan on a device: verify registered full name + mobile once, set a gym-scoped HttpOnly cookie, and mark attendance.
- Same device next time: automatic recognition and check-in, without retyping name/phone. One attendance record per member per India date.
- New phone: show the limited self-registration form; save member + membership, start with ₹0 paid, keep the fee due, and mark today's attendance only if the membership is active today.
- Inactive/expired/future-start membership: no attendance row.
- The Dashboard's Today attendance table shows each member's name, mobile, check-in time, and `✓ Present`.

Security limit to be aware of
-----------------------------
First-time identity verification is based on the member's registered name + mobile, not OTP. Someone who knows both can attempt to bind their browser to that member. For stronger proof of phone ownership, add SMS/WhatsApp OTP or a staff-issued activation code before production-wide rollout.

QA scope limitations
--------------------
Local automated tests cannot confirm live Render deployment, real MongoDB Atlas, real browser camera/physical QR scanning, Gemini output quality with `GEMINI_API_KEY`, or sending WhatsApp messages through Meta. These require staging credentials/devices and should be marked as manual/live verification, not assumed passed.
