import express from 'express';
import cors from 'cors';
import pg from 'pg';
import nodemailer from 'nodemailer';
import cron from 'node-cron';
import axios from 'axios';
import xml2js from 'xml2js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── DB Setup ─────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS carriers (
      id SERIAL PRIMARY KEY,
      dot_number VARCHAR(20) UNIQUE,
      mc_number VARCHAR(20),
      company_name VARCHAR(255),
      phone VARCHAR(30),
      email VARCHAR(255),
      city VARCHAR(100),
      state VARCHAR(10),
      truck_count INT,
      application_date DATE,
      has_email BOOLEAN GENERATED ALWAYS AS (email IS NOT NULL AND email != '') STORED,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS outreach_log (
      id SERIAL PRIMARY KEY,
      carrier_id INT REFERENCES carriers(id) ON DELETE CASCADE,
      type VARCHAR(20) NOT NULL,
      status VARCHAR(30) DEFAULT 'sent',
      notes TEXT,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      follow_up_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS call_notes (
      id SERIAL PRIMARY KEY,
      carrier_id INT REFERENCES carriers(id) ON DELETE CASCADE,
      notes TEXT,
      call_status VARCHAR(30) DEFAULT 'pending',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('[DB] Tables ready');
}

// ── Email ─────────────────────────────────────────────────────────────────────
function getTransporter() {
  return nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.OUTLOOK_USER,
      pass: process.env.OUTLOOK_PASS,
    },
  });
}

function buildEmailHtml(companyName) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:0;background:#f8fafc;">
  <div style="background:#1e3a5f;padding:28px 32px;">
    <h1 style="color:#fff;margin:0;font-size:22px;">LoadTracker Pro</h1>
    <p style="color:#93c5fd;margin:4px 0 0;font-size:13px;">Built by a carrier, for carriers.</p>
  </div>
  <div style="background:#fff;padding:32px;">
    <p style="color:#1e293b;font-size:16px;">Hi ${companyName},</p>
    <p style="color:#475569;line-height:1.7;">
      Congratulations on your new authority! My name is Kevin Owen — I'm a small fleet owner out of Texas,
      and I built <strong>LoadTracker Pro</strong> because I couldn't afford what the big TMS companies were charging
      for features I didn't need.
    </p>
    <p style="color:#475569;line-height:1.7;">
      I designed it specifically for small carriers who need <strong>big capabilities without the big price tag</strong>.
      Here's what's included for <strong>$350/month flat</strong> — no contracts, no per-user fees:
    </p>
    <ul style="color:#475569;line-height:2;padding-left:20px;">
      <li>📦 Full load management with a live dispatch pipeline</li>
      <li>📍 Real-time GPS driver tracking</li>
      <li>🧾 <strong>Auto-invoice with automatic PDF + POD emailed to your customer</strong> the moment the driver delivers — no manual work</li>
      <li>🗺️ IFTA reporting with per-state mileage tracked automatically</li>
      <li>📁 <strong>Digital driver file storage</strong> — DOT compliance requires it, we built it in</li>
      <li>📱 Driver mobile app (iOS & Android) for load updates, BOL, and proof of delivery photos</li>
      <li>🎙️ Historical Marker Road Tour — your drivers get audio narration of landmarks along their route via Bluetooth (yes, really)</li>
    </ul>
    <p style="color:#475569;line-height:1.7;">
      Most TMS platforms charge $500–$1,200/month and lock you into annual contracts.
      We're half the cost and built by someone who actually runs trucks.
    </p>
    <div style="text-align:center;margin:32px 0;">
      <a href="https://loadtrackerpro.turtlelogisticsllc.com"
         style="background:#1e3a5f;color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px;">
        See the Live Demo
      </a>
    </div>
    <p style="color:#475569;line-height:1.7;">
      If you have any questions or want a personal walkthrough, reach out directly:
    </p>
    <p style="color:#1e3a5f;font-weight:bold;">Kevin Owen<br>
    <a href="mailto:kevin@turtlelogisticsllc.com" style="color:#1e3a5f;">kevin@turtlelogisticsllc.com</a><br>
    Turtle Logistics LLC</p>
  </div>
  <div style="background:#f1f5f9;padding:16px 32px;text-align:center;">
    <p style="color:#94a3b8;font-size:12px;margin:0;">
      You're receiving this because you recently registered with the FMCSA.<br>
      <a href="mailto:kevin@turtlelogisticsllc.com?subject=Unsubscribe" style="color:#94a3b8;">Unsubscribe</a>
    </p>
  </div>
