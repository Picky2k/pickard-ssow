/**
 * Pickard SSOW & SOPs: Cloudflare Worker
 *
 * Serves the website (from /public) and a small JSON API backed by:
 *   DB    – Cloudflare D1 database (documents, settings, people, sign-offs)
 *   (uploaded licences, PLI certificates and risk assessments are stored in the same database, in pieces)
 *
 * Staff:  https://<site>/        – no login; each person gets a private token stored on their device
 * Office: https://<site>/admin   – protected by Cloudflare Access (recommended) or an ADMIN_PASSWORD secret
 *
 * Tables are created automatically on first use, and the SSOWs/SOPs in seed.json
 * are loaded once into an empty database.
 */
import SEED from "./seed.json";
const SEED_DOCUMENTS = SEED.documents;

const DEFAULT_SETTINGS = { wpm: 250, idleSec: 60, renewalMonths: 12, dueSoonDays: 30 };
const MAX_UPLOAD = 10 * 1024 * 1024;
const UPLOAD_TYPES = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
const PERSON_TYPES = ["employee", "subcontractor", "agency"];
const ACTIVITY_IDS = ["truck", "van", "forklift", "mewp", "electrical", "shell"];
const FILE_KINDS = ["pli", "ra", ...ACTIVITY_IDS.map((a) => "lic-" + a)];

