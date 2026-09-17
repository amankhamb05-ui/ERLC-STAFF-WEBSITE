require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const requiredEnv = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_REDIRECT_URI",
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID"
];

const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length) {
  console.warn("Missing environment variables:", missing.join(", "));
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost")
    ? { rejectUnauthorized: false }
    : false
});

app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);
app.use(express.static(path.join(__dirname, "public")));

const roleIds = (name) =>
  (process.env[name] || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

async function discordRequest(endpoint, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`Discord API ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }

  return data;
}

async function getGuildMember(userId) {
  return discordRequest(
    `/guilds/${process.env.DISCORD_GUILD_ID}/members/${userId}`
  );
}

function getAccess(member) {
  const roles = new Set(member?.roles || []);
  const isManagement = roleIds("MANAGEMENT_ROLE_IDS").some((id) => roles.has(id));
  const isSupervisor = roleIds("SUPERVISOR_ROLE_IDS").some((id) => roles.has(id));
  const isStaff = roleIds("STAFF_ROLE_IDS").some((id) => roles.has(id));

  return {
    isStaff: isStaff || isSupervisor || isManagement,
    isSupervisor: isSupervisor || isManagement,
    isManagement
  };
}

async function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/");

  try {
    req.member = await getGuildMember(req.session.user.id);
    req.access = getAccess(req.member);

    if (!req.access.isStaff) {
      return res.status(403).send(page("Access denied", `
        <div class="card center">
          <div class="big-icon">🔒</div>
          <h1>Staff access required</h1>
          <p>You are logged in with Discord, but you do not have a staff role in this server.</p>
          <a class="button secondary" href="/logout">Log out</a>
        </div>
      `));
    }

    next();
  } catch (error) {
    console.error(error);
    res.status(500).send(page("Error", `<div class="card"><h1>Something went wrong</h1><p>Could not verify your Discord server membership.</p></div>`));
  }
}

function requireSupervisor(req, res, next) {
  if (!req.access?.isSupervisor) {
    return res.status(403).send(page("Access denied", `
      <div class="card center">
        <div class="big-icon">🛡️</div>
        <h1>Supervisor access required</h1>
        <p>You need a supervisor or management role to access this page.</p>
      </div>
    `));
  }
  next();
}

function requireManagement(req, res, next) {
  if (!req.access?.isManagement) {
    return res.status(403).send(page("Access denied", `
      <div class="card center">
        <div class="big-icon">🔐</div>
        <h1>Management access required</h1>
        <p>You need a management role to access this page.</p>
      </div>
    `));
  }
  next();
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_profiles (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS loas (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      reason TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      review_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS punishments (
      id BIGSERIAL PRIMARY KEY,
      staff_user_id TEXT NOT NULL,
      staff_username TEXT NOT NULL,
      target_username TEXT NOT NULL,
      target_roblox_id TEXT,
      punishment_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence_url TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function avatarUrl(user) {
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  }
  const index = Number(BigInt(user.id) % 5n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-AU", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function formatMinutes(minutes) {
  minutes = Math.max(0, Number(minutes) || 0);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

function page(title, body, user = null, access = null) {
  const nav = user
    ? `
      <nav>
        <a href="/dashboard" class="brand">ER:LC <span>STAFF</span></a>
        <div class="nav-links">
          <a href="/dashboard">Dashboard</a>
          <a href="/loa">LOA</a>
          <a href="/punishments">Punishments</a>
          ${access?.isSupervisor ? '<a href="/admin/loas">LOA Review</a>' : ""}
          ${access?.isManagement ? '<a href="/admin/punishments">Manage</a>' : ""}
          <a href="/logout">Logout</a>
        </div>
      </nav>`
    : `
      <nav>
        <a href="/" class="brand">ER:LC <span>STAFF</span></a>
      </nav>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} • ER:LC Staff</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
${nav}
<main>${body}</main>
<footer>ER:LC Staff Management • Staff Portal</footer>
</body>
</html>`;
}

app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");

  res.send(page("Staff Portal", `
    <section class="hero">
      <div class="hero-badge">ER:LC STAFF MANAGEMENT</div>
      <h1>Manage your staff duties in one place.</h1>
      <p>Clock in, request LOA, track shifts and log punishments through your Discord staff account.</p>
      <a class="button discord" href="/auth/discord">Login with Discord</a>
    </section>

    <section class="grid three">
      <div class="card"><div class="icon">⏱️</div><h3>Shift Management</h3><p>Start and end your shift and keep a record of your hours.</p></div>
      <div class="card"><div class="icon">📝</div><h3>LOA Requests</h3><p>Submit leave requests and see their approval status.</p></div>
      <div class="card"><div class="icon">⚠️</div><h3>Punishments</h3><p>Record moderation actions with reasons and evidence.</p></div>
    </section>
  `));
});

app.get("/auth/discord", (req, res) => {
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state
  });

  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state || state !== req.session.oauthState) {
      return res.status(400).send(page("Login error", `<div class="card"><h1>Invalid login request</h1><p>Please try logging in again.</p></div>`));
    }

    delete req.session.oauthState;

    const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      })
    });

    const token = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(JSON.stringify(token));

    const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    const user = await userResponse.json();

    if (!userResponse.ok) throw new Error(JSON.stringify(user));

    const member = await getGuildMember(user.id);
    const access = getAccess(member);

    if (!access.isStaff) {
      return res.status(403).send(page("Not staff", `
        <div class="card center">
          <div class="big-icon">🚫</div>
          <h1>Staff access required</h1>
          <p>Your Discord account is not assigned a staff role in this server.</p>
          <a class="button secondary" href="/">Back</a>
        </div>
      `));
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      displayName: user.global_name || user.username,
      avatar: user.avatar,
      avatarUrl: avatarUrl(user)
    };

    await pool.query(`
      INSERT INTO staff_profiles (user_id, username, display_name, avatar_url)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id)
      DO UPDATE SET username = EXCLUDED.username,
                    display_name = EXCLUDED.display_name,
                    avatar_url = EXCLUDED.avatar_url
    `, [
      user.id,
      user.username,
      user.global_name || user.username,
      avatarUrl(user)
    ]);

    res.redirect("/dashboard");
  } catch (error) {
    console.error(error);
    res.status(500).send(page("Login error", `
      <div class="card">
        <h1>Discord login failed</h1>
        <p>Check the website's Discord OAuth2 settings and Railway variables.</p>
      </div>
    `));
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

app.get("/dashboard", requireLogin, async (req, res) => {
  const userId = req.session.user.id;

  const active = await pool.query(`
    SELECT * FROM shifts
    WHERE user_id = $1 AND ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `, [userId]);

  const stats = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE user_id = $1) AS total_shifts,
      COALESCE(SUM(
        CASE
          WHEN user_id = $1 AND ended_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (ended_at - started_at))/60
          ELSE 0
        END
      ), 0) AS minutes_worked
    FROM shifts
  `, [userId]);

  const loa = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE user_id = $1 AND status = 'pending') AS pending
    FROM loas
  `, [userId]);

  const punishmentCount = await pool.query(`
    SELECT COUNT(*) AS count FROM punishments WHERE staff_user_id = $1
  `, [userId]);

  const isOnShift = active.rows.length > 0;
  const minutes = Math.round(Number(stats.rows[0].minutes_worked || 0));

  res.send(page("Dashboard", `
    <div class="page-head">
      <div>
        <div class="eyebrow">STAFF DASHBOARD</div>
        <h1>Welcome, ${escapeHtml(req.session.user.displayName)}</h1>
        <p>Manage your staff activity from here.</p>
      </div>
      <img class="avatar" src="${escapeHtml(req.session.user.avatarUrl)}" alt="">
    </div>

    <section class="grid four">
      <div class="stat"><span>Shift Status</span><strong class="${isOnShift ? "green" : ""}">${isOnShift ? "ON SHIFT" : "OFF SHIFT"}</strong></div>
      <div class="stat"><span>Total Shifts</span><strong>${stats.rows[0].total_shifts}</strong></div>
      <div class="stat"><span>Time Worked</span><strong>${formatMinutes(minutes)}</strong></div>
      <div class="stat"><span>Pending LOAs</span><strong>${loa.rows[0].pending}</strong></div>
    </section>

    <section class="grid two">
      <div class="card">
        <div class="icon">⏱️</div>
        <h2>Shift</h2>
        <p>${isOnShift ? `Your shift started ${formatDate(active.rows[0].started_at)}.` : "You are currently off shift."}</p>
        <form method="POST" action="/shift/${isOnShift ? "end" : "start"}">
          <button class="button ${isOnShift ? "danger" : "success"}">${isOnShift ? "🔴 End Shift" : "🟢 Start Shift"}</button>
        </form>
      </div>

      <div class="card">
        <div class="icon">📝</div>
        <h2>Request an LOA</h2>
        <p>Need time away from staff duties? Submit a request for supervisor review.</p>
        <a class="button secondary" href="/loa">Open LOA</a>
      </div>

      <div class="card">
        <div class="icon">⚠️</div>
        <h2>Log Punishment</h2>
        <p>Record a moderation action and keep your staff records organised.</p>
        <a class="button secondary" href="/punishments">Log Punishment</a>
      </div>

      <div class="card">
        <div class="icon">📊</div>
        <h2>Your Records</h2>
        <p>You have logged ${punishmentCount.rows[0].count} punishment(s).</p>
        <a class="button secondary" href="/punishments">View Records</a>
      </div>
    </section>
  `, req.session.user, req.access));
});

app.post("/shift/start", requireLogin, async (req, res) => {
  const existing = await pool.query(`
    SELECT id FROM shifts
    WHERE user_id = $1 AND ended_at IS NULL
    LIMIT 1
  `, [req.session.user.id]);

  if (!existing.rows.length) {
    await pool.query(
      `INSERT INTO shifts (user_id) VALUES ($1)`,
      [req.session.user.id]
    );
  }

  res.redirect("/dashboard");
});

app.post("/shift/end", requireLogin, async (req, res) => {
  await pool.query(`
    UPDATE shifts
    SET ended_at = NOW()
    WHERE id = (
      SELECT id FROM shifts
      WHERE user_id = $1 AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
    )
  `, [req.session.user.id]);

  res.redirect("/dashboard");
});

app.get("/loa", requireLogin, async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM loas
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 25
  `, [req.session.user.id]);

  const rows = result.rows.map((loa) => `
    <tr>
      <td>${escapeHtml(loa.start_date.toISOString().slice(0, 10))}</td>
      <td>${escapeHtml(loa.end_date.toISOString().slice(0, 10))}</td>
      <td>${escapeHtml(loa.reason)}</td>
      <td><span class="badge ${escapeHtml(loa.status)}">${escapeHtml(loa.status)}</span></td>
      <td>${escapeHtml(loa.review_note || "—")}</td>
    </tr>
  `).join("");

  res.send(page("LOA", `
    <div class="page-head">
      <div><div class="eyebrow">LEAVE OF ABSENCE</div><h1>LOA Requests</h1><p>Submit and track your leave requests.</p></div>
    </div>

    <div class="grid two">
      <div class="card">
        <h2>Submit LOA</h2>
        <form method="POST" action="/loa">
          <label>Start date<input type="date" name="start_date" required></label>
          <label>End date<input type="date" name="end_date" required></label>
          <label>Reason<textarea name="reason" required maxlength="1000" placeholder="Why do you need an LOA?"></textarea></label>
          <label>Additional notes<textarea name="notes" maxlength="2000" placeholder="Optional"></textarea></label>
          <button class="button primary">Submit Request</button>
        </form>
      </div>

      <div class="card">
        <h2>Your Requests</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Start</th><th>End</th><th>Reason</th><th>Status</th><th>Review</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="5">No LOA requests yet.</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    </div>
  `, req.session.user, req.access));
});