</body>
</html>`;
}

async function sendOutreachEmail(carrier) {
  const transporter = getTransporter();
  await transporter.sendMail({
    from: `"Kevin Owen — LoadTracker Pro" <${process.env.OUTLOOK_USER}>`,
    to: carrier.email,
    subject: `${carrier.company_name} — TMS built for small carriers like yours`,
    html: buildEmailHtml(carrier.company_name),
  });

  await pool.query(
    `INSERT INTO outreach_log (carrier_id, type, status, follow_up_at)
     VALUES ($1, 'email', 'sent', NOW() + INTERVAL '7 days')`,
    [carrier.id]
  );
  console.log(`[Email] Sent to ${carrier.company_name} <${carrier.email}>`);
}

async function sendFollowUpEmail(carrier) {
  const transporter = getTransporter();
  await transporter.sendMail({
    from: `"Kevin Owen — LoadTracker Pro" <${process.env.OUTLOOK_USER}>`,
    to: carrier.email,
    subject: `Following up — LoadTracker Pro for ${carrier.company_name}`,
    html: `
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:32px;background:#fff;">
  <p style="color:#1e293b;">Hi ${carrier.company_name},</p>
  <p style="color:#475569;line-height:1.7;">
    Just following up on my note from last week about LoadTracker Pro.
    I know getting a new carrier operation off the ground is busy work — I've been there.
  </p>
  <p style="color:#475569;line-height:1.7;">
    If you haven't had a chance to check out the demo, it only takes a few minutes and you can
    see the full system live — loads, GPS tracking, auto-invoicing, driver app, everything.
  </p>
  <div style="text-align:center;margin:28px 0;">
    <a href="https://loadtrackerpro.turtlelogisticsllc.com"
       style="background:#1e3a5f;color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:bold;">
      View Live Demo
    </a>
  </div>
  <p style="color:#475569;">No pressure — just wanted to make sure you saw it.</p>
  <p style="color:#1e3a5f;font-weight:bold;">Kevin Owen<br>kevin@turtlelogisticsllc.com</p>
  <p style="color:#94a3b8;font-size:11px;margin-top:24px;">
    <a href="mailto:kevin@turtlelogisticsllc.com?subject=Unsubscribe" style="color:#94a3b8;">Unsubscribe</a>
  </p>