/* ------------------------------------------------------------------ database setup */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS documents (ref TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name_norm TEXT, phone3 TEXT, json TEXT NOT NULL, created_at TEXT, updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS people_name ON people (name_norm)`,
  `CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, person_id TEXT NOT NULL, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS tokens_person ON tokens (person_id)`,
  `CREATE TABLE IF NOT EXISTS attempts (ip TEXT NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS file_parts (person_id TEXT NOT NULL, fid TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (person_id, fid, part))`,
];
let ready = null;
function ensureDb(env) {
  if (!ready) {
    ready = (async () => {
      await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
      const seeded = await env.DB.prepare("SELECT json FROM settings WHERE id = 'seeded'").first();
      if (!seeded) {
        const now = new Date().toISOString();
        const stmts = SEED_DOCUMENTS.map((d) =>
          env.DB.prepare("INSERT OR IGNORE INTO documents (ref, json, updated_at) VALUES (?, ?, ?)").bind(d.ref, JSON.stringify(d), d.updatedAt || now));
        stmts.push(env.DB.prepare("INSERT OR IGNORE INTO settings (id, json) VALUES ('main', ?)").bind(JSON.stringify({ ...DEFAULT_SETTINGS, ...(SEED.settings || {}) })));
        stmts.push(env.DB.prepare("INSERT OR REPLACE INTO settings (id, json) VALUES ('seeded', ?)").bind(JSON.stringify({ at: now, count: SEED_DOCUMENTS.length })));
        await env.DB.batch(stmts);
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/* ------------------------------------------------------------------ helpers */
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers } });
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const bad = (msg) => { throw new HttpError(400, msg); };

async function readJson(request, limit = 600_000) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > limit) throw new HttpError(413, "That is too large to save.");
  try { return await request.json(); } catch { bad("The request wasn't valid."); }
}
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const normName = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z\s'-]/g, "").replace(/[\s'-]+/g, " ").trim();
const digits = (s) => String(s || "").replace(/\D/g, "");
function randomHex(bytes = 32) { const a = crypto.getRandomValues(new Uint8Array(bytes)); return [...a].map((b) => b.toString(16).padStart(2, "0")).join(""); }
async function sha256(text) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function timingSafeEqual(a, b) { a = String(a); b = String(b); let r = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return r === 0; }
function addMonths(iso, m) { const d = new Date(iso); const day = d.getDate(); d.setMonth(d.getMonth() + Number(m || 12)); if (d.getDate() < day) d.setDate(0); return d.toISOString(); }
const wordCount = (html) => String(html || "").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;

async function getSettings(env) {
  const row = await env.DB.prepare("SELECT json FROM settings WHERE id = 'main'").first();
  return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.json) : {}) };
}
async function getDocuments(env) {
  const { results } = await env.DB.prepare("SELECT json FROM documents").all();
  return results.map((r) => JSON.parse(r.json));
}
async function getDocument(env, ref) {
  const row = await env.DB.prepare("SELECT json FROM documents WHERE ref = ?").bind(ref).first();
  return row ? JSON.parse(row.json) : null;
}
function requiredSec(doc, settings) {
  return doc.minMinutes ? Math.round(Number(doc.minMinutes) * 60)
    : Math.max(60, Math.round(((doc.words || wordCount(doc.html)) / (Number(settings.wpm) || 250)) * 60));
}

/* people */
async function loadPerson(env, id) {
  const row = await env.DB.prepare("SELECT json FROM people WHERE id = ?").bind(id).first();
  return row ? JSON.parse(row.json) : null;
}
async function savePerson(env, id, p) {
  p.updatedAt = new Date().toISOString();
  await env.DB.prepare("UPDATE people SET json = ?, name_norm = ?, phone3 = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(p), normName(p.name), digits(p.phone).slice(-3), p.updatedAt, id).run();
  return p;
}
const publicPerson = (id, p) => ({ key: id, ...p });
async function issueToken(env, personId) {
  const token = randomHex(32);
  await env.DB.prepare("INSERT INTO tokens (hash, person_id, created_at) VALUES (?, ?, ?)").bind(await sha256(token), personId, new Date().toISOString()).run();
  return token;
}
async function personFromToken(request, env) {
  const token = request.headers.get("x-person-token");
  if (!token || token.length < 32) throw new HttpError(401, "Please enter your details again.");
  const row = await env.DB.prepare("SELECT person_id FROM tokens WHERE hash = ?").bind(await sha256(token)).first();
  if (!row) throw new HttpError(401, "Please enter your details again.");
  const p = await loadPerson(env, row.person_id);
  if (!p) throw new HttpError(401, "Please enter your details again.");
  return { id: row.person_id, p };
}
function cleanProfile(body, existing = {}) {
  const type = PERSON_TYPES.includes(body.type) ? body.type : existing.type || "employee";
  const p = {
    type,
    name: str(body.name ?? existing.name, 120),
    company: type === "employee" ? "Pickard Event Services" : str(body.company ?? existing.company, 160),
    role: str(body.role ?? existing.role, 120),
    email: str(body.email ?? existing.email, 200),
    phone: str(body.phone ?? existing.phone, 40),
    activities: Array.isArray(body.activities) ? [...new Set(body.activities.filter((a) => ACTIVITY_IDS.includes(a)))] : existing.activities || [],
  };
  if (!p.name || normName(p.name).split(" ").length < 2) bad("Enter your full name (first name and surname).");
  if (type !== "employee" && !p.company) bad(type === "agency" ? "Enter the name of your agency." : "Enter your company name.");
  if (!p.role) bad("Enter your role.");
  if (digits(p.phone).length < 10) bad("Enter your full mobile number.");
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) bad("That email address doesn't look right.");
  return p;
}

/* ------------------------------------------------------------------ admin authentication */
let jwks = null, jwksAt = 0;
const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
async function verifyAccessJwt(token, env) {
  const team = String(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const [h, p, s] = String(token).split(".");
  if (!h || !p || !s) return null;
  const header = b64urlToJson(h), payload = b64urlToJson(p);
  if (!jwks || Date.now() - jwksAt > 3600_000 || !jwks.keys?.some((k) => k.kid === header.kid)) {
    const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
    if (!r.ok) return null;
    jwks = await r.json(); jwksAt = Date.now();
  }
  const jwk = jwks.keys?.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  if (payload.iss && payload.iss !== `https://${team}`) return null;
  return { email: payload.email || "", via: "access" };
}
function cookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
async function adminIdentity(request, env) {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const t = request.headers.get("cf-access-jwt-assertion") || cookie(request, "CF_Authorization");
    if (t) { try { const who = await verifyAccessJwt(t, env); if (who) return who; } catch {} }
  }
  if (env.ADMIN_PASSWORD) {
    let given = request.headers.get("x-admin-password");
    if (given) { try { given = decodeURIComponent(given); } catch {} }
    // ignore stray spaces or line breaks pasted into either the dashboard or the login box
    if (given && timingSafeEqual(given.trim(), String(env.ADMIN_PASSWORD).trim())) return { email: "", via: "password" };
  }
  return null;
}
function adminMode(env) {
  return env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD ? (env.ADMIN_PASSWORD ? "access+password" : "access") : env.ADMIN_PASSWORD ? "password" : "none";
}

