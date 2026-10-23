# Pickard SSOW & SOPs

The read-and-sign website for Pickard Event Services' Safe Systems of Work (SSOWs) and Standard Operating Procedures (SOPs).

- **Staff, sub-contractors and agency workers** use the main address. They don't need an account: they enter their details, read each document for the minimum time, tick the declaration and sign. Their phone or tablet remembers them, and on another device they come back with their name and the last 3 digits of their mobile.
- **The office** uses the same address with `/admin` on the end to see sign-off records, people, licences and insurance, to add or update documents, and to download the spreadsheet.

It runs on Cloudflare's free plan. Cloudflare creates the database automatically, and the 22 current SSOWs/SOPs and your settings load the first time the site runs.

---

## Setting it up: a step-by-step guide for beginners

You need about 20 minutes, your GitHub login (Picky2k) and an email address. No payment card is needed.

### Step 0: Clear up any earlier attempt (skip this if it's your first go)
In the Cloudflare dashboard:
1. Click **Workers & Pages** in the left menu. If **pickard-ssow** is listed, click it, go to **Settings**, scroll to the bottom, click **Delete** and confirm.
2. Click **Storage & databases → D1 SQL database**. If **pickard-ssow** is listed, click the **⋯** at the end of its row, choose **Delete** and confirm. It's empty, so nothing is lost.
3. If you created an R2 bucket called **pickard-uploads**, you can delete it too. It's no longer used.

### Step 1: Create a free Cloudflare account
1. Go to **https://dash.cloudflare.com/sign-up**.
2. Enter your email and a password, then confirm the email Cloudflare sends you.
3. If it asks what you want to do, choose anything or skip. You'll end up on the dashboard **Account home** page.

### Step 2: Put the website on Cloudflare, straight from GitHub
1. In the left menu, click **Workers & Pages**. It may be under **Compute (Workers)**.
2. Click the blue **Create application** button (top right).
3. Find **Import a repository** and click **Get started** next to it.
4. Click **Connect GitHub**, or choose GitHub as the **Git account**. A GitHub window opens:
   - Sign in as **Picky2k** if asked.
   - Choose **Only select repositories**, pick **pickard-ssow**, then click **Install & Authorize**.
5. Back in Cloudflare, click **pickard-ssow** in the list of repositories.
6. On the settings page:
   - **Project name:** it must be exactly `pickard-ssow`.
   - Leave **Build command** blank and **Deploy command** as `npx wrangler deploy`.
   - Leave everything else as it is.
7. Click **Create and deploy** (or **Save and Deploy**).
8. Wait 1–3 minutes while it builds. When it says **Success**, it shows your website address, something like `https://pickard-ssow.yourname.workers.dev`. Copy it somewhere safe.

### Step 3: Check it's working
1. Open your address with `/api/health` on the end, for example `https://pickard-ssow.yourname.workers.dev/api/health`.
2. You should see a line of text containing `"database":"connected"`, `"documents":22` and `"adminAccess":"NOT SET UP..."`. That's correct for now. After Step 4 it says `"protected by admin password"`.
3. Open the main address (without `/api/health`). You should see the Pickard logo and **Read. Understand. Sign.**

