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
      mc_number VARCHAR(20) UNIQUE,
      dot_number VARCHAR(20),
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
async function pollFMCSA() {
  console.log('[FMCSA] Polling for new carriers...');
  try {
    // Query FMCSA L&I system for new entrants from the last 7 days
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 7);

    const fmt = (d) => `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;

    const url = `https://li-public.fmcsa.dot.gov/LIVIEW/pkg_carrquery.prc_carrlist?pv_vpath=LIVIEW&pn_seqnum=&pv_snap_requested=N&pv_typequery=S&pv_usdot_num=&pv_mc_num=&pv_first_name=&pv_last_name=&pv_comp_name=&pv_state=&pv_eff_date_from=${fmt(fromDate)}&pv_eff_date_to=${fmt(toDate)}&pv_oper_auth_type=CARRIER`;

    const response = await axios.get(url, {
      timeout: 30000,
      headers: { 'User-Agent': 'LoadTrackerPro-Outreach/1.0 (kevin@turtlelogisticsllc.com)' },
    });

    // Parse the HTML response to extract carrier data
    const html = response.data;
    const rows = [];

    // Extract table rows with carrier data using regex on the HTML
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const stripTags = (s) => s.replace(/<[^>]+>/g, '').trim();

    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const rowHtml = match[1];
      const cells = [];
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        cells.push(stripTags(cellMatch[1]));
      }
      if (cells.length >= 4 && cells[0].match(/^\d+$/)) {
        rows.push(cells);
      }
    }

    console.log(`[FMCSA] Found ${rows.length} new carrier rows`);

    for (const cells of rows) {
      const mcNumber = cells[0] || null;
      const companyName = cells[1] || null;
      const state = cells[2] || null;
      const appDate = cells[3] || null;

      if (!mcNumber || !companyName) continue;

      // Insert carrier, skip if already exists
      const result = await pool.query(
        `INSERT INTO carriers (mc_number, company_name, state, application_date)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (mc_number) DO NOTHING
         RETURNING id`,
        [mcNumber, companyName, state, appDate || new Date()]
      );

      if (result.rows.length > 0 && result.rows[0].id) {
        const carrierId = result.rows[0].id;
        // Try to fetch more details for this carrier
        await fetchCarrierDetails(carrierId, mcNumber);
      }
    }

    // Send follow-ups for carriers emailed 7+ days ago
    await sendPendingFollowUps();

  } catch (err) {
    console.error('[FMCSA] Poll error:', err.message);
  }
}

async function fetchCarrierDetails(carrierId, mcNumber) {
  try {
    const url = `https://li-public.fmcsa.dot.gov/LIVIEW/pkg_carrquery.prc_carrdetail?pv_vpath=LIVIEW&pn_seqnum=${mcNumber}`;
    const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'LoadTrackerPro-Outreach/1.0' } });
    const html = res.data;

    const extract = (label) => {
      const regex = new RegExp(`${label}[^<]*<[^>]+>([^<]+)<`, 'i');
      const m = html.match(regex);
      return m ? m[1].trim() : null;
    };

    const phone = extract('Phone') || extract('Telephone');
    const email = extract('Email');
    const dot = extract('USDOT');
    const trucks = parseInt(extract('Total Power Units') || '0') || null;

    await pool.query(
      `UPDATE carriers SET phone=$1, email=$2, dot_number=$3, truck_count=$4 WHERE id=$5`,
      [phone, email, dot, trucks, carrierId]
    );

    // If we have an email and haven't contacted them yet, send outreach
    if (email) {
      const already = await pool.query(
        `SELECT id FROM outreach_log WHERE carrier_id=$1 AND type='email'`, [carrierId]
      );
      if (already.rows.length === 0) {
        const carrier = await pool.query(`SELECT * FROM carriers WHERE id=$1`, [carrierId]);
        await sendOutreachEmail(carrier.rows[0]);
      }
    }
  } catch (err) {
    console.error(`[FMCSA] Detail fetch error for MC ${mcNumber}:`, err.message);
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
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '../dist/index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 FMCSA Outreach server running on port ${PORT}`);
  });
});