</body>
</html>`,
  });

  await pool.query(
    `UPDATE outreach_log SET status = 'follow_up_sent'
     WHERE carrier_id = $1 AND type = 'email' AND status = 'sent'`,
    [carrier.id]
  );
  console.log(`[Email] Follow-up sent to ${carrier.company_name}`);
}

// ── FMCSA Poller ──────────────────────────────────────────────────────────────
const FMCSA_API = 'https://mobile.fmcsa.dot.gov/qc/services';
// New carriers in 2026 are around DOT# 4,300,000+. Override with START_DOT_NUMBER env var.
const DEFAULT_START_DOT = 4300000;
const SCAN_BATCH = 200;

async function getLastScannedDOT() {
  const r = await pool.query(`SELECT MAX(CAST(dot_number AS BIGINT)) as max_dot FROM carriers WHERE dot_number ~ '^[0-9]+$'`);
  return r.rows[0].max_dot ? parseInt(r.rows[0].max_dot) : (parseInt(process.env.START_DOT_NUMBER) || DEFAULT_START_DOT);
}

async function pollFMCSA() {
  console.log('[FMCSA] Polling for new carriers...');
  const webKey = process.env.FMCSA_WEBKEY;
  if (!webKey) {
    console.error('[FMCSA] FMCSA_WEBKEY not set — skipping poll');
    return;
  }

  try {
    const startDOT = await getLastScannedDOT();
    const endDOT = startDOT + SCAN_BATCH;
    console.log(`[FMCSA] Scanning DOT# ${startDOT} → ${endDOT}`);

    let found = 0;
    for (let dot = startDOT; dot <= endDOT; dot++) {
      try {
        const url = `${FMCSA_API}/carriers/${dot}?webKey=${webKey}`;
        const res = await axios.get(url, { timeout: 10000 });
        const content = res.data?.content;
        if (!content || content.length === 0) continue;

        const c = Array.isArray(content) ? content[0] : content;
        const companyName = c.legalName || c.dbaName;
        if (!companyName) continue;

        const email = c.emailAddress || null;
        const phone = c.telephone || null;
        const state = c.phyState || c.mailingState || null;
        const city = c.phyCity || c.mailingCity || null;
        const mc = c.docketNumber ? String(c.docketNumber) : null;
        const trucks = c.totalPowerUnits ? parseInt(c.totalPowerUnits) : null;

        const result = await pool.query(
          `INSERT INTO carriers (dot_number, mc_number, company_name, phone, email, city, state, truck_count, application_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (dot_number) DO NOTHING
           RETURNING id`,
          [String(dot), mc, companyName, phone, email, city, state, trucks]
        );

        if (result.rows.length > 0) {
          found++;
          console.log(`[FMCSA] New carrier: ${companyName} (DOT ${dot}${email ? ', has email' : ', no email'})`);
          if (email) {
            const already = await pool.query(
              `SELECT id FROM outreach_log WHERE carrier_id=$1 AND type='email'`, [result.rows[0].id]
            );
            if (already.rows.length === 0) {
              const carrier = await pool.query(`SELECT * FROM carriers WHERE id=$1`, [result.rows[0].id]);
              await sendOutreachEmail(carrier.rows[0]);
            }
          }
        }
      } catch (err) {
        if (err.response?.status !== 404) {
          console.error(`[FMCSA] DOT ${dot} error:`, err.message);
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[FMCSA] Poll complete — ${found} new carriers found (scanned DOT ${startDOT}–${endDOT})`);
    await sendPendingFollowUps();

  } catch (err) {
    console.error('[FMCSA] Poll error:', err.message);
  }
}


async function sendPendingFollowUps() {
  const result = await pool.query(`
    SELECT c.* FROM carriers c
    JOIN outreach_log o ON o.carrier_id = c.id
    WHERE o.type = 'email' AND o.status = 'sent'
    AND o.follow_up_at <= NOW()
    AND c.email IS NOT NULL
  `);
  for (const carrier of result.rows) {
    await sendFollowUpEmail(carrier);
  }
}

// ── API Routes ────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Call queue — carriers without email
app.get('/api/call-queue', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, cn.call_status, cn.notes as call_notes
      FROM carriers c
      LEFT JOIN call_notes cn ON cn.carrier_id = c.id
      WHERE c.email IS NULL OR c.email = ''
      ORDER BY c.application_date DESC, c.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Emailed carriers
app.get('/api/emailed', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, o.status as outreach_status, o.sent_at, o.follow_up_at
      FROM carriers c
      JOIN outreach_log o ON o.carrier_id = c.id
      WHERE o.type = 'email'
      ORDER BY o.sent_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: check a specific DOT number against the FMCSA API
app.get('/api/debug-dot/:dot', async (req, res) => {
  const webKey = process.env.FMCSA_WEBKEY;
  try {
    const url = `${FMCSA_API}/carriers/${req.params.dot}?webKey=${webKey}`;
    const r = await axios.get(url, { timeout: 10000 });
    res.json({ url, data: r.data });
  } catch (err) {
    res.json({ url: `${FMCSA_API}/carriers/${req.params.dot}?webKey=${webKey}`, status: err.response?.status, message: err.message });
  }
});

// Update call status
app.patch('/api/carriers/:id/call-status', async (req, res) => {
  try {
    const { call_status, notes } = req.body;
    await pool.query(`
      INSERT INTO call_notes (carrier_id, call_status, notes, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (carrier_id) DO UPDATE SET call_status=$2, notes=$3, updated_at=NOW()
    `, [req.params.id, call_status, notes || '']);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual poll trigger
app.post('/api/poll', async (req, res) => {
  res.json({ message: 'Poll started' });
  pollFMCSA();
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const [total, emailed, called, followUp] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM carriers'),
      pool.query("SELECT COUNT(*) FROM outreach_log WHERE type='email' AND status='sent'"),
      pool.query("SELECT COUNT(*) FROM call_notes WHERE call_status != 'pending'"),
      pool.query("SELECT COUNT(*) FROM outreach_log WHERE status='follow_up_sent'"),
    ]);
    res.json({
      total: parseInt(total.rows[0].count),
      emailed: parseInt(emailed.rows[0].count),
      called: parseInt(called.rows[0].count),
      followUpSent: parseInt(followUp.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cron: every 6 hours starting at 6am ──────────────────────────────────────
// 6am, 12pm, 6pm, 12am
cron.schedule('0 6,12,18,0 * * *', () => {
  console.log('[Cron] Triggered FMCSA poll');
  pollFMCSA();
}, { timezone: 'America/Chicago' });

// ── Static frontend ───────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(__dirname, '../dist')));
app.get('/{*splat}', (req, res) => {
  res.sendFile(join(__dirname, '../dist/index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 FMCSA Outreach server running on port ${PORT}`);
  });
});