**If the build failed or the health check shows an error,** see [Problems](#problems) below.

### Step 4: Set the admin password
1. In Cloudflare, go to **Workers & Pages** and click **pickard-ssow**.
2. Click the **Settings** tab, then find **Variables and Secrets** and click **+ Add**.
3. Fill in:
   - **Type:** `Secret`
   - **Variable name:** `ADMIN_PASSWORD`, typed exactly like that in capitals
   - **Value:** a strong password that you and Mathew will use, for example three random words and a number
4. Click **Deploy** (or **Save and deploy**).
5. Open your address with `/admin` on the end. Type the password and you're in.

### Step 5: Try it out
1. On your phone, open the main address. Register as a test sub-contractor, tick **Van driving**, upload any photo as a test licence, and read and sign one document.
2. On your computer, open `/admin`. Your test person should appear with the signed document. Try **Download spreadsheet (.xlsx)**.
3. On the **People** tab, delete the test person.
4. Share the main address with your workforce, for example as a QR code on the noticeboard or in a WhatsApp group.

That's it: the system is live.

---

## Later, optional: a nicer address and named logins

**Your own address (for example `safety.pickardonline.co.uk`)**
This needs your domain to be managed by Cloudflare, which means changing nameservers at your domain registrar. Check your email (MX) records are copied across first, or email will stop. Once the domain is on Cloudflare, go to **Workers & Pages → pickard-ssow → Settings → Domains & Routes → + Add → Custom domain** and type `safety.pickardonline.co.uk`.

**Named admin logins with an emailed code (Cloudflare Access)**
Once the site is on your own address, you can replace the shared password with per-person logins:
1. **Zero Trust → Access controls → Applications → Create new application → Self-hosted and private.**
2. Add two public hostnames: `safety.pickardonline.co.uk` with path `admin`, and the same with path `api/admin`.
3. Policy: **Allow**, **Emails**, then list the admin addresses. Login method: **One-time PIN**.
4. Copy the application's **AUD tag**. On the Worker, add two **Text** variables: `ACCESS_AUD` (the tag) and `ACCESS_TEAM_DOMAIN` (for example `pickard.cloudflareaccess.com`, shown under **Zero Trust → Settings**).

---

## Problems

**The build failed and the log mentions the database (D1)**
Cloudflare normally creates the database itself. If it couldn't:
1. Go to **Storage & databases → D1 SQL database → Create database**, name it `pickard-ssow`, and click **Create**.
2. Copy its **Database ID**.
3. On GitHub, open `wrangler.jsonc` and click the pencil icon. Under `"database_name": "pickard-ssow"`, add a comma and a new line `"database_id": "PASTE-ID-HERE"`, then click **Commit changes**. Cloudflare rebuilds automatically.

**"The website isn't connected to its database yet"**
Same fix as above.

**The build failed with "name mismatch" or similar**
The project name in Cloudflare must be `pickard-ssow`. Delete the Worker (Step 0) and import it again.

**`/admin` says "Admin access isn't set up yet"**
Do Step 4. Check the variable name is exactly `ADMIN_PASSWORD` and that you clicked **Deploy** afterwards.

**I forgot the admin password**
Repeat Step 4 with a new value. It replaces the old one.

---

## Day to day

- **New or amended SSOW/SOP:** in `/admin → Documents`, drag in the Word files, check the list, then click **Publish**. Raise the version number and everyone who signed the old one is asked to sign again. The **Email people** panel gives you the addresses and a ready-made message.
- **Reading speed and renewals:** `/admin → Settings`. The site starts at **600 words per minute**, which is what the Claude version was set to. 250 is a careful reading pace.
- **Office tablet:** open the main address. Each person taps **Finish & switch person** when done.
- **Backups:** download the spreadsheet regularly. Cloudflare also keeps a restore history of the database (**Storage & databases → D1 → pickard-ssow → Time Travel**).
- **Changing the website:** edit files on GitHub, or ask Claude to. Every change on the `main` branch redeploys within a couple of minutes. Documents and sign-offs live in the database, so code changes don't touch them.

## What's in this repository

```
public/index.html   The whole page: staff screens and admin screens
public/logo.jpg     Company logo
src/worker.js       Server: API, database set-up, admin checks, file storage
src/seed.json       The SSOWs/SOPs and settings loaded into a new database
wrangler.jsonc      Cloudflare settings (no changes needed)
```

To run it on your own computer (optional, needs Node.js): `npm install`, create a file `.dev.vars` containing `ADMIN_PASSWORD=test`, then `npm run dev` and open http://localhost:8787.

## Privacy
The site stores names, phone numbers, emails, signatures, and copies of licences and insurance certificates. Uploaded files can only be downloaded through the admin area. Mention this in your privacy notice, decide how long you keep records for people who have left, and use **Delete** on the People tab to remove them. Deleting a person also deletes their uploaded files.
