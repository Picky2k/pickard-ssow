# Pickard SSOW & SOPs

The read-and-sign website for Pickard Event Services' Safe Systems of Work (SSOWs) and Standard Operating Procedures (SOPs).

- **Staff, sub-contractors and agency workers** go to the main address (for example `https://safety.pickardonline.co.uk`). They don't need an account: they enter their details, read each document for the minimum time, tick the declaration and sign. Their phone or tablet remembers them, and on another device they come back with their name and the last 3 digits of their mobile.
- **The office** goes to `/admin` (for example `https://safety.pickardonline.co.uk/admin`) to see sign-off records, people, licences and insurance, to add or update documents, and to download the spreadsheet.

It runs on Cloudflare's free plan:

| Part | Cloudflare product | What it holds |
|---|---|---|
| Website and server code | **Workers** | `public/` (the page) and `src/worker.js` (the server) |
| Database | **D1** | Documents, settings, people, sign-offs and signatures |
| File storage | **R2** (private) | Uploaded licences, insurance certificates and risk assessments |
| Admin login | **Access** (Zero Trust) | Who may open `/admin` |

The 22 current SSOWs/SOPs and your settings are built in, and they load automatically the first time the site runs. People who signed in the Claude version are **not** moved across.

---

## Setting it up (about 30 minutes)

### 1. Put the code on GitHub
If the files aren't already in `github.com/Picky2k/pickard-ssow`, open the repository, choose **Add file → Upload files**, drag in everything from this folder (including the `public` and `src` folders) and press **Commit changes**. Keep the repository **private**.

### 2. Create a Cloudflare account
Sign up at <https://dash.cloudflare.com>. The free plan is enough.

### 3. Create the database
1. In the Cloudflare dashboard, go to **Storage & databases → D1 SQL database → Create database**.
2. Name it `pickard-ssow` and press **Create**.
3. Copy the **Database ID**. It looks like `a1b2c3d4-…`.
4. In GitHub, open `wrangler.jsonc` and press the pencil icon to edit it. Replace `PASTE-YOUR-D1-DATABASE-ID-HERE` with the ID you copied, then press **Commit changes**.

You don't need to create any tables. The site creates them itself.

### 4. Create the file storage
1. Go to **Storage & databases → R2 object storage**. Cloudflare asks for a payment card the first time you turn on R2, even on the free allowance.
2. Press **Create bucket**, name it `pickard-uploads`, and leave everything else as it is. The bucket stays private: files can only be downloaded through the admin area.

### 5. Connect GitHub and deploy
1. Go to **Compute → Workers & Pages → Create → Import a repository**.
2. Connect your GitHub account and pick **Picky2k/pickard-ssow**.
3. Keep the project name **pickard-ssow**. It must match the name in `wrangler.jsonc`. Leave the build settings as they are (deploy command `npx wrangler deploy`) and press **Deploy**.
4. When it finishes you get an address like `https://pickard-ssow.<your-account>.workers.dev`. Open it and you should see the Read. Understand. Sign. page.

From now on, every change committed to GitHub is deployed automatically within a minute or two.

### 6. Give it your own address (recommended)
1. Your domain (for example `pickardonline.co.uk`) needs to be on Cloudflare: **Add a domain**, then follow the steps to change the nameservers at your registrar. **Check that your email (MX) records were copied across** before you switch, or email will stop.
2. Open the Worker, then go to **Settings → Domains & Routes → Add → Custom domain** and enter `safety.pickardonline.co.uk`.

### 7. Lock the admin area
You need **one** of these. Option B is better. Option A gets you going in two minutes.

**Option A: a shared admin password**
1. Open the Worker, then go to **Settings → Variables and Secrets → Add**.
2. Type: **Secret**. Name: `ADMIN_PASSWORD`. Value: a long password. Save.
3. Go to `/admin` and sign in with it. To change the password later, edit the secret.

