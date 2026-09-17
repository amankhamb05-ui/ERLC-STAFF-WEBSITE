require("dotenv").config();

const express = require("express");
const session = require("express-session");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
    session({
        secret: process.env.SESSION_SECRET || "change-this-secret",
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: process.env.NODE_ENV === "production",
            maxAge: 1000 * 60 * 60 * 24 * 7
        }
    })
);

app.use(express.static("public"));

/* =========================
   DATABASE
========================= */

async function setupDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS shifts (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL,
            username VARCHAR(100),
            started_at TIMESTAMP NOT NULL,
            ended_at TIMESTAMP,
            duration INTEGER
        );

        CREATE TABLE IF NOT EXISTS loas (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL,
            username VARCHAR(100),
            reason TEXT NOT NULL,
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            status VARCHAR(20) DEFAULT 'pending',
            reviewed_by VARCHAR(100),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS punishments (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL,
            username VARCHAR(100),
            punishment_type VARCHAR(50) NOT NULL,
            reason TEXT NOT NULL,
            issued_by VARCHAR(100),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    console.log("Database ready.");
}

/* =========================
   DISCORD OAUTH
========================= */

app.get("/auth/discord", (req, res) => {
    const params = new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        response_type: "code",
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
        scope: "identify guilds"
    });

    res.redirect(
        `https://discord.com/oauth2/authorize?${params.toString()}`
    );
});

