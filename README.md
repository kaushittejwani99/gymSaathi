# GymSaathi

**Run your gym by talking.** Memberships, fees and WhatsApp reminders for gym owners. The owner speaks, the assistant asks the questions a gym asks at the counter, and the member is saved. Nothing has to be typed.

It costs nothing to run: free hosting, a free database and a free AI key are enough.

## What it does

- **New member by voice.** Press one button. The assistant asks in Hindi, like a gym owner would: name, mobile number, gender, age, weight, height, goal, any health problem, batch, personal trainer or not, diet plan or not, how many months, and how much was paid today. It speaks each question and listens for the answer. Say "skip" or "pata nahi" for anything the member does not want to tell.
- **Fee worked out for you.** The gym's own prices (1 month, 3 months, 6 months, 1 year, trainer, diet) are filled in once on Settings. The assistant adds them up and tells the fee. A membership can be any number of months from 1 to 36; a length with no price of its own (9 months, say) costs the monthly price times the months.
- **Fees pending.** A member who joins and says "I will pay in a day or two" is saved with the fee pending. They appear on the dashboard every day until the fee is paid.
- **WhatsApp reminders.** Fees pending: every day until paid. Membership ending: every day from 5 days before the last day. Membership ended: every day for 5 days after. Each message is in Hindi and says the gym's name, the day the member joined, the length of the membership they took and its last day; the fees one adds the amount and the UPI ID. The dashboard lists today's reminders and one tap opens WhatsApp with the message written. With WhatsApp set up (below) they go out by themselves at 6 every morning.
- **Welcome message** on joining, with the plan, dates and fee.
- **Ask anything.** "Kiski fees baaki hai?", "Is mahine kitna paisa aaya?", "Rahul ki membership kab khatam hogi?" The assistant answers from the gym's own members and reads the answer aloud.
- **Payments.** One tap for "got the full amount in cash" or by UPI, or enter a part payment. Renew a membership in one tap. The Payments page lists every payment the gym received, for one month or for all time, and Members has tabs for fees pending and fees paid.
- **Mistakes can be taken back.** Delete a payment typed in by mistake, undo a renewal made by mistake, delete a member, remove the sample members in one step. The owner of the service can delete a whole gym with everything it holds.
- **Membership history.** Every period a member buys is saved as its own record and never changed: 1 month now and 3 months later are two records. Every payment is its own record too.
- **One login per gym.** You (the service owner) add each gym on the Accounts page with its details already filled in: gym name, owner's name and mobile number, address, timings, amenities, UPI ID, prices, and its username and password. A gym sees only its own members.
- **First month free, then ₹999 a month.** A gym's free month starts the moment it first signs in. It stays signed in (there is no sign-out button) until that time is over. Then it is signed out on every device and sees: *Your free trial is over. Pay ₹999 to start the service again.* In its last five days the dashboard warns it. When it pays, press **Paid: +1 month** (or **+1 year**) on the Accounts page and it can sign in again.
- **You see every gym.** The Accounts page shows each gym's members, fees pending, money collected, first and last sign-in and the day its time ends. **Open** shows a gym exactly as the gym sees it. **Ask on WhatsApp** sends the gym a payment reminder.

## Try it on your computer

You need Node.js 20.12 or newer.

```bash
npm install
```

Copy `.env.example` to `.env`, and set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (your own owner login; it lives only in `.env`, not in the database). Then:

```bash
npm start
```

Open http://localhost:3000 and sign in as the owner. On **Accounts** add a gym, then sign in as that gym (or press **Open**). Fill in the gym's details and prices on **Settings**, then press **New member by voice**.

Voice needs Chrome or Edge, and the microphone must be allowed for the site. Other browsers still work by typing the answers.

```bash
npm test
```

runs the checks on a temporary folder. It never touches your data, Google or WhatsApp.

```bash
node test.js mongo
```

runs the same checks on the MongoDB named in `.env`, in a separate database (`gymsaathi_test`) that is deleted at the end. Run it once after you set `MONGODB_URI`, to know the database works.

## Where the data is kept

With `MONGODB_URI` set, in a MongoDB database called `gymsaathi`:

| Collection | One document per |
|---|---|
| `gyms` | gym: its login, details, prices, first and last sign-in, the day its time ends, and each time it paid you |
| `customers` | member of a gym |
| `memberships` | period a member bought. Only ever added, never changed |
| `transactions` | payment received from a member. Only ever added |
| `sessions` | signed-in device |

Without `MONGODB_URI` the same five are JSON files in `DATA_DIR`.

## Put it online for free