/* ------------------------------------------------------------------ file storage (in D1, as base64 pieces) */
const PART_CHARS = 900_000; // keeps each database row well under D1's 2 MB limit
function bytesToB64(bytes) { let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); }
function b64ToBytes(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
async function putFile(env, personId, fid, bytes) {
  const b64 = bytesToB64(bytes); const stmts = [];
  for (let i = 0, part = 0; i < b64.length || part === 0; i += PART_CHARS, part++)
    stmts.push(env.DB.prepare("INSERT INTO file_parts (person_id, fid, part, data) VALUES (?, ?, ?, ?)").bind(personId, fid, part, b64.slice(i, i + PART_CHARS)));
  await env.DB.batch(stmts);
}
async function getFile(env, personId, fid) {
  const { results } = await env.DB.prepare("SELECT data FROM file_parts WHERE person_id = ? AND fid = ? ORDER BY part").bind(personId, fid).all();
  return results.length ? b64ToBytes(results.map((r) => r.data).join("")) : null;
}
const deleteFile = (env, personId, fid) => env.DB.prepare("DELETE FROM file_parts WHERE person_id = ? AND fid = ?").bind(personId, fid).run();

/* ------------------------------------------------------------------ rate limiting (return-by-name) */
async function checkAttempts(env, ip) {
  const since = Date.now() - 15 * 60_000;
  await env.DB.prepare("DELETE FROM attempts WHERE ts < ?").bind(since).run();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE ip = ? AND ts >= ?").bind(ip, since).first();
  if ((row?.n || 0) >= 8) throw new HttpError(429, "Too many attempts. Try again in 15 minutes, or ask the office.");
}
const recordAttempt = (env, ip) => env.DB.prepare("INSERT INTO attempts (ip, ts) VALUES (?, ?)").bind(ip, Date.now()).run();

/* ------------------------------------------------------------------ API: staff */
async function apiBootstrap(env) {
  const [docs, settings] = await Promise.all([getDocuments(env), getSettings(env)]);
  return json({ documents: docs.filter((d) => d.active !== false), settings });
}
async function apiCreatePerson(request, env) {
  const body = await readJson(request, 20_000);
  const prof = cleanProfile(body);
  const id = "p_" + randomHex(10); const now = new Date().toISOString();
  const p = { ...prof, createdAt: now, updatedAt: now, records: {}, progress: {}, files: {} };
  await env.DB.prepare("INSERT INTO people (id, name_norm, phone3, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, normName(p.name), digits(p.phone).slice(-3), JSON.stringify(p), now, now).run();
  const token = await issueToken(env, id);
  return json({ token, person: publicPerson(id, p) }, 201);
}
async function apiUpdateMe(request, env) {
  const { id, p } = await personFromToken(request, env);
  const body = await readJson(request, 20_000);
  Object.assign(p, cleanProfile(body, p));
  return json({ person: publicPerson(id, await savePerson(env, id, p)) });
}
async function apiProgress(request, env) {
  const { id, p } = await personFromToken(request, env);
  const b = await readJson(request, 5_000);
  const ref = str(b.ref, 40);
  if (!ref) bad("Missing document.");
  p.progress = p.progress || {};
  const prev = p.progress[ref];
  const sec = Math.max(0, Math.min(86400, Math.round(Number(b.sec) || 0)));
  if (prev && String(prev.version) === String(b.version) && prev.sec > sec) return json({ ok: true }); // never go backwards
  p.progress[ref] = { sec, reachedEnd: !!b.reachedEnd, firstEndSec: b.firstEndSec == null ? null : Math.round(Number(b.firstEndSec)), version: str(b.version, 20), at: new Date().toISOString() };
  await savePerson(env, id, p);
  return json({ ok: true });
}
async function apiSign(request, env) {
  const { id, p } = await personFromToken(request, env);
  const b = await readJson(request, 200_000);
  const doc = await getDocument(env, str(b.ref, 40));
  if (!doc || doc.active === false) throw new HttpError(404, "That document is no longer issued.");
  if (String(b.version) !== String(doc.version)) throw new HttpError(409, "This document has just been updated. Go back to the list and open it again.");
  const settings = await getSettings(env);
  const req = requiredSec(doc, settings);
  const activeSec = Math.round(Number(b.activeSec) || 0);
  if (activeSec < req - 5) bad("The minimum reading time hasn't been reached yet.");
  if (!b.declaration) bad("Tick the declaration to confirm.");
  const sig = String(b.sig || "");
  if (sig.length < 10 || sig.length > 150_000 || !/^[ML0-9 .\-]+$/.test(sig)) bad("Sign in the box before pressing Sign.");
  const now = new Date().toISOString();
  const record = { ref: doc.ref, title: doc.title, version: String(doc.version), signedAt: now,
    renewsAt: addMonths(now, doc.renewalMonths || settings.renewalMonths), activeSec, requiredSec: req,
    firstEndSec: b.firstEndSec == null ? null : Math.round(Number(b.firstEndSec)),
    skimmed: b.firstEndSec != null && Number(b.firstEndSec) < req * 0.25, sig, declaration: true };
  p.records = { ...(p.records || {}), [doc.ref]: record };
  p.progress = { ...(p.progress || {}), [doc.ref]: { sec: 0, reachedEnd: false, firstEndSec: null, version: String(doc.version), at: now } };
  p.lastSig = sig;
  await savePerson(env, id, p);
  return json({ record, person: publicPerson(id, p) });
}
async function apiUpload(request, env) {
  const { id, p } = await personFromToken(request, env);
  if (Number(request.headers.get("content-length") || 0) > MAX_UPLOAD + 200_000) throw new HttpError(413, "That file is over 10 MB.");
  let form; try { form = await request.formData(); } catch { bad("The upload wasn't valid."); }
  const file = form.get("file"); const kind = str(form.get("kind"), 30);
  let meta = {}; try { meta = JSON.parse(form.get("meta") || "{}"); } catch {}
  if (!file || typeof file === "string") bad("Choose a file to upload.");
  if (!FILE_KINDS.includes(kind)) bad("Unknown upload type.");
  if (kind === "pli" && p.type !== "subcontractor") bad("Only sub-contractors upload insurance certificates.");
  if (kind === "ra" && p.type !== "subcontractor") bad("Only sub-contractors upload risk assessments.");
  if (kind.startsWith("lic-") && !(p.activities || []).includes(kind.slice(4))) bad("Tick that activity in your details first.");
  if (file.size > MAX_UPLOAD) throw new HttpError(413, "That file is over 10 MB.");
  const ext = (String(file.name).match(/\.([a-z0-9]{2,5})$/i)?.[1] || "").toLowerCase();
  if (!UPLOAD_TYPES[ext]) bad("Use a PDF, a JPG or PNG photo, or a Word .docx file.");
  const fid = "f" + Date.now().toString(36) + randomHex(3);
  const m = { kind, name: str(file.name, 160), mime: UPLOAD_TYPES[ext], size: file.size, uploadedAt: new Date().toISOString() };
  if (kind === "pli") Object.assign(m, { insurer: str(meta.insurer, 120), policyNo: str(meta.policyNo, 80), cover: str(meta.cover, 60), expiry: str(meta.expiry, 10) });
  else if (kind === "ra") Object.assign(m, { title: str(meta.title, 160), raDate: str(meta.raDate, 10) });
  else Object.assign(m, { title: str(meta.title, 160), licNo: str(meta.licNo, 80), expiry: str(meta.expiry, 10) });
  if ((kind === "pli" || (kind.startsWith("lic-") && kind !== "lic-electrical")) && !/^\d{4}-\d{2}-\d{2}$/.test(m.expiry)) bad("Enter the expiry date.");
  await putFile(env, id, fid, new Uint8Array(await file.arrayBuffer()));
  p.files = { ...(p.files || {}), [fid]: m };
  await savePerson(env, id, p);
  return json({ person: publicPerson(id, p) }, 201);
}
async function apiDeleteMyFile(request, env, fid) {
  const { id, p } = await personFromToken(request, env);
  if (!p.files?.[fid]) throw new HttpError(404, "File not found.");
  p.files[fid] = { ...p.files[fid], deleted: true, deletedAt: new Date().toISOString() };
  await deleteFile(env, id, fid);
  await savePerson(env, id, p);
  return json({ person: publicPerson(id, p) });
}
async function apiReturn(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "local";
  await checkAttempts(env, ip);
  const b = await readJson(request, 2_000);
  const n = normName(b.name); const pin = digits(b.pin);
  if (n.split(" ").length < 2) bad("Enter your first name and surname.");
  if (pin.length !== 3) bad("Enter the last three numbers of your mobile.");
  const t = n.split(" ");
  const { results } = await env.DB.prepare("SELECT id, json, name_norm FROM people WHERE phone3 = ?").bind(pin).all();
  let matches = results.filter((r) => r.name_norm === n);
  if (!matches.length) matches = results.filter((r) => { const q = (r.name_norm || "").split(" "); return q[0] === t[0] && q[q.length - 1] === t[t.length - 1]; });
  if (b.id) matches = matches.filter((r) => r.id === b.id);
  if (!matches.length) { await recordAttempt(env, ip); throw new HttpError(404, "We couldn't find a record with that name and mobile number. Check both, or start as a new person."); }
  if (matches.length > 1) {
    return json({ matches: matches.map((r) => { const p = JSON.parse(r.json); return { key: r.id, name: p.name, type: p.type, role: p.role, company: p.company }; }) });
  }
  const token = await issueToken(env, matches[0].id);
  return json({ token, person: publicPerson(matches[0].id, JSON.parse(matches[0].json)) });
}

/* ------------------------------------------------------------------ API: admin */
async function apiAdminPeople(env) {
  const { results } = await env.DB.prepare("SELECT id, json FROM people ORDER BY name_norm").all();
  return json({ people: results.map((r) => publicPerson(r.id, JSON.parse(r.json))) });
}
async function apiAdminDeletePerson(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM file_parts WHERE person_id = ?").bind(id),
    env.DB.prepare("DELETE FROM tokens WHERE person_id = ?").bind(id),
    env.DB.prepare("DELETE FROM people WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}
async function apiAdminPutDocument(request, env, ref) {
  const d = await readJson(request, 1_500_000);
  if (!/^[A-Z0-9][A-Z0-9_.-]{0,40}$/.test(ref) || d.ref !== ref) bad("Document reference doesn't match.");
  if (!d.title || !d.version || !d.html) bad("A document needs a title, version and content.");
  d.updatedAt = new Date().toISOString();
  d.words = d.words || wordCount(d.html);
  await env.DB.prepare("INSERT INTO documents (ref, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(ref) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at")
    .bind(ref, JSON.stringify(d), d.updatedAt).run();
  return json({ document: d });
}
async function apiAdminFile(env, id, fid) {
  const p = await loadPerson(env, id);
  const m = p?.files?.[fid];
  if (!m || m.deleted) throw new HttpError(404, "File not found.");
  const bytes = await getFile(env, id, fid);
  if (!bytes) throw new HttpError(404, "File not found.");
  return new Response(bytes, { headers: {
    "content-type": m.mime || "application/octet-stream", "cache-control": "private, no-store",
    "content-disposition": `attachment; filename="${String(m.name).replace(/[^\w.\- ()]/g, "_")}"`,
  } });
}

/* ------------------------------------------------------------------ router */
async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, ""); const method = request.method;
  await ensureDb(env);

  if (path === "/api/health") {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM documents").first();
    return json({ ok: true, database: "connected", documents: n?.n || 0, adminAccess: adminMode(env) === "none" ? "NOT SET UP - add the ADMIN_PASSWORD secret" : adminMode(env) === "password" ? "protected by admin password" : "protected by Cloudflare Access" });
  }
  if (path === "/api/bootstrap" && method === "GET") return apiBootstrap(env);
  if (path === "/api/people" && method === "POST") return apiCreatePerson(request, env);
  if (path === "/api/me" && method === "GET") { const { id, p } = await personFromToken(request, env); return json({ person: publicPerson(id, p) }); }
  if (path === "/api/me" && method === "PATCH") return apiUpdateMe(request, env);
  if (path === "/api/me/progress" && method === "POST") return apiProgress(request, env);
  if (path === "/api/me/sign" && method === "POST") return apiSign(request, env);
  if (path === "/api/me/files" && method === "POST") return apiUpload(request, env);
  let m = path.match(/^\/api\/me\/files\/([\w-]+)$/);
  if (m && method === "DELETE") return apiDeleteMyFile(request, env, m[1]);
  if (path === "/api/return" && method === "POST") return apiReturn(request, env);

  if (path.startsWith("/api/admin")) {
    const who = await adminIdentity(request, env);
    if (!who) return fail(401, "Sign in to the admin area.", { mode: adminMode(env) });
    if (path === "/api/admin/whoami") return json({ email: who.email, via: who.via, mode: adminMode(env) });
    if (path === "/api/admin/people" && method === "GET") return apiAdminPeople(env);
    m = path.match(/^\/api\/admin\/people\/([\w-]+)$/);
    if (m && method === "DELETE") return apiAdminDeletePerson(env, m[1]);
    if (path === "/api/admin/documents" && method === "GET") return json({ documents: await getDocuments(env) });
    m = path.match(/^\/api\/admin\/documents\/([\w.-]+)$/);
    if (m && method === "PUT") return apiAdminPutDocument(request, env, m[1]);
    if (m && method === "DELETE") { await env.DB.prepare("DELETE FROM documents WHERE ref = ?").bind(m[1]).run(); return json({ ok: true }); }
    if (path === "/api/admin/settings" && method === "PUT") {
      const b = await readJson(request, 5_000);
      const s = { wpm: Number(b.wpm) || 250, idleSec: Number(b.idleSec) || 60, renewalMonths: Number(b.renewalMonths) || 12, dueSoonDays: Number(b.dueSoonDays) || 30 };
      await env.DB.prepare("INSERT OR REPLACE INTO settings (id, json) VALUES ('main', ?)").bind(JSON.stringify(s)).run();
      return json({ settings: s });
    }
    m = path.match(/^\/api\/admin\/files\/([\w-]+)\/([\w-]+)$/);
    if (m && method === "GET") return apiAdminFile(env, m[1], m[2]);
  }
  return fail(404, "Not found.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!env.DB) return fail(500, "The website isn't connected to its database yet. See step 3 in the README.");
      try { return await handleApi(request, env, url); }
      catch (e) {
        if (e instanceof HttpError) return fail(e.status, e.message, e.extra);
        console.error(e);
        return fail(500, "Something went wrong on the server. Please try again.");
      }
    }
    // The admin area is the same single page; /admin and anything under it loads it.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return env.ASSETS.fetch(new Request(new URL("/", url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