app.post("/loa", requireLogin, async (req, res) => {
  const { start_date, end_date, reason, notes } = req.body;

  if (!start_date || !end_date || !reason || start_date > end_date) {
    return res.status(400).send(page("Invalid LOA", `<div class="card"><h1>Invalid request</h1><p>Check your dates and make sure a reason is provided.</p></div>`, req.session.user, req.access));
  }

  await pool.query(`
    INSERT INTO loas (user_id, username, start_date, end_date, reason, notes)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    req.session.user.id,
    req.session.user.displayName,
    start_date,
    end_date,
    reason.trim(),
    notes?.trim() || null
  ]);

  res.redirect("/loa");
});

app.get("/punishments", requireLogin, async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM punishments
    WHERE staff_user_id = $1
    ORDER BY created_at DESC
    LIMIT 50
  `, [req.session.user.id]);

  const rows = result.rows.map((p) => `
    <tr>
      <td>${escapeHtml(p.target_username)}</td>
      <td>${escapeHtml(p.punishment_type)}</td>
      <td>${escapeHtml(p.reason)}</td>
      <td>${p.evidence_url ? `<a href="${escapeHtml(p.evidence_url)}" target="_blank" rel="noreferrer">Evidence</a>` : "—"}</td>
      <td>${formatDate(p.created_at)}</td>
    </tr>
  `).join("");

  res.send(page("Punishments", `
    <div class="page-head">
      <div><div class="eyebrow">DISCIPLINE LOG</div><h1>Punishments</h1><p>Log moderation actions and review your own records.</p></div>
    </div>

    <div class="grid two">
      <div class="card">
        <h2>Log Punishment</h2>
        <form method="POST" action="/punishments">
          <label>Roblox username<input name="target_username" required maxlength="100"></label>
          <label>Roblox User ID<input name="target_roblox_id" maxlength="30"></label>
          <label>Punishment type
            <select name="punishment_type" required>
              <option value="">Choose...</option>
              <option>Verbal Warning</option>
              <option>Warning</option>
              <option>Kick</option>
              <option>Ban</option>
              <option>Other</option>
            </select>
          </label>
          <label>Reason<textarea name="reason" required maxlength="2000"></textarea></label>
          <label>Evidence URL<input type="url" name="evidence_url" placeholder="https://..."></label>
          <label>Notes<textarea name="notes" maxlength="2000"></textarea></label>
          <button class="button primary">Submit Punishment</button>
        </form>
      </div>

      <div class="card">
        <h2>Your Punishments</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>User</th><th>Type</th><th>Reason</th><th>Evidence</th><th>Date</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="5">No punishments logged yet.</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    </div>
  `, req.session.user, req.access));
});