1. **Database:** make a free cluster on [MongoDB Atlas](https://www.mongodb.com/atlas), create a database user, allow access from anywhere, and copy the connection string.
2. **AI key:** make a free key in [Google AI Studio](https://aistudio.google.com/apikey).
3. **Hosting:** on [Render](https://render.com), create a free Web Service from this repository. Build command `npm install`, start command `npm start`.
4. In Render's **Environment** tab set:

   | Name | Value |
   |---|---|
   | `ADMIN_EMAIL` | your owner login |
   | `ADMIN_PASSWORD` | a long password |
   | `MONGODB_URI` | the Atlas connection string, with your database user's password in place of `<db_password>` |
   | `PAY_NOTE` | where a gym sends its ₹999, for example `UPI yourname@bank, or call 98290 00000` |
   | `GEMINI_API_KEY` | the Google key |
   | `COOKIE_SECURE` | `1` |
   | `TRUST_PROXY` | `1` |
   | `TZ` | `Asia/Kolkata` |

Never put these values in the code or in a file you upload. Without `MONGODB_URI` the data is kept in files, and a free host wipes those on every restart.

## WhatsApp reminders that send themselves

Without this, the gym owner taps Send for each reminder. With it, the server sends them at 6 in the morning through Meta's own WhatsApp Cloud API. All gyms' messages go from one WhatsApp number of yours; each message names the gym.

There is no monthly fee. Meta charges for each message delivered: about ₹0.12 for a reminder of this kind in India (check Meta's current rate card). No members, no cost.

1. **A phone number** that is not on WhatsApp now, and can get an SMS or a call. Once it is used here it cannot be used in the normal WhatsApp app.
2. **Create the app.** At developers.facebook.com: My Apps, Create App, type Business, then add the WhatsApp product. This also makes your Meta Business account and WhatsApp Business account.
3. **Add your number.** WhatsApp, API Setup: add the phone number, verify it by OTP, give it a display name (GymSaathi). Copy the **Phone number ID** shown there.
4. **Add a payment method** in WhatsApp Manager, under Payment settings.
5. **Create three message templates.** WhatsApp Manager, Message templates, Create. For each: category **Utility**, language **Hindi**, the exact name below, and the exact body below. Give any sample values it asks for. Approval takes minutes to a few hours.

   `gs_fees_pending`
   ```
   नमस्ते {{1}} जी, {{2}} की ओर से सूचना। आपने {{3}} को जिम जॉइन किया था और {{4}} की मेंबरशिप ली है, जो {{5}} तक है। आपकी फीस {{6}} बाकी है। कृपया जल्द जमा करवा दें। भुगतान: {{7}}। धन्यवाद।
   ```
   `gs_membership_expiring`
   ```
   नमस्ते {{1}} जी, {{2}} की ओर से सूचना। आपने {{3}} को जिम जॉइन किया था। आपकी {{4}} की मेंबरशिप {{5}} को खत्म हो रही है। बिना रुकावट जिम जारी रखने के लिए समय पर रिन्यू करवा लें। धन्यवाद।
   ```
   `gs_membership_expired`
   ```
   नमस्ते {{1}} जी, {{2}} की ओर से सूचना। आपने {{3}} को जिम जॉइन किया था। आपकी {{4}} की मेंबरशिप {{5}} को खत्म हो चुकी है। जिम जारी रखने के लिए कृपया रिन्यू करवा लें। धन्यवाद।
   ```
   The blanks are: 1 member's name, 2 gym's name, 3 joining date, 4 length of the membership, 5 its last day, 6 fee pending, 7 where to pay.
6. **Make a token that does not expire.** Business settings, Users, System users: add one as Admin, give it the app and the WhatsApp account with full control, then Generate token with `whatsapp_business_messaging` and `whatsapp_business_management`, expiry Never.
7. **Set these on the host** (Render, Environment): `WHATSAPP_TOKEN` (the token), `WHATSAPP_PHONE_ID` (from step 3), and `TZ` = `Asia/Kolkata` so that 6 o'clock is 6 in India.
8. **Wake the free host before 6.** A free Render service sleeps, and a sleeping server sends nothing. At cron-job.org (free) make a job that opens your site's address every day at 5:57 and 6:03, time zone Asia/Kolkata. A server woken later in the day sends then, up to 9 at night.

Good to know:

- Until Meta has verified your business you can message 250 different people a day. Verify it in Business settings to raise that.
- Members must have agreed to get WhatsApp messages from the gym. Ask at joining.
- A reminder that could not be sent (number not on WhatsApp, template not approved yet) stays on that gym's dashboard, where it can be sent by a tap. The server log says why it failed.
- A gym that is switched off, or whose time is over, sends nothing.
- Replies from members come to your number, not to the gym.
- The welcome message is always sent by a tap.

## What "free" means here

- **WhatsApp messages are sent by a tap unless you set up the section above.** Tapping costs nothing. Sending by themselves costs what Meta charges per message.
- **A free Render service sleeps** after 15 minutes without use. The first page after that takes up to a minute to open.
- **The free Gemini key has a daily limit.** When it is used up, or no key is set, the assistant still works: it then reads one answer per question instead of understanding a whole sentence.
- **MongoDB Atlas free tier** holds 512 MB, enough for many hundreds of gyms.

## Where things are

| File | What it holds |
|---|---|
| `server.js` | logins, the API, and serving the pages |
| `lib/core.js` | dates, fees, membership status, reminder rules and message text (shared with the browser) |
| `lib/ai.js` | the registration talk and the question answers |
| `lib/db.js` | storage: the five collections, as files or in MongoDB |
| `lib/whatsapp.js` | sending a template message through Meta's WhatsApp Cloud API |
| `public/` | the pages |
| `test.js` | the checks |
#   g y m S a a t h i  
 