# GymSaathi

**Run your gym by talking.** Memberships, fees and WhatsApp reminders for gym owners. The owner speaks, the assistant asks the questions a gym asks at the counter, and the member is saved. Nothing has to be typed.

It costs nothing to run: free hosting, a free database and a free AI key are enough.

## What it does

- **New member by voice.** Press one button. The assistant asks in Hindi, like a gym owner would: name, mobile number, gender, age, weight, height, goal, any health problem, batch, personal trainer or not, diet plan or not, how many months, and how much was paid today. It speaks each question and listens for the answer. Say "skip" or "pata nahi" for anything the member does not want to tell.
- **Fee worked out for you.** The gym's own prices (1 month, 3 months, 6 months, 1 year, trainer, diet) are filled in once on Settings. The assistant adds them up and tells the fee.
- **Fees pending.** A member who joins and says "I will pay in a day or two" is saved with the fee pending. They appear on the dashboard every day until the fee is paid.
- **WhatsApp reminders.** The dashboard lists today's reminders: fees pending (every day), membership ending (last 4 days), membership ended (days 1, 3, 7 and 15 after). One tap opens WhatsApp with the message already written in Hindi, with the gym's name, the amount and the UPI ID. You press Send.
- **Welcome message** on joining, with the plan, dates and fee.
- **Ask anything.** "Kiski fees baaki hai?", "Is mahine kitna paisa aaya?", "Rahul ki membership kab khatam hogi?" The assistant answers from the gym's own members and reads the answer aloud.
- **Payments.** One tap for "got the full amount in cash" or by UPI, or enter a part payment. Renew a membership in one tap.
- **One login per gym.** You (the service owner) create a login for each gym on the Accounts page. A gym sees only its own members. You can switch a gym off or reset its password.

## Try it on your computer

You need Node.js 20.12 or newer.

```bash
npm install
```

Copy `.env.example` to `.env`, and set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (your own owner login). Then:

```bash
npm start
```

Open http://localhost:3000 and sign in. Fill in the gym's details and prices on **Settings**, then press **New member by voice**.

Voice needs Chrome or Edge, and the microphone must be allowed for the site. Other browsers still work by typing the answers.

```bash
npm test
```

runs the checks on a temporary folder. It never touches your data, Google or WhatsApp.

## Put it online for free

1. **Database:** make a free cluster on [MongoDB Atlas](https://www.mongodb.com/atlas), create a database user, allow access from anywhere, and copy the connection string.
2. **AI key:** make a free key in [Google AI Studio](https://aistudio.google.com/apikey).
3. **Hosting:** on [Render](https://render.com), create a free Web Service from this repository. Build command `npm install`, start command `npm start`.
4. In Render's **Environment** tab set:

   | Name | Value |
   |---|---|
   | `ADMIN_EMAIL` | your owner login |
   | `ADMIN_PASSWORD` | a long password |
   | `MONGODB_URI` | the Atlas connection string |
   | `GEMINI_API_KEY` | the Google key |
   | `COOKIE_SECURE` | `1` |
   | `TRUST_PROXY` | `1` |
   | `TZ` | `Asia/Kolkata` |

Never put these values in the code or in a file you upload. Without `MONGODB_URI` the data is kept in files, and a free host wipes those on every restart.

## What "free" means here

- **WhatsApp messages are sent by a tap, not on their own.** Sending automatically needs the WhatsApp Business API, which charges per message. Here the owner opens the dashboard once a day and taps Send for each reminder; a sent reminder leaves the list for that day.
- **A free Render service sleeps** after 15 minutes without use. The first page after that takes up to a minute to open.
- **The free Gemini key has a daily limit.** When it is used up, or no key is set, the assistant still works: it then reads one answer per question instead of understanding a whole sentence.
- **MongoDB Atlas free tier** holds 512 MB, enough for many hundreds of gyms.

## Where things are

| File | What it holds |
|---|---|
| `server.js` | logins, the API, and serving the pages |
| `lib/core.js` | dates, fees, membership status, reminder rules and message text (shared with the browser) |
| `lib/ai.js` | the registration talk and the question answers |
| `lib/db.js` | storage: files or MongoDB |
| `public/` | the pages |
| `test.js` | the checks |
