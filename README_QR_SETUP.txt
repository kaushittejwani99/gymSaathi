GymSaathi — Public Member QR Check-in + Self-Registration Patch
=============================================================

FILES INCLUDED (copy the paths exactly into your existing project)
- server.js                 Replace project-root server.js
- lib/db.js                 Replace lib/db.js
- public/app.js              Replace public/app.js
- public/styles.css          Replace public/styles.css
- public/join.html           NEW FILE
- public/join.js             NEW FILE
- public/join.css            NEW FILE

No package.json dependency is added. The QR image preview uses the external
QRServer image endpoint; the encoded link contains only this gym's public join URL.
After printing the QR image, the printed code itself does not depend on that service.

HOW TO APPLY
1. Make a backup of your project first.
2. Extract this ZIP into the project ROOT, allowing the included files to replace
   the matching files and add the three new public/join.* files.
3. Check syntax in the project root:
     node --check server.js
     node --check public/app.js
     node --check public/join.js
     node --check lib/db.js
4. Commit and push these files:
     git add server.js lib/db.js public/app.js public/styles.css public/join.html public/join.js public/join.css
     git commit -m "Add member QR check-in and self-registration"
     git push origin main
5. Wait for Render deployment. Log in to GymSaathi and open Settings once. Existing
   gym records receive a random public QR token automatically when /api/data loads.
6. In Settings, use the new Member QR code card. Open / print the QR image and print
   it for the gym entrance. The public link is also shown so it can be copied.

BEHAVIOUR
- Existing member: on the first visit on a browser/device, enters registered full name + mobile once. The server confirms the record, creates a random device token, stores only its SHA-256 hash linked to the customer and gym in member_qr_sessions, and sets an HttpOnly, SameSite cookie scoped to that gym's QR API path. The cookie expires after one year.
- Future scans on the same browser/device identify the member from that cookie without asking name or mobile again. Every scan checks the database for a current membership period (start <= India date <= end). This app determines active status from membership dates (rather than a manually stored active boolean). Only active members are marked present; inactive/expired members receive a message and no attendance record. Same-day repeat scans do not create duplicate attendance records.
- New visitor: if the mobile number is not registered, a limited self-registration form opens. A new customer and membership are saved, the device cookie is issued, and today's attendance is recorded only if the membership is active today. The app calculates the fee from Settings; the public form always records ₹0 paid so a visitor cannot claim a payment was made. The fee remains due until gym staff record the payment in GymSaathi.
- Today's QR attendance appears on the authenticated Dashboard and is included in gym backups and backup restores.
- The public page has no navigation to management pages. Its public API only returns public gym details/plans and accepts check-in, verification, registration or clearing this device's own remembered member. The existing management APIs still require authentication.
- QR device recognition is browser-specific: clearing cookies, using private browsing or switching devices requires the first-visit verification again. If a browser/device is shared, “This is not me? Switch member” removes that browser's QR session for this gym.
- The QR URL is gym-specific and contains a random token. Deleting/disabling the gym makes that QR link unavailable. Device sessions are stored in the database by hashed random token, not by trusting a raw customer ID in the cookie.

IMPORTANT SECURITY LIMITATION
The first-time name + mobile verification is not OTP. Someone who knows a member's full name and number could bind their own browser to that member on the first visit. The saved HttpOnly cookie prevents casual user_id tampering and enables later automatic check-ins, but it does not prove phone ownership on first use. For stronger identity proof, configure SMS/WhatsApp OTP or have staff issue a one-time activation code. Do not describe name + mobile matching as OTP-level identity verification.

RATE LIMITING
The public actions have server-side rate limits. The current server uses its existing
clientOf() helper; when deploying behind your trusted Render reverse proxy, configure
TRUST_PROXY=1 in the Render environment only if that proxy provides the expected
X-Forwarded-For header, so rate limits can distinguish visitors correctly.


REGISTRATION AVAILABILITY FIX
-----------------------------
The public QR registration form is enabled when at least one membership plan has
an effective price greater than zero. If price1 is configured, longer plans may
use the monthly-price fallback, consistent with PRICE_HINT. If price1 is empty,
a specifically priced 3/6/12-month plan can still be used. If no plan has a
price, registration remains blocked until the gym configures one in Settings.