**Option B: Cloudflare Access (each person logs in with their own work email)**
1. In the dashboard, open **Zero Trust**. The first time, choose a team name (for example `pickard`) and the **Free** plan.
2. Go to **Access → Applications → Add an application → Self-hosted**.
3. Add **two** public hostnames:
   - `safety.pickardonline.co.uk` with path `admin`
   - `safety.pickardonline.co.uk` with path `api/admin`
4. Add a policy: Action **Allow**, Include **Emails**, then list the people who should have admin access (for example `james@pickardonline.co.uk`, `matt@pickardonline.co.uk`).
5. Under login methods, make sure **One-time PIN** is on.
6. Save. Then open the application's **Overview** and copy the **Application Audience (AUD) Tag**.
7. Back on the Worker, go to **Settings → Variables and Secrets** and add two **Text** variables:
   - `ACCESS_TEAM_DOMAIN`: `pickard.cloudflareaccess.com` (use your own team name)
   - `ACCESS_AUD`: the AUD tag you copied
8. Open `/admin`. Cloudflare asks for your email, sends a code, and then lets you in.

Once you're using your own domain, turn off the `workers.dev` address under **Settings → Domains & Routes**. Admin data stays protected either way, because the server checks the Access login itself, but one address is tidier.

### 8. Check it works
1. On your phone, open the main address, register as a test sub-contractor, tick an activity, upload a test licence and sign one document.
2. In `/admin`, check the test person appears with the signed document, the licence and the PLI status, and that **Download spreadsheet** works.
3. Delete the test person on the **People** tab.
4. Share the address with your workforce, for example as a QR code on the noticeboard or in a WhatsApp group.

---

## Day to day

- **New or amended SSOW/SOP:** in `/admin → Documents`, drag in the Word files. Check the list, then press **Publish**. Raise the version number and everyone who signed the old one is asked to sign again. The **Email people** panel gives you the addresses and a ready-made message.
- **Reading speed and renewals:** `/admin → Settings`. The site starts at **600 words per minute**, which is what the Claude version was set to. 250 is a careful reading pace, so lower it if people are signing too quickly.
- **Office tablet:** open the main address. Each person taps **Finish & switch person** when they're done.
- **Backups:** download the spreadsheet regularly. D1 also keeps a restore history (**D1 → your database → Time Travel**).

## Changing the code
Edit files directly on GitHub (pencil icon) or ask Claude to make changes. Each commit to the `main` branch redeploys. Your documents and sign-offs live in the D1 database, so code updates don't touch them.

To run it on your own computer (optional, needs Node.js):
```
npm install
echo ADMIN_PASSWORD=test > .dev.vars
npm run dev        # then open http://localhost:8787 and http://localhost:8787/admin
```

## How it fits together

```
public/index.html   The whole page: staff screens and admin screens
public/logo.jpg     Company logo
src/worker.js       Server: API, database set-up, admin checks, file storage
src/seed.json       The SSOWs/SOPs and settings loaded into a new database
wrangler.jsonc      Cloudflare settings (database ID goes here)
```

**API summary** (all under `/api`):
- Staff: `GET bootstrap`, `POST people`, `GET/PATCH me`, `POST me/progress`, `POST me/sign`, `POST me/files`, `DELETE me/files/:id`, `POST return`
- Admin (Access or password): `GET admin/whoami`, `GET admin/people`, `DELETE admin/people/:id`, `GET admin/documents`, `PUT/DELETE admin/documents/:ref`, `PUT admin/settings`, `GET admin/files/:person/:file`

## Privacy
The site stores names, phone numbers, emails, signatures, and copies of driving licences, licence cards and insurance certificates. Uploads sit in a private R2 bucket and can only be downloaded through the admin area. Mention this in your privacy notice, decide how long you keep records for people who have left, and use **Delete** on the People tab to remove them. Deleting a person also deletes their uploaded files.