app.post("/punishments", requireLogin, async (req, res) => {
  const {
    target_username,
    target_roblox_id,
    punishment_type,
    reason,
    evidence_url,
    notes
  } = req.body;

  if (!target_username || !punishment_type || !reason) {
    return res.status(400).send(page("Invalid punishment", `<div class="card"><h1>Missing information</h1><p>Username, punishment type and reason are required.</p></div>`, req.session.user, req.access));
  }

  await pool.query(`
    INSERT INTO punishments (
      staff_user_id, staff_username, target_username, target_roblox_id,
      punishment_type, reason, evidence_url, notes
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [
    req.session.user.id,
    req.session.user.displayName,
    target_username.trim(),
    target_roblox_id?.trim() || null,
    punishment_type,
    reason.trim(),
    evidence_url?.trim() || null,
    notes?.trim() || null
  ]);

  res.redirect("/punishments");
});

app.get("/admin/loas", requireLogin, requireSupervisor, async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM loas
    ORDER BY
      CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT 100
  `);

  const rows = result.rows.map((loa) => `
    <tr>
      <td>${escapeHtml(loa.username)}</td>
      <td>${escapeHtml(loa.start_date.toISOString().slice(0, 10))}</td>
      <td>${escapeHtml(loa.end_date.toISOString().slice(0, 10))}</td>
      <td>${escapeHtml(loa.reason)}</td>
      <td><span class="badge ${escapeHtml(loa.status)}">${escapeHtml(loa.status)}</span></td>
      <td>
        ${loa.status === "pending" ? `
          <form class="inline-form" method="POST" action="/admin/loas/${loa.id}">
            <input type="hidden" name="status" value="approved">
            <input type="text" name="review_note" placeholder="Optional note">
            <button class="small success">Approve</button>
          </form>
          <form class="inline-form" method="POST" action="/admin/loas/${loa.id}">
            <input type="hidden" name="status" value="denied">
            <input type="text" name="review_note" placeholder="Reason">
            <button class="small danger">Deny</button>
          </form>
        ` : escapeHtml(loa.review_note || "—")}
      </td>
    </tr>
  `).join("");

  res.send(page("LOA Review", `
    <div class="page-head">
      <div><div class="eyebrow">SUPERVISOR PANEL</div><h1>LOA Review</h1><p>Approve or deny staff leave requests.</p></div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Staff</th><th>Start</th><th>End</th><th>Reason</th><th>Status</th><th>Review</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="6">No requests found.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `, req.session.user, req.access));
});