app.get("/auth/discord/callback", async (req, res) => {
    try {
        const { code } = req.query;

        if (!code) {
            return res.status(400).send("Missing Discord authorization code.");
        }

        // Exchange code for access token
        const tokenResponse = await fetch(
            "https://discord.com/api/oauth2/token",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: new URLSearchParams({
                    client_id: process.env.DISCORD_CLIENT_ID,
                    client_secret: process.env.DISCORD_CLIENT_SECRET,
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: process.env.DISCORD_REDIRECT_URI
                })
            }
        );

        const tokenData = await tokenResponse.json();

        if (!tokenData.access_token) {
            console.error(tokenData);
            return res.status(401).send("Discord login failed.");
        }

        const accessToken = tokenData.access_token;

        // Get Discord user
        const userResponse = await fetch(
            "https://discord.com/api/users/@me",
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        );

        const user = await userResponse.json();

        // Get user's Discord servers
        const guildResponse = await fetch(
            "https://discord.com/api/users/@me/guilds",
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        );

        const guilds = await guildResponse.json();

        const guild = guilds.find(
            g => g.id === process.env.DISCORD_GUILD_ID
        );

        if (!guild) {
            return res.status(403).send(
                "You must be a member of the ERLC Discord server."
            );
        }

        /*
         * Discord's /users/@me/guilds endpoint gives the user's
         * permissions, but not their complete role list.
         *
         * We use the guild member endpoint below.
         */

        const memberResponse = await fetch(
            `https://discord.com/api/users/${user.id}`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        );

        // Save basic user information
        req.session.user = {
            id: user.id,
            username: user.global_name || user.username,
            avatar: user.avatar
        };

        /*
         * We need the bot token to retrieve the member's roles.
         * The bot token is ONLY stored in Railway variables.
         */

        if (process.env.DISCORD_BOT_TOKEN) {
            const memberCheck = await fetch(
                `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${user.id}`,
                {
                    headers: {
                        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`
                    }
                }
            );

            if (memberCheck.ok) {
                const member = await memberCheck.json();

                req.session.user.roles = member.roles || [];
            } else {
                req.session.user.roles = [];
            }
        } else {
            req.session.user.roles = [];
        }

        const roles = req.session.user.roles;

        req.session.user.isStaff =
            roles.includes(process.env.STAFF_ROLE_ID) ||
            roles.includes(process.env.SUPERVISOR_ROLE_ID) ||
            roles.includes(process.env.MANAGEMENT_ROLE_ID);

        req.session.user.isSupervisor =
            roles.includes(process.env.SUPERVISOR_ROLE_ID) ||
            roles.includes(process.env.MANAGEMENT_ROLE_ID);

        req.session.user.isManagement =
            roles.includes(process.env.MANAGEMENT_ROLE_ID);

        if (!req.session.user.isStaff) {
            return res.status(403).send(
                "You are in the server, but you do not have a staff role."
            );
        }

        res.redirect("/dashboard.html");

    } catch (error) {
        console.error(error);
        res.status(500).send("Something went wrong.");
    }
});

/* =========================
   AUTH CHECK
========================= */

function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({
            error: "Not logged in"
        });
    }

    next();
}

function requireStaff(req, res, next) {
    if (!req.session.user?.isStaff) {
        return res.status(403).json({
            error: "Staff only"
        });
    }

    next();
}

function requireSupervisor(req, res, next) {
    if (!req.session.user?.isSupervisor) {
        return res.status(403).json({
            error: "Supervisor only"
        });
    }

    next();
}

function requireManagement(req, res, next) {
    if (!req.session.user?.isManagement) {
        return res.status(403).json({
            error: "Management only"
        });
    }

    next();
}

/* =========================
   USER
========================= */

app.get("/api/me", requireLogin, (req, res) => {
    res.json(req.session.user);
});

app.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect("/");
    });
});

/* =========================
   SHIFTS
========================= */

app.post("/api/shifts/start", requireStaff, async (req, res) => {
    try {
        const user = req.session.user;

        const active = await pool.query(
            `SELECT * FROM shifts
             WHERE user_id = $1
             AND ended_at IS NULL`,
            [user.id]
        );

        if (active.rows.length > 0) {
            return res.status(400).json({
                error: "You are already on shift."
            });
        }

        await pool.query(
            `INSERT INTO shifts
            (user_id, username, started_at)
            VALUES ($1, $2, NOW())`,
            [user.id, user.username]
        );

        res.json({
            success: true,
            message: "Shift started."
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Database error." });
    }
});

app.post("/api/shifts/end", requireStaff, async (req, res) => {
    try {
        const user = req.session.user;

        const result = await pool.query(
            `SELECT * FROM shifts
             WHERE user_id = $1
             AND ended_at IS NULL
             ORDER BY started_at DESC
             LIMIT 1`,
            [user.id]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({
                error: "You are not currently on shift."
            });
        }

        const shift = result.rows[0];

        const duration = Math.floor(
            (Date.now() - new Date(shift.started_at).getTime()) / 1000
        );

        await pool.query(
            `UPDATE shifts
             SET ended_at = NOW(),
                 duration = $1
             WHERE id = $2`,
            [duration, shift.id]
        );

        res.json({
            success: true,
            message: "Shift ended."
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Database error." });
    }
});

app.get("/api/shifts", requireStaff, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT *
             FROM shifts
             WHERE user_id = $1
             ORDER BY started_at DESC`,
            [req.session.user.id]
        );

        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Database error." });
    }
});

/* =========================
   LOA
========================= */

app.post("/api/loa", requireStaff, async (req, res) => {
    try {
        const { reason, startDate, endDate } = req.body;

        if (!reason || !startDate || !endDate) {
            return res.status(400).json({
                error: "Please fill in all fields."
            });
        }

        const user = req.session.user;

        await pool.query(
            `INSERT INTO loas
            (user_id, username, reason, start_date, end_date)
            VALUES ($1, $2, $3, $4, $5)`,
            [
                user.id,
                user.username,
                reason,
                startDate,
                endDate
            ]
        );

        res.json({
            success: true,
            message: "LOA request submitted."
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Database error." });
    }
});

app.get("/api/loa", requireSupervisor, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT *
             FROM loas
             ORDER BY created_at DESC`
        );

        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Database error." });
    }
});

app.post("/api/loa/:id/approve", requireSupervisor, async (req, res) => {
    try {
        await pool.query(
            `UPDATE loas
             SET status = 'approved',
                 reviewed_by = $1
             WHERE id = $2`,
            [
                req.session.user.username,
                req.params.id
            ]
        );

        res.json({
            success: true
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Database error." });
    }
});

app.post("/api/loa/:id/deny", requireSupervisor, async (req, res) => {
    try {
        await pool.query(
            `UPDATE loas
             SET status = 'denied',
                 reviewed_by = $1
             WHERE id = $2`,
            [
                req.session.user.username,
                req.params.id
            ]
        );

        res.json({
            success: true
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Database error." });
    }
});

/* =========================
   PUNISHMENTS
========================= */

app.post("/api/punishments", requireStaff, async (req, res) => {
    try {
        const {
            userId,
            username,
            punishmentType,
            reason
        } = req.body;

        if (!userId || !username || !punishmentType || !reason) {
            return res.status(400).json({
                error: "Please fill in all fields."
            });
        }

        await pool.query(
            `INSERT INTO punishments
            (user_id, username, punishment_type, reason, issued_by)
            VALUES ($1, $2, $3, $4, $5)`,
            [
                userId,
                username,
                punishmentType,
                reason,
                req.session.user.username
            ]
        );

        res.json({
            success: true,
            message: "Punishment logged."
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Database error." });
    }
});

app.get(
    "/api/punishments",
    requireManagement,
    async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT *
                 FROM punishments
                 ORDER BY created_at DESC`
            );

            res.json(result.rows);

        } catch (error) {
            console.error(error);
            res.status(500).json({
                error: "Database error."
            });
        }
    }
);

/* =========================
   START
========================= */

setupDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`ERLC Staff Website running on port ${PORT}`);
        });
    })
    .catch(error => {
        console.error("Database setup failed:", error);
        process.exit(1);
    });