app.post("/admin/loas/:id", requireLogin, requireSupervisor, async (req, res) => {
  const status = req.body.status === "approved" ? "approved" : "denied";
  await pool.query(`
    UPDATE loas
    SET status = $1, reviewed_by = $2, reviewed_at = NOW(), review_note = $3
    WHERE id = $4
  `, [status, req.session.user.id, req.body.review_note?.trim() || null, req.params.id]);

  res.redirect("/admin/loas");
});

app.get("/admin/punishments", requireLogin, requireManagement, async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM punishments
    ORDER BY created_at DESC
    LIMIT 200
  `);

  const rows = result.rows.map((p) => `
    <tr>
      <td>${escapeHtml(p.staff_username)}</td>
      <td>${escapeHtml(p.target_username)}</td>
      <td>${escapeHtml(p.target_roblox_id || "—")}</td>
      <td>${escapeHtml(p.punishment_type)}</td>
      <td>${escapeHtml(p.reason)}</td>
      <td>${formatDate(p.created_at)}</td>
    </tr>
  `).join("");

  res.send(page("Punishment Management", `
    <div class="page-head">
      <div><div class="eyebrow">MANAGEMENT</div><h1>Punishment Records</h1><p>View punishment records logged by staff.</p></div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Staff</th><th>Target</th><th>Roblox ID</th><th>Type</th><th>Reason</th><th>Date</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="6">No records found.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `, req.session.user, req.access));
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`ER:LC Staff Website running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database startup error:", error);
    process.exit(1);
  });
