import express from 'express';
import webpush from 'web-push';
import { Resend } from 'resend';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

import heicConvert from 'heic-convert';
import multer from 'multer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// VAPID keys are set up below from data/vapid.json (persistent across restarts)

// Resend client created on-demand from admin config
async function getResendClient() {
  const apiKey = await getConfig('resend_api_key', process.env.RESEND_API_KEY || '');
  if (!apiKey) return null;
  return new Resend(apiKey);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

app.get('/api/ping', (req, res) => res.json({ message: 'pong' }));

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const upload = multer({ dest: UPLOADS_DIR });

// Serve static uploads
app.use('/uploads', express.static(UPLOADS_DIR));

const server = createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e9, // 1 GB
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const SERVER_START_TIME = Date.now();

// Database setup
const db = new sqlite3.Database('./data/database.sqlite', (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS spaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_private BOOLEAN DEFAULT 0,
        invite_key TEXT,
        is_dm INTEGER DEFAULT 0
      )`, () => {
        db.run(`ALTER TABLE spaces ADD COLUMN is_private BOOLEAN DEFAULT 0`, () => {});
        db.run(`ALTER TABLE spaces ADD COLUMN invite_key TEXT`, () => {});
        db.run(`ALTER TABLE spaces ADD COLUMN is_dm INTEGER DEFAULT 0`, () => {});
        db.run(`ALTER TABLE spaces ADD COLUMN escrow_key TEXT`, () => {});
      });

      db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password_hash TEXT,
        theme TEXT DEFAULT 'light',
        color_palette TEXT DEFAULT '#4CAF50',
        avatar TEXT,
        first_name TEXT,
        last_name TEXT,
        email TEXT,
        location TEXT,
        role TEXT DEFAULT 'user',
        font_family TEXT,
        is_verified INTEGER DEFAULT 0,
        verification_token TEXT,
        reset_token TEXT,
        reset_token_expires INTEGER,
        public_key TEXT,
        wrapped_private_key TEXT,
        bio TEXT,
        status_text TEXT,
        status_emoji TEXT,
        timezone TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) console.error("FATAL SQLITE CREATE ERROR:", err);
        if (!err) {
          // Try modifying table to add columns if they don't exist (safe failures)
          db.run(`ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'light'`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN color_palette TEXT DEFAULT '#4CAF50'`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN avatar TEXT`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN first_name TEXT`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN last_name TEXT`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN email TEXT`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN location TEXT`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN font_family TEXT`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN is_verified INTEGER DEFAULT 0`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN verification_token TEXT`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN reset_token TEXT`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN reset_token_expires INTEGER`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN public_key TEXT`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN wrapped_private_key TEXT`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN bio TEXT`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN status_text TEXT`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN status_emoji TEXT`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN timezone TEXT`, () => { });
          db.run(`ALTER TABLE users ADD COLUMN suspended INTEGER DEFAULT 0`, () => { });
        }
      });

      db.run(`CREATE TABLE IF NOT EXISTS space_members (
        space_id INTEGER,
        user_id INTEGER,
        PRIMARY KEY (space_id, user_id),
        FOREIGN KEY (space_id) REFERENCES spaces(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`, (err) => {
         if (err) console.error('Failed to create space_members table:', err);
      });

      db.run(`CREATE TABLE IF NOT EXISTS login_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        ip_address TEXT,
        user_agent TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )`, () => {
        db.run(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('global_font', 'Roboto')`);
      });
      
      db.run(`CREATE TABLE IF NOT EXISTS space_keys (
        space_id INTEGER,
        user_id INTEGER,
        encrypted_room_key TEXT,
        PRIMARY KEY (space_id, user_id),
        FOREIGN KEY (space_id) REFERENCES spaces(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);
      // Phase 4: Moderation tables
      db.run(`CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER,
        admin_username TEXT,
        action TEXT,
        target_type TEXT,
        target_id TEXT,
        details TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS message_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reporter_id INTEGER,
        reporter_username TEXT,
        message_id INTEGER,
        space_id INTEGER,
        message_text TEXT,
        message_sender TEXT,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        resolved_by TEXT,
        resolved_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (reporter_id) REFERENCES users(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS word_filters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern TEXT UNIQUE,
        action TEXT DEFAULT 'block',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        key_hash TEXT UNIQUE,
        key_prefix TEXT,
        permissions TEXT DEFAULT 'read',
        created_by TEXT,
        last_used DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        endpoint TEXT UNIQUE,
        keys_p256dh TEXT,
        keys_auth TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT,
        sender TEXT,
        space_id INTEGER DEFAULT 1,
        asset TEXT,
        edited INTEGER DEFAULT 0,
        is_pinned INTEGER DEFAULT 0,
        reactions TEXT DEFAULT '{}',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, () => {
        db.run(`ALTER TABLE messages ADD COLUMN space_id INTEGER DEFAULT 1`, () => { });
        db.run(`ALTER TABLE messages ADD COLUMN asset TEXT`, () => { });
        db.run(`ALTER TABLE messages ADD COLUMN edited INTEGER DEFAULT 0`, () => { });
        db.run(`ALTER TABLE messages ADD COLUMN is_pinned INTEGER DEFAULT 0`, () => { });
        db.run(`ALTER TABLE messages ADD COLUMN reactions TEXT DEFAULT '{}'`, () => { });
        
        // Phase 13: Purge 'General' space completely
        // Moved here to guarantee 'messages' table exists before executing DELETE
        db.run(`DELETE FROM messages WHERE space_id = 1`, (err) => { if(err) console.error('Error deleting General messages:', err.message) });
        db.run(`DELETE FROM space_members WHERE space_id = 1`, (err) => { if(err) console.error('Error deleting General members:', err.message) });
        db.run(`DELETE FROM spaces WHERE id = 1`, (err) => {  if(err) console.error('Error deleting General space:', err.message) });

        // Phase 13: Guarantee "Notes to Self" for all existing users
        db.all(`SELECT id, username FROM users`, [], (err, usersList) => {
          if (!err && usersList) {
            usersList.forEach(u => {
              db.get(`SELECT s.id FROM spaces s JOIN space_members sm ON s.id = sm.space_id WHERE s.is_dm = 1 AND s.name LIKE 'self_%' AND sm.user_id = ?`, [u.id], (err, row) => {
                if (!row) {
                  db.run(`INSERT INTO spaces (name, created_by, is_private, is_dm) VALUES (?, ?, 1, 1)`, [`self_${u.id}_${Date.now()}`, u.username], function(err) {
                    if (!err && this.lastID) {
                      db.run(`INSERT INTO space_members (space_id, user_id) VALUES (?, ?)`, [this.lastID, u.id]);
                    }
                  });
                }
              });
            });
          }
        });
      });
      db.run(`CREATE TABLE IF NOT EXISTS read_receipts (
        space_id INTEGER,
        username TEXT,
        message_id INTEGER,
        PRIMARY KEY (space_id, username)
      )`);
      // Admin config store
      db.run(`CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, () => {
        // Seed defaults if not present
        const defaults = [
          ['registration_mode', 'open'],
          ['require_email_verification', 'true'],
          ['email_domain_whitelist', ''],
          ['app_name', 'Prado Chat'],
          ['default_theme', 'dark'],
          ['default_accent_color', '#4CAF50'],
          ['max_upload_size_mb', '100'],
          ['maintenance_mode', 'false'],
          ['maintenance_message', 'System is undergoing maintenance. Please check back soon.'],
        ];
        defaults.forEach(([k, v]) => {
          db.run(`INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)`, [k, v]);
        });
      });
    });
  }
});

// -- VAPID Key Setup --
const VAPID_FILE = './data/vapid.json';
let vapidKeys;
if (fs.existsSync(VAPID_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys));
}

webpush.setVapidDetails(
  'mailto:admin@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

const sendPushNotification = (userId, payload) => {
  db.all('SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = ?', [userId], (err, rows) => {
    if (err || !rows) return;
    rows.forEach(row => {
      try {
        const subscription = {
          endpoint: row.endpoint,
          keys: {
            p256dh: row.keys_p256dh,
            auth: row.keys_auth
          }
        };
        webpush.sendNotification(subscription, JSON.stringify(payload))
          .then(() => console.log(`Push sent to user ${userId}`))
          .catch(err => {
            console.error(`Push failed for user ${userId}:`, err.statusCode, err.body);
            if (err.statusCode === 404 || err.statusCode === 410) {
              db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [row.endpoint]);
            }
          });
      } catch (e) {
        console.error('Error sending push:', e);
      }
    });
  });
};

// -- Push Notification API Routes --
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super-secret-key');
    const userId = decoded.userId;
    const sub = req.body;
    if (!sub || !sub.endpoint || !sub.keys) {
      return res.status(400).json({ error: 'Invalid subscription object' });
    }
    // Atomic upsert using INSERT OR REPLACE
    db.run(
      'INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth) VALUES (?, ?, ?, ?)',
      [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
      (err) => {
        if (err) {
          console.error('Push subscribe DB error:', err);
          return res.status(500).json({ error: 'Database error' });
        }
        console.log(`Push subscription saved for user ${userId}`);
        res.json({ success: true });
      }
    );
  } catch (e) {
    console.error('Push subscribe JWT error:', e.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
});

app.delete('/api/push/subscribe', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super-secret-key');
    const userId = decoded.userId;
    db.run('DELETE FROM push_subscriptions WHERE user_id = ?', [userId], (err) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ success: true });
    });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';

// ─── Server-side key escrow crypto ─────────────────────────────
const ESCROW_KEY = crypto.scryptSync(JWT_SECRET, 'prado-escrow-salt', 32);

function serverEncrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ESCROW_KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag();
  return iv.toString('base64') + '.' + encrypted + '.' + tag.toString('base64');
}

function serverDecrypt(payload) {
  const [ivB64, dataB64, tagB64] = payload.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ESCROW_KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  let decrypted = decipher.update(dataB64, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// -- Authentication Routes --
// ─── Config helper ─────────────────────────────────────────────
const getConfig = (key, fallback = null) => new Promise((resolve) => {
  db.get('SELECT value FROM config WHERE key = ?', [key], (err, row) => {
    resolve(row?.value ?? fallback);
  });
});

// Public config (non-admin, for login page)
app.get('/api/config/public', (req, res) => {
  db.all('SELECT key, value FROM config WHERE key IN ("app_name", "registration_mode", "maintenance_mode", "maintenance_message", "default_theme", "default_accent_color", "custom_logo")', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    const config = {};
    rows.forEach(r => { config[r.key] = r.value; });
    res.json(config);
  });
});

// Logo upload endpoint (admin only)
app.post('/api/config/logo', authenticateToken, upload.single('logo'), (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  
  const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
  const newName = `custom_logo${ext}`;
  const newPath = path.join(UPLOADS_DIR, newName);
  
  // Remove old logo if exists
  try { fs.renameSync(req.file.path, newPath); } catch(e) { /* ignore */ }
  
  const logoUrl = `/uploads/${newName}`;
  db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', ['custom_logo', logoUrl], (err) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ logo: logoUrl });
  });
});

app.post('/api/register', async (req, res) => {
  const { password, email, publicKey, wrappedPrivateKey } = req.body;
  if (!password || !email || !publicKey || !wrappedPrivateKey) {
    return res.status(400).json({ error: 'Email, password, and E2EE keys required' });
  }
  try {
    // Check registration mode
    const regMode = await getConfig('registration_mode', 'open');
    if (regMode === 'closed') {
      return res.status(403).json({ error: 'Registration is currently closed' });
    }
    // Check email domain whitelist
    const whitelist = await getConfig('email_domain_whitelist', '');
    if (whitelist) {
      const allowed = whitelist.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
      if (allowed.length > 0) {
        const domain = email.split('@')[1]?.toLowerCase();
        if (!allowed.includes(domain)) {
          return res.status(403).json({ error: `Registration is restricted to: ${allowed.join(', ')}` });
        }
      }
    }
    const hash = await bcrypt.hash(password, 10);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const baseUrl = req.headers.origin || 'http://localhost:5173';
    const prefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
    const salt = crypto.randomBytes(2).toString('hex');
    const username = `${prefix}${salt}`;
    
    // Check if this is the first user
    db.get('SELECT COUNT(*) as count FROM users', [], async (err, row) => {
      if (err) {
        console.error("SELECT COUNT users error:", err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      const role = row.count === 0 ? 'admin' : 'user';
      // Check if email verification is required via config
      const requireVerify = await getConfig('require_email_verification', 'true');
      const skipVerification = row.count === 0 || requireVerify === 'false';
      const isVerified = skipVerification ? 1 : 0; 
      const vt = skipVerification ? null : verifyToken;
      
      db.run('INSERT INTO users (username, email, password_hash, role, is_verified, verification_token, public_key, wrapped_private_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [username, email, hash, role, isVerified, vt, publicKey, wrappedPrivateKey], async function (err) {
        if (err) {
          console.error("INSERT new user error:", err);
          if (err.message.includes('UNIQUE constraint failed') || err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username or Email already exists' });
          }
          return res.status(500).json({ error: 'Database error' });
        }
        
        const newUserId = this.lastID;
        db.run(`INSERT INTO spaces (name, created_by, is_private, is_dm) VALUES (?, ?, 1, 1)`, [`self_${newUserId}_${Date.now()}`, username], function(err) {
          if (!err && this.lastID) {
            db.run(`INSERT INTO space_members (space_id, user_id) VALUES (?, ?)`, [this.lastID, newUserId]);
          }
        });

        if (isVerified === 0) {
          // Dispatch Resend Email
          try {
            const fromAddr = await getConfig('email_from', 'onboarding@resend.dev');
            const resendClient = await getResendClient();
            if (!resendClient) {
              console.error('Resend API key not configured — cannot send verification email');
              return res.status(201).json({ message: 'Account created but email verification could not be sent. Contact admin.', role });
            }
            await resendClient.emails.send({
              from: `Prado Chat Security <${fromAddr}>`,
              to: email,
              subject: 'Verify your Prado Chat Account',
              html: `
                <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f5; padding: 40px 20px; text-align: center;">
                  <div style="background-color: #ffffff; max-width: 500px; margin: 0 auto; padding: 40px; border-radius: 16px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                    <img src="${baseUrl}/icon.png" width="64" height="64" style="border-radius: 14px; margin-bottom: 24px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);" alt="Prado Chat" />
                    <h1 style="color: #18181b; font-size: 24px; margin-top: 0; margin-bottom: 16px; font-weight: 700;">Welcome to Prado Chat!</h1>
                    <p style="color: #3f3f46; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">Hi <strong>${email}</strong>,<br><br>You're almost there! We just need to verify your email address before granting you access to the workspace.</p>
                    <a href="${baseUrl}/verify?token=${verifyToken}" style="display: inline-block; padding: 14px 32px; background-color: #4CAF50; color: #ffffff; font-weight: 600; font-size: 16px; text-decoration: none; border-radius: 8px; letter-spacing: 0.5px;">Verify Email</a>
                    <p style="margin-top: 40px; font-size: 13px; color: #71717a; max-width: 400px; margin-left: auto; margin-right: auto; line-height: 1.5;">If you did not sign up for this account, please ignore this email safely.</p>
                  </div>
                </div>
              `
            });
            res.status(201).json({ message: 'Registration successful. Check your email to verify your account.', role });
          } catch (emailErr) {
            console.error('Resend Error:', emailErr);
            res.status(500).json({ error: 'Failed to send verification email. Contact admin.' });
          }
        } else {
           res.status(201).json({ message: 'Admin account generated successfully.', role });
        }
      });
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.is_verified === 0) {
      return res.status(403).json({ error: 'Check your email to verify your account before logging in.' });
    }

    if (user.suspended) {
      return res.status(403).json({ error: 'Account suspended. Contact administrator.' });
    }

    const role = user.role || 'user';
    const token = jwt.sign({ userId: user.id, username: user.username, role }, JWT_SECRET, { expiresIn: '7d' });
    
    // Record login history
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip;
    const ua = req.headers['user-agent'] || 'Unknown';
    db.run('INSERT INTO login_history (user_id, ip_address, user_agent) VALUES (?, ?, ?)', [user.id, ip, ua]);
    res.json({
      token,
      username: user.username,
      role,
      theme: user.theme || 'dark',
      color_palette: user.color_palette || 'purple',
      avatar: user.avatar || null,
      font_family: user.font_family || null,
      wrapped_private_key: user.wrapped_private_key || null
    });
  });
});

app.get('/api/verify', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Missing verification token.' });

  db.get('SELECT id FROM users WHERE verification_token = ?', [token], (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error.' });
    if (!user) return res.status(400).json({ error: 'Invalid or expired verification token.' });

    db.run('UPDATE users SET is_verified = 1, verification_token = NULL WHERE id = ?', [user.id], function(updateErr) {
      if (updateErr) return res.status(500).json({ error: 'Failed to verify account.' });
      res.json({ message: 'Account successfully verified! You may now log in.' });
    });
  });
});

app.post('/api/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  db.get('SELECT id, username FROM users WHERE email = ?', [email], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!user) return res.status(200).json({ message: 'If that email exists, a reset link has been dispatched.' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 3600000; // 1 hour
    const baseUrl = req.headers.origin || 'http://localhost:5173';

    db.run('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?', [resetToken, expires, user.id], async (updateErr) => {
      if (updateErr) return res.status(500).json({ error: 'Server error' });

      try {
        await resend.emails.send({
          from: 'Prado Chat Security <admin@pradolane.com>',
          to: email,
          subject: 'Password Reset Request',
          html: `
            <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f5; padding: 40px 20px; text-align: center;">
              <div style="background-color: #ffffff; max-width: 500px; margin: 0 auto; padding: 40px; border-radius: 16px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                <img src="${baseUrl}/icon.png" width="64" height="64" style="border-radius: 14px; margin-bottom: 24px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);" alt="Prado Chat" />
                <h1 style="color: #18181b; font-size: 24px; margin-top: 0; margin-bottom: 16px; font-weight: 700;">Password Reset Request</h1>
                <p style="color: #3f3f46; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">Hi <strong>${email}</strong>,<br><br>We received a secure request to reset your Prado Chat password. Click the button below to get started.</p>
                <a href="${baseUrl}/reset-password?token=${resetToken}" style="display: inline-block; padding: 14px 32px; background-color: #4CAF50; color: #ffffff; font-weight: 600; font-size: 16px; text-decoration: none; border-radius: 8px; letter-spacing: 0.5px;">Reset Password</a>
                <p style="margin-top: 40px; font-size: 13px; color: #71717a; max-width: 400px; margin-left: auto; margin-right: auto; line-height: 1.5;">This secure link expires in 1 hour.<br>If you did not request this, please safely ignore this email.</p>
              </div>
            </div>
          `
        });
        res.status(200).json({ message: 'If that email exists, a reset link has been dispatched.' });
      } catch (emailErr) {
        res.status(500).json({ error: 'Failed to dispatch email' });
      }
    });
  });
});

app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });

  const now = Date.now();
  db.get('SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > ?', [token, now], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset token.' });

    try {
      const hash = await bcrypt.hash(newPassword, 10);
      db.run('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, is_verified = 1 WHERE id = ?', [hash, user.id], (updateErr) => {
        if (updateErr) return res.status(500).json({ error: 'Database error' });
        res.status(200).json({ message: 'Password reset successfully completed' });
      });
    } catch(hashErr) {
      res.status(500).json({ error: 'Server error' });
    }
  });
});

// Verify Token Middleware for REST
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];
  
  if (!token && req.query.token) {
    token = req.query.token;
  }
  
  if (!token) return res.status(401).json({ error: 'Authentication error' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    
    db.get('SELECT id, suspended FROM users WHERE id = ?', [user.userId], (dbErr, dbUser) => {
      if (dbErr || !dbUser) return res.status(401).json({ error: 'User missing' });
      if (dbUser.suspended) return res.status(403).json({ error: 'Account suspended. Contact administrator.' });
      req.user = user;
      next();
    });
  });
};

app.get('/api/profile', authenticateToken, (req, res) => {
  db.get('SELECT id, username, role, theme, color_palette, avatar, first_name, last_name, email, location, font_family, bio, status_text, status_emoji, timezone, public_key FROM users WHERE id = ?', [req.user.userId], (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });
});

app.get('/api/users', authenticateToken, (req, res) => {
  db.all('SELECT id, username, avatar, first_name, last_name, public_key, status_text, status_emoji, timezone FROM users ORDER BY username ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows);
  });
});

app.get('/api/push/key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', authenticateToken, (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  const subStr = JSON.stringify(subscription);
  
  // Update if exists, else insert
  db.get('SELECT id FROM push_subscriptions WHERE user_id = ? AND subscription = ?', [req.user.userId, subStr], (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (row) return res.status(200).json({ message: 'Subscribed' });
    
    db.run('INSERT INTO push_subscriptions (user_id, subscription) VALUES (?, ?)', [req.user.userId, subStr], (err) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.status(201).json({ message: 'Subscribed' });
    });
  });
});

app.put('/api/profile', authenticateToken, (req, res) => {
  const { theme, color_palette, avatar, first_name, last_name, email, location, font_family, bio, status_text, status_emoji, timezone, public_key, wrapped_private_key } = req.body;

  db.run(`UPDATE users SET 
    theme = COALESCE(?, theme), 
    color_palette = COALESCE(?, color_palette), 
    avatar = COALESCE(?, avatar),
    first_name = COALESCE(?, first_name),
    last_name = COALESCE(?, last_name),
    email = COALESCE(?, email),
    location = COALESCE(?, location),
    font_family = COALESCE(?, font_family),
    bio = COALESCE(?, bio),
    status_text = COALESCE(?, status_text),
    status_emoji = COALESCE(?, status_emoji),
    timezone = COALESCE(?, timezone),
    public_key = COALESCE(?, public_key),
    wrapped_private_key = COALESCE(?, wrapped_private_key)
    WHERE id = ?`, 
    [theme, color_palette, avatar, first_name, last_name, email, location, font_family, bio, status_text, status_emoji, timezone, public_key, wrapped_private_key, req.user.userId], 
    function(err) {
      if (err) return res.status(500).json({ error: 'Update failed' });
      // Broadcast profile changes to all connected clients
      db.get('SELECT username, avatar, font_family, location, status_text, status_emoji FROM users WHERE id = ?', [req.user.userId], (dbErr, row) => {
        if (!dbErr && row) {
          io.emit('user profile updated', {
            username: row.username,
            avatar: row.avatar,
            font_family: row.font_family,
            location: row.location,
            status_text: row.status_text,
            status_emoji: row.status_emoji
          });
        }
      });
      res.json({ message: 'Profile updated' });
    }
  );
});

// Admin Middleware
const requireAdmin = (req, res, next) => {
  db.get('SELECT role FROM users WHERE id = ?', [req.user.userId], (err, row) => {
    if (err || !row || row.role !== 'admin') {
      return res.status(403).json({ error: 'Requires admin privileges' });
    }
    next();
  });
};

// Audit log helper
function logAudit(adminId, adminUsername, action, targetType, targetId, details) {
  db.run('INSERT INTO audit_log (admin_id, admin_username, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
    [adminId, adminUsername, action, targetType, String(targetId), typeof details === 'object' ? JSON.stringify(details) : details]);
}

app.get('/api/settings', (req, res) => {
  db.all('SELECT key, value FROM app_settings', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    const settings = {};
    rows.forEach(row => settings[row.key] = row.value);
    res.json(settings);
  });
});

app.put('/api/admin/settings', authenticateToken, requireAdmin, (req, res) => {
  const { key, value } = req.body;
  if (!key || value === undefined) return res.status(400).json({ error: 'Key and value required' });
  
  db.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value], function(err) {
    if (err) return res.status(500).json({ error: 'Update failed', details: err.message });
    res.json({ success: true });
    // Broadcast the setting update directly to all connected clients
    io.emit('settings-updated', { [key]: value });
  });
});

app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
  db.all('SELECT id, username, role, first_name, last_name, email, location, avatar, theme, color_palette, font_family, bio, status_text, status_emoji, timezone, public_key, created_at, suspended FROM users ORDER BY id ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows);
  });
});

app.put('/api/admin/users/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { username, role, theme, color_palette, avatar, first_name, last_name, email, location, font_family, bio, status_text, status_emoji, timezone } = req.body;

  db.run(`UPDATE users SET 
    username = COALESCE(?, username),
    role = COALESCE(?, role),
    theme = COALESCE(?, theme), 
    color_palette = COALESCE(?, color_palette), 
    avatar = COALESCE(?, avatar),
    first_name = COALESCE(?, first_name),
    last_name = COALESCE(?, last_name),
    email = COALESCE(?, email),
    location = COALESCE(?, location),
    font_family = COALESCE(?, font_family),
    bio = COALESCE(?, bio),
    status_text = COALESCE(?, status_text),
    status_emoji = COALESCE(?, status_emoji),
    timezone = COALESCE(?, timezone)
    WHERE id = ?`, 
    [username, role, theme, color_palette, avatar, first_name, last_name, email, location, font_family, bio, status_text, status_emoji, timezone, id], 
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: 'Username already taken' });
        }
        return res.status(500).json({ error: 'Update failed' });
      }
      if (this.changes === 0) return res.status(404).json({ error: 'User not found' });    
      
      db.get('SELECT username, avatar, font_family, location, status_text, status_emoji FROM users WHERE id = ?', [id], (dbErr, row) => {
        if (!dbErr && row) {
          io.emit('user profile updated', {
            username: row.username,
            avatar: row.avatar,
            font_family: row.font_family,
            location: row.location,
            status_text: row.status_text,
            status_emoji: row.status_emoji
          });
        }
        res.json({ message: 'User updated successfully' });
      });
    }
  );
});

app.put('/api/admin/users/:id/role', authenticateToken, requireAdmin, (req, res) => {
  const { role } = req.body;
  if (role !== 'admin' && role !== 'user') return res.status(400).json({ error: 'Invalid role' });
  db.run('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'Update failed' });
    res.json({ success: true });
  });
});

app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, (req, res) => {
  const targetId = req.params.id;
  if (targetId == req.user.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.run('DELETE FROM users WHERE id = ?', [targetId], function(err) {
    if (err) return res.status(500).json({ error: 'Delete failed' });
    logAudit(req.user.userId, req.user.username, 'delete_user', 'user', targetId, null);
    res.json({ success: true });
  });
});

// -- Suspend/Unsuspend user --
app.put('/api/admin/users/:id/suspend', authenticateToken, requireAdmin, (req, res) => {
  const targetId = req.params.id;
  if (targetId == req.user.userId) return res.status(400).json({ error: 'Cannot suspend yourself' });
  db.get('SELECT suspended FROM users WHERE id = ?', [targetId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    const newStatus = user.suspended ? 0 : 1;
    db.run('UPDATE users SET suspended = ? WHERE id = ?', [newStatus, targetId], function(err) {
      if (err) return res.status(500).json({ error: 'Update failed' });
      // If suspending, disconnect their active sockets
      if (newStatus === 1) {
        for (const [, socket] of io.sockets.sockets) {
          if (socket.user && socket.user.userId == targetId) {
            socket.emit('force_logout', { reason: 'Account suspended by administrator' });
            socket.disconnect(true);
          }
        }
      }
      res.json({ suspended: newStatus });
      logAudit(req.user.userId, req.user.username, newStatus ? 'suspend_user' : 'unsuspend_user', 'user', targetId, null);
    });
  });
});

// -- Login history for a user --
app.get('/api/admin/users/:id/logins', authenticateToken, requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const offset = parseInt(req.query.offset) || 0;
  db.all('SELECT * FROM login_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?', 
    [req.params.id, limit, offset], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      db.get('SELECT COUNT(*) as total FROM login_history WHERE user_id = ?', [req.params.id], (err2, countRow) => {
        res.json({ logins: rows || [], total: countRow?.total || 0 });
      });
  });
});

// -- Export all users as JSON --
app.get('/api/admin/users/export', authenticateToken, requireAdmin, (req, res) => {
  const format = req.query.format || 'csv';
  db.all('SELECT id, username, email, role, first_name, last_name, location, bio, suspended, created_at FROM users ORDER BY id', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (format === 'csv') {
      const headers = ['id','username','email','role','first_name','last_name','location','bio','suspended','created_at'];
      const csvLines = [headers.join(',')];
      rows.forEach(r => {
        csvLines.push(headers.map(h => {
          let val = r[h] ?? '';
          val = String(val).replace(/"/g, '""');
          return val.includes(',') || val.includes('"') || val.includes('\n') ? '"' + val + '"' : val;
        }).join(','));
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=users_export.csv');
      res.send(csvLines.join('\n'));
    } else {
      res.json(rows);
    }
  });
});

// -- Bulk suspend users --
app.post('/api/admin/users/bulk-suspend', authenticateToken, requireAdmin, (req, res) => {
  const { userIds, suspend } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) return res.status(400).json({ error: 'No users specified' });
  const filtered = userIds.filter(id => id != req.user.userId);
  if (filtered.length === 0) return res.status(400).json({ error: 'Cannot suspend yourself' });
  const placeholders = filtered.map(() => '?').join(',');
  db.run(`UPDATE users SET suspended = ? WHERE id IN (${placeholders})`, [suspend ? 1 : 0, ...filtered], function(err) {
    if (err) return res.status(500).json({ error: 'Update failed' });
    // Disconnect suspended users
    if (suspend) {
      for (const [, socket] of io.sockets.sockets) {
        if (socket.user && filtered.includes(socket.user.userId)) {
          socket.emit('force_logout', { reason: 'Account suspended by administrator' });
          socket.disconnect(true);
        }
      }
    }
    res.json({ updated: this.changes });
  });
});

// -- Bulk delete users --
app.post('/api/admin/users/bulk-delete', authenticateToken, requireAdmin, (req, res) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) return res.status(400).json({ error: 'No users specified' });
  const filtered = userIds.filter(id => id != req.user.userId);
  if (filtered.length === 0) return res.status(400).json({ error: 'Cannot delete yourself' });
  const placeholders = filtered.map(() => '?').join(',');
  db.run(`DELETE FROM users WHERE id IN (${placeholders})`, filtered, function(err) {
    if (err) return res.status(500).json({ error: 'Delete failed' });
    res.json({ deleted: this.changes });
    logAudit(req.user.userId, req.user.username, 'bulk_delete_users', 'user', filtered.join(','), null);
  });
});

// ═══ Phase 4: Moderation & Audit ═══

// -- Audit Log --
app.get('/api/admin/audit-log', authenticateToken, requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const action = req.query.action;
  
  let query = 'SELECT * FROM audit_log';
  let params = [];
  if (action) {
    query += ' WHERE action = ?';
    params.push(action);
  }
  query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    db.get('SELECT COUNT(*) as total FROM audit_log' + (action ? ' WHERE action = ?' : ''), action ? [action] : [], (err2, countRow) => {
      res.json({ logs: rows || [], total: countRow?.total || 0 });
    });
  });
});

// -- Message Reports --
app.post('/api/messages/:id/report', authenticateToken, (req, res) => {
  const messageId = req.params.id;
  const { reason, spaceId } = req.body;
  if (!reason) return res.status(400).json({ error: 'Reason required' });
  
  db.get('SELECT text, sender FROM messages WHERE id = ?', [messageId], (err, msg) => {
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    
    // Check for duplicate report
    db.get('SELECT id FROM message_reports WHERE reporter_id = ? AND message_id = ? AND status = ?', [req.user.userId, messageId, 'pending'], (err, existing) => {
      if (existing) return res.status(409).json({ error: 'Already reported' });
      
      db.run('INSERT INTO message_reports (reporter_id, reporter_username, message_id, space_id, message_text, message_sender, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.user.userId, req.user.username, messageId, spaceId || null, msg.text, msg.sender, reason], function(err) {
          if (err) return res.status(500).json({ error: 'Report failed' });
          res.json({ id: this.lastID, message: 'Report submitted' });
        });
    });
  });
});

app.get('/api/admin/reports', authenticateToken, requireAdmin, (req, res) => {
  const status = req.query.status || 'pending';
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  
  db.all('SELECT * FROM message_reports WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [status, limit, offset], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    db.get('SELECT COUNT(*) as total FROM message_reports WHERE status = ?', [status], (err2, c) => {
      db.get('SELECT COUNT(*) as pending FROM message_reports WHERE status = ?', ['pending'], (err3, p) => {
        res.json({ reports: rows || [], total: c?.total || 0, pendingCount: p?.pending || 0 });
      });
    });
  });
});

app.put('/api/admin/reports/:id', authenticateToken, requireAdmin, (req, res) => {
  const { status } = req.body; // 'resolved' | 'dismissed'
  if (!['resolved', 'dismissed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  
  db.run('UPDATE message_reports SET status = ?, resolved_by = ?, resolved_at = datetime("now") WHERE id = ?',
    [status, req.user.username, req.params.id], function(err) {
      if (err) return res.status(500).json({ error: 'Update failed' });
      logAudit(req.user.userId, req.user.username, status === 'resolved' ? 'resolve_report' : 'dismiss_report', 'report', req.params.id, null);
      
      // If resolved, optionally delete the message
      if (status === 'resolved' && req.body.deleteMessage) {
        db.get('SELECT message_id, space_id FROM message_reports WHERE id = ?', [req.params.id], (err, report) => {
          if (report) {
            db.run('DELETE FROM messages WHERE id = ?', [report.message_id]);
            io.emit('message deleted', { messageId: report.message_id, spaceId: report.space_id });
          }
        });
      }
      res.json({ success: true });
    });
});

// -- Word Filters --
app.get('/api/admin/word-filters', authenticateToken, requireAdmin, (req, res) => {
  db.all('SELECT * FROM word_filters ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows || []);
  });
});

app.post('/api/admin/word-filters', authenticateToken, requireAdmin, (req, res) => {
  const { pattern, action } = req.body;
  if (!pattern) return res.status(400).json({ error: 'Pattern required' });
  const filterAction = action === 'flag' ? 'flag' : 'block';
  
  db.run('INSERT OR IGNORE INTO word_filters (pattern, action) VALUES (?, ?)', [pattern.toLowerCase().trim(), filterAction], function(err) {
    if (err) return res.status(500).json({ error: 'Insert failed' });
    if (this.changes === 0) return res.status(409).json({ error: 'Filter already exists' });
    logAudit(req.user.userId, req.user.username, 'add_word_filter', 'filter', this.lastID, pattern);
    res.json({ id: this.lastID, pattern: pattern.toLowerCase().trim(), action: filterAction });
  });
});

app.delete('/api/admin/word-filters/:id', authenticateToken, requireAdmin, (req, res) => {
  db.run('DELETE FROM word_filters WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'Delete failed' });
    logAudit(req.user.userId, req.user.username, 'delete_word_filter', 'filter', req.params.id, null);
    res.json({ success: true });
  });
});

// -- Word filter check middleware for messages --
function checkWordFilters(text, callback) {
  db.all('SELECT * FROM word_filters', [], (err, filters) => {
    if (err || !filters || filters.length === 0) return callback(null, null);
    const lower = text.toLowerCase();
    for (const f of filters) {
      if (lower.includes(f.pattern)) {
        return callback(f.action, f.pattern);
      }
    }
    callback(null, null);
  });
}

// ═══ Phase 5: API Keys & Advanced Config ═══

// -- API Keys --
app.get('/api/admin/api-keys', authenticateToken, requireAdmin, (req, res) => {
  db.all('SELECT id, name, key_prefix, permissions, created_by, last_used, created_at FROM api_keys ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows || []);
  });
});

app.post('/api/admin/api-keys', authenticateToken, requireAdmin, (req, res) => {
  const { name, permissions } = req.body;
  if (!name) return res.status(400).json({ error: 'Key name required' });
  
  // Generate a secure API key  
  const rawKey = 'prado_' + crypto.randomBytes(32).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.substring(0, 12) + '...';
  const perm = ['read', 'write', 'admin'].includes(permissions) ? permissions : 'read';
  
  db.run('INSERT INTO api_keys (name, key_hash, key_prefix, permissions, created_by) VALUES (?, ?, ?, ?, ?)',
    [name, keyHash, keyPrefix, perm, req.user.username], function(err) {
      if (err) return res.status(500).json({ error: 'Key creation failed' });
      logAudit(req.user.userId, req.user.username, 'create_api_key', 'api_key', this.lastID, name);
      // Return the full key ONLY on creation - never again
      res.json({ id: this.lastID, name, key: rawKey, key_prefix: keyPrefix, permissions: perm });
    });
});

app.delete('/api/admin/api-keys/:id', authenticateToken, requireAdmin, (req, res) => {
  db.run('DELETE FROM api_keys WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'Delete failed' });
    logAudit(req.user.userId, req.user.username, 'revoke_api_key', 'api_key', req.params.id, null);
    res.json({ success: true });
  });
});

// -- Email Config Test --
app.post('/api/admin/test-email', authenticateToken, requireAdmin, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Email address required' });
  try {
    // Use admin-configured API key and from address (fall back to env var / defaults)
    const apiKey = await getConfig('resend_api_key', process.env.RESEND_API_KEY || '');
    const fromAddr = await getConfig('email_from', 'onboarding@resend.dev');
    if (!apiKey) return res.status(400).json({ error: 'No Resend API key configured. Set it in Config → Email Provider.' });

    const { Resend: ResendClient } = await import('resend');
    const testResend = new ResendClient(apiKey);
    const result = await testResend.emails.send({
      from: `Prado Chat <${fromAddr}>`,
      to,
      subject: 'Prado Chat — Test Email',
      html: '<h2>✅ Email Configuration Working</h2><p>If you received this email, your Prado Chat email provider is configured correctly.</p><p style="color: #888; font-size: 12px;">Sent at ' + new Date().toISOString() + '</p>'
    });
    if (result?.error) return res.status(500).json({ error: result.error.message || 'Resend API error' });
    logAudit(req.user.userId, req.user.username, 'test_email', 'config', 'email', to);
    res.json({ success: true, messageId: result?.data?.id });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Email send failed' });
  }
});

// -- Environment Info --
app.get('/api/admin/environment', authenticateToken, requireAdmin, async (req, res) => {
  // Check admin config DB for settings
  const turnServer = await getConfig('turn_server', '');
  const turnUsername = await getConfig('turn_username', '');
  const turnCredential = await getConfig('turn_credential', '');
  const resendKey = await getConfig('resend_api_key', process.env.RESEND_API_KEY || '');
  const giphyKey = await getConfig('giphy_api_key', process.env.GIPHY_API_KEY || '');

  const envInfo = {
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpus: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    uptime: process.uptime(),
    env: {
      NODE_ENV: { value: process.env.NODE_ENV || 'development', status: 'ok' },
      JWT_SECRET: process.env.JWT_SECRET
        ? { value: '••••••••', status: 'ok' }
        : { value: 'Using fallback', status: 'warn' },
      RESEND_API_KEY: resendKey
        ? { value: '••••' + resendKey.slice(-4), status: 'ok' }
        : { value: 'Not configured', status: 'error' },
      GIPHY_API_KEY: giphyKey
        ? { value: '••••' + giphyKey.slice(-4), status: 'ok' }
        : { value: 'Not configured', status: 'error' },
      TURN_SERVER: (turnServer || process.env.TURN_SERVER)
        ? { value: turnServer || process.env.TURN_SERVER, status: 'ok' }
        : { value: 'Not configured', status: 'error' },
      TURN_USERNAME: (turnUsername || process.env.TURN_USERNAME)
        ? { value: turnUsername || process.env.TURN_USERNAME, status: 'ok' }
        : { value: 'Not configured', status: 'error' },
      TURN_CREDENTIAL: (turnCredential || process.env.TURN_CREDENTIAL)
        ? { value: '••••••••', status: 'ok' }
        : { value: 'Not configured', status: 'error' },
    }
  };
  res.json(envInfo);
});

// -- ICE Servers for WebRTC (any authenticated user) --
app.get('/api/ice-servers', authenticateToken, async (req, res) => {
  const iceServers = [];

  // STUN server (from admin config or default)
  const stunServer = await getConfig('stun_server', 'stun:stun.l.google.com:19302');
  if (stunServer) {
    iceServers.push({ urls: stunServer });
  }

  // TURN server (from admin config)
  const turnServer = await getConfig('turn_server', '');
  const turnUsername = await getConfig('turn_username', '');
  const turnCredential = await getConfig('turn_credential', '');

  if (turnServer) {
    const turnEntry = { urls: turnServer };
    if (turnUsername) turnEntry.username = turnUsername;
    if (turnCredential) turnEntry.credential = turnCredential;
    iceServers.push(turnEntry);

    // Also add a UDP-based TURN entry if not already specified
    if (!turnServer.includes('?transport=')) {
      iceServers.push({
        urls: turnServer.replace('turn:', 'turns:').replace(':3478', ':5349'),
        username: turnUsername || undefined,
        credential: turnCredential || undefined,
      });
    }
  }

  // Fallback: always include Google STUN
  if (iceServers.length === 0) {
    iceServers.push(
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    );
  }

  res.json({ iceServers });
});

// -- Self-service password change (requires current password) --
app.put('/api/profile/password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.userId], async (err, user) => {
    if (err || !user) return res.status(500).json({ error: 'Database error' });
    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) return res.status(400).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.userId], function(err) {
      if (err) return res.status(500).json({ error: 'Update failed' });
      res.json({ message: 'Password updated successfully' });
    });
  });
});

// -- Admin: reset any user's password --
app.put('/api/admin/users/:id/password', authenticateToken, requireAdmin, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: 'New password required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const hash = await bcrypt.hash(newPassword, 10);
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'Update failed' });
    if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'Password reset successfully' });
  });
});

app.get('/api/admin/assets', authenticateToken, requireAdmin, (req, res) => {
  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: 'Failed to read assets' });
    const fileStats = files.map(file => {
      const stats = fs.statSync(path.join(UPLOADS_DIR, file));
      const ext = path.extname(file).toLowerCase();
      let type = 'application/octet-stream';
      if (ext.match(/\.(jpg|jpeg|png|gif|webp|heic|heif)$/)) type = `image/${ext.replace('.','')}`;
      else if (ext.match(/\.(mp4|mov|webm|mkv|3gp)$/)) type = `video/${ext.replace('.','')}`;
      else if (ext === '.pdf') type = 'application/pdf';
      else if (ext.match(/\.(ai|eps)$/)) type = `application/${ext === '.ai' ? 'illustrator' : 'postscript'}`;
      return { file, size: stats.size, created_at: stats.birthtime, type };
    });
    res.json(fileStats);
  });
});

app.delete('/api/admin/assets/:filename', authenticateToken, requireAdmin, (req, res) => {
  const filepath = path.join(UPLOADS_DIR, req.params.filename);
  // Security check to prevent path traversal
  if (!filepath.startsWith(UPLOADS_DIR)) return res.status(400).json({ error: 'Invalid path' });
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    
    // Also delete any messages that reference this asset
    const assetUrl = `/uploads/${req.params.filename}`;
    db.all('SELECT id, space_id FROM messages WHERE asset = ?', [assetUrl], (err, rows) => {
      if (!err && rows && rows.length > 0) {
        db.run('DELETE FROM messages WHERE asset = ?', [assetUrl], () => {
          // Tell all connected clients to remove these messages instantly
          rows.forEach(row => {
            io.to(row.space_id.toString()).emit('message deleted', { id: row.id });
          });
        });
      }
    });

    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

app.delete('/api/admin/spaces/:id', authenticateToken, requireAdmin, (req, res) => {
  const spaceId = req.params.id;
  if (spaceId == 1) return res.status(403).json({ error: 'Cannot delete the General space' });
  
  // Protect Notes to Self spaces from deletion
  db.get('SELECT name, is_dm FROM spaces WHERE id = ?', [spaceId], (err, space) => {
    if (err || !space) return res.status(404).json({ error: 'Space not found' });
    if (space.is_dm === 1 && space.name.startsWith('self_')) {
      return res.status(403).json({ error: 'Cannot delete Notes to Self spaces' });
    }
    
    db.run('DELETE FROM space_members WHERE space_id = ?', [spaceId], () => {
      db.run('DELETE FROM messages WHERE space_id = ?', [spaceId], (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        db.run('DELETE FROM spaces WHERE id = ?', [spaceId], function(err) {
          if (err) return res.status(500).json({ error: 'Database error' });
          res.json({ success: true });
        });
      });
    });
  });
});

// ─── Admin Dashboard Stats ─────────────────────────────────────
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
    const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });

    // User counts
    const totalUsersRow = await dbGet('SELECT COUNT(*) as count FROM users');
    const now = new Date().toISOString();
    const d24h = new Date(Date.now() - 86400000).toISOString();
    const d7d = new Date(Date.now() - 7 * 86400000).toISOString();
    const active24hRow = await dbGet('SELECT COUNT(DISTINCT sender) as count FROM messages WHERE timestamp > ?', [d24h]);
    const active7dRow = await dbGet('SELECT COUNT(DISTINCT sender) as count FROM messages WHERE timestamp > ?', [d7d]);

    // Message counts
    const totalMsgsRow = await dbGet('SELECT COUNT(*) as count FROM messages');

    // Total spaces
    const totalSpacesRow = await dbGet('SELECT COUNT(*) as count FROM spaces');

    // Storage: scan uploads directory
    let storageUsedBytes = 0;
    const storageBreakdown = { image: 0, video: 0, audio: 0, document: 0, other: 0 };
    try {
      const files = fs.readdirSync(UPLOADS_DIR);
      for (const file of files) {
        try {
          const stat = fs.statSync(path.join(UPLOADS_DIR, file));
          storageUsedBytes += stat.size;
          const ext = path.extname(file).toLowerCase();
          if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.heic'].includes(ext)) {
            storageBreakdown.image += stat.size;
          } else if (['.mp4', '.webm', '.mov', '.avi', '.mkv'].includes(ext)) {
            storageBreakdown.video += stat.size;
          } else if (['.mp3', '.ogg', '.wav', '.m4a', '.aac'].includes(ext)) {
            storageBreakdown.audio += stat.size;
          } else if (['.pdf', '.doc', '.docx', '.txt', '.csv', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar'].includes(ext)) {
            storageBreakdown.document += stat.size;
          } else {
            storageBreakdown.other += stat.size;
          }
        } catch (_) {}
      }
    } catch (_) {}

    // Message volume (last 30 days)
    const messageVolume = await dbAll(
      `SELECT DATE(timestamp) as date, COUNT(*) as count FROM messages 
       WHERE timestamp > DATE('now', '-30 days') 
       GROUP BY DATE(timestamp) ORDER BY date ASC`
    );

    // Active sessions from connected sockets
    const activeSessions = [];
    io.sockets.sockets.forEach(s => {
      if (s.user) {
        activeSessions.push({
          socketId: s.id,
          username: s.user.username,
          userId: s.user.userId,
          first_name: s.userProfile?.first_name || '',
          last_name: s.userProfile?.last_name || '',
          avatar: s.userProfile?.avatar || null,
          connectedAt: s.connectedAt || Date.now(),
          userAgent: s.userAgentStr || 'Unknown'
        });
      }
    });

    // DB size
    let dbSizeBytes = 0;
    try { dbSizeBytes = fs.statSync('./data/database.sqlite').size; } catch (_) {}

    // System info
    const memUsage = process.memoryUsage();

    res.json({
      totalUsers: totalUsersRow?.count || 0,
      activeUsers24h: active24hRow?.count || 0,
      activeUsers7d: active7dRow?.count || 0,
      totalMessages: totalMsgsRow?.count || 0,
      totalSpaces: totalSpacesRow?.count || 0,
      storageUsedBytes,
      storageBreakdown,
      messageVolume,
      activeSessions,
      serverUptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
      nodeVersion: process.version,
      dbSizeBytes,
      memoryUsage: { rss: memUsage.rss, heapUsed: memUsage.heapUsed, heapTotal: memUsage.heapTotal },
      osInfo: `${os.type()} ${os.arch()}`,
      osPlatform: os.platform(),
      cpuCount: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem()
    });
  } catch (err) {
    console.error('Stats endpoint error:', err);
    res.status(500).json({ error: 'Failed to gather stats' });
  }
});

// Force disconnect a socket
app.post('/api/admin/disconnect', authenticateToken, requireAdmin, (req, res) => {
  const { socketId } = req.body;
  const targetSocket = io.sockets.sockets.get(socketId);
  if (targetSocket) {
    targetSocket.disconnect(true);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Socket not found' });
  }
});

// ─── Admin Config API ──────────────────────────────────────────
app.get('/api/admin/config', authenticateToken, requireAdmin, (req, res) => {
  db.all('SELECT key, value, updated_at FROM config', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    const config = {};
    rows.forEach(r => { config[r.key] = r.value; });
    res.json(config);
  });
});

app.put('/api/admin/config', authenticateToken, requireAdmin, (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Invalid config data' });
  const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime("now"))');
  for (const [key, value] of Object.entries(updates)) {
    stmt.run(key, String(value));
  }
  stmt.finalize();
  res.json({ success: true });
});

// ─── Server-side Key Escrow endpoints ──────────────────────────
// Store escrow key when a room key is first created
app.post('/api/spaces/:id/escrow-key', authenticateToken, (req, res) => {
  const spaceId = req.params.id;
  const { rawKeyBase64 } = req.body;
  if (!rawKeyBase64) return res.status(400).json({ error: 'rawKeyBase64 required' });
  const encrypted = serverEncrypt(rawKeyBase64);
  db.run('UPDATE spaces SET escrow_key = ? WHERE id = ?', [encrypted, spaceId], (err) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ success: true });
  });
});

// Request key from escrow: server decrypts escrow, re-wraps with user's public key, stores, returns
app.get('/api/spaces/:id/request-key', authenticateToken, (req, res) => {
  const spaceId = req.params.id;
  const userId = req.user.userId;
  // Always re-wrap from escrow to handle public key changes (e.g. after key regen)
  // Check membership (private space) or public access
  db.get('SELECT 1 as ok FROM space_members WHERE space_id = ? AND user_id = ? UNION SELECT 1 as ok FROM spaces WHERE id = ? AND is_private = 0', [spaceId, userId, spaceId], (err, access) => {
    if (!access) return res.status(403).json({ error: 'Not a member of this space' });
      // Get escrow key and user's public key
      db.get('SELECT escrow_key FROM spaces WHERE id = ?', [spaceId], (err, space) => {
        if (!space?.escrow_key) return res.status(404).json({ error: 'No escrow key available for this space' });
        db.get('SELECT public_key FROM users WHERE id = ?', [userId], async (err, user) => {
          if (!user?.public_key) return res.status(404).json({ error: 'User has no public key' });
          try {
            // Decrypt escrow to get raw AES key bytes
            const rawKeyBase64 = serverDecrypt(space.escrow_key);
            const rawKeyBuffer = Buffer.from(rawKeyBase64, 'base64');
            // Import user's RSA public key and wrap the AES key
            const pubKeyJWK = JSON.parse(user.public_key);
            const publicKey = crypto.createPublicKey({ key: pubKeyJWK, format: 'jwk' });
            const encryptedForUser = crypto.publicEncrypt(
              { key: publicKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
              rawKeyBuffer
            );
            const wrappedB64 = encryptedForUser.toString('base64');
            // Store in space_keys
            db.run('INSERT OR REPLACE INTO space_keys (space_id, user_id, encrypted_room_key) VALUES (?, ?, ?)',
              [spaceId, userId, wrappedB64], (err) => {
                if (err) console.error('Failed to store re-wrapped key', err);
                res.json({ encrypted_room_key: wrappedB64 });
              });
          } catch (e) {
            console.error('Escrow key recovery failed:', e);
            res.status(500).json({ error: 'Key recovery failed' });
          }
        });
    });
  });
});

app.get('/api/spaces/keys', authenticateToken, (req, res) => {
  db.all('SELECT space_id, encrypted_room_key FROM space_keys WHERE user_id = ?', [req.user.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows);
  });
});

app.get('/api/spaces', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const isAdmin = req.user.role === 'admin';
  
  const selectClause = `
    SELECT s.*, 
    u.first_name as dm_first, 
    u.last_name as dm_last, 
    u.username as dm_username,
    u.avatar as dm_avatar
    FROM spaces s
    LEFT JOIN space_members sm ON s.id = sm.space_id AND s.is_dm = 1 AND sm.user_id != ?
    LEFT JOIN users u ON sm.user_id = u.id
  `;

  let query = '';
  if (isAdmin) {
    query = `
      ${selectClause}
      WHERE s.is_dm = 0
      OR (s.is_dm = 1 AND s.id IN (SELECT space_id FROM space_members WHERE user_id = ?))
      GROUP BY s.id
      ORDER BY s.id ASC
    `;
  } else {
    query = `
      ${selectClause}
      WHERE (s.is_dm = 0 AND (s.is_private != 1 AND s.is_private != '1' AND s.is_private != 'true' OR s.is_private IS NULL))
      OR s.id IN (SELECT space_id FROM space_members WHERE user_id = ?)
      GROUP BY s.id
      ORDER BY s.id ASC
    `;
  }
  
  db.all(query, [userId, userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows);
  });
});

app.post('/api/spaces', authenticateToken, (req, res) => {
  const { name, is_private, invited_users, keyShares } = req.body;
  if (!name || name.trim() === '') return res.status(400).json({ error: 'Space name required' });
  
  const isPrivate = is_private ? 1 : 0;
  const inviteKey = isPrivate ? crypto.randomBytes(16).toString('hex') : null;

  db.run('INSERT INTO spaces (name, created_by, is_private, invite_key) VALUES (?, ?, ?, ?)', 
    [name.trim(), req.user.username, isPrivate, inviteKey], function(err) {
    if (err) {
      if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Space name already exists' });
      return res.status(500).json({ error: 'Database error' });
    }
    const spaceId = this.lastID;
    const newSpaceObj = { id: spaceId, name: name.trim(), created_by: req.user.username, is_private: isPrivate, invite_key: inviteKey };
    
    // Insert PKI Key Shares for the creator and any invited users
    if (keyShares && typeof keyShares === 'object') {
      const shareUserIds = Object.keys(keyShares);
      if (shareUserIds.length > 0) {
        const placeholders = shareUserIds.map(() => '(?, ?, ?)').join(', ');
        const values = [];
        shareUserIds.forEach(uId => {
           values.push(spaceId, Number(uId), keyShares[uId]);
        });
        db.run(`INSERT INTO space_keys (space_id, user_id, encrypted_room_key) VALUES ${placeholders}`, values, (keyErr) => {
          if (keyErr) console.error('Failed to insert space_keys', keyErr);
        });
      }
    }
    
    const broadcastSpace = () => {
      if (!isPrivate) {
        io.emit('space created', newSpaceObj);
      } else {
        const allowedIds = [req.user.userId, ...(Array.isArray(invited_users) ? invited_users : [])];
        // Iterate active sockets checking Auth tokens to push private creation events safely
        io.sockets.sockets.forEach(s => {
          if (s.user && (allowedIds.includes(s.user.userId) || s.user.role === 'admin')) {
            s.emit('space created', newSpaceObj);
          }
        });
      }
    };

    if (isPrivate) {
      db.run('INSERT INTO space_members (space_id, user_id) VALUES (?, ?)', [spaceId, req.user.userId], () => {
        if (Array.isArray(invited_users) && invited_users.length > 0) {
          const placeholders = invited_users.map(() => '(?, ?)').join(',');
          const values = [];
          invited_users.forEach(uid => { values.push(spaceId, uid); });
          
          db.run(`INSERT INTO space_members (space_id, user_id) VALUES ${placeholders}`, values, (err) => {
            res.status(201).json(newSpaceObj);
            broadcastSpace();
          });
        } else {
          res.status(201).json(newSpaceObj);
          broadcastSpace();
        }
      });
    } else {
      res.status(201).json(newSpaceObj);
      broadcastSpace();
    }
  });
});

app.post('/api/spaces/join/:invite_key', authenticateToken, (req, res) => {
  const { invite_key } = req.params;
  
  db.get('SELECT * FROM spaces WHERE invite_key = ?', [invite_key], (err, space) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!space) return res.status(404).json({ error: 'Invalid or expired invite link.' });
    
    db.get('SELECT * FROM space_members WHERE space_id = ? AND user_id = ?', [space.id, req.user.userId], (err, existing) => {
      if (existing) {
        return res.json({ message: 'Already a member', space });
      }
      db.run('INSERT INTO space_members (space_id, user_id) VALUES (?, ?)', [space.id, req.user.userId], (err) => {
        if (err) return res.status(500).json({ error: 'Failed to join space' });
        res.status(200).json({ message: 'Successfully joined private space', space });
      });
    });
  });
});

app.post('/api/spaces/:id/invite', authenticateToken, (req, res) => {
  const spaceId = req.params.id;
  const { invited_users, keyShares } = req.body;
  console.log(`[DEBUG INVITE] Hit invite route for spaceId=${spaceId}. Body:`, JSON.stringify(req.body));
  if (!Array.isArray(invited_users) || invited_users.length === 0) return res.status(400).json({ error: 'No users provided' });

  db.get('SELECT * FROM spaces WHERE id = ?', [spaceId], (err, space) => {
    if (err || !space) return res.status(404).json({ error: 'Space not found' });
    
    // Natively bypass existing users via SQLite IGNORE constraint on the (space_id, user_id) PRIMARY KEY
    const placeholders = invited_users.map(() => '(?, ?)').join(',');
    const values = [];
    invited_users.forEach(uid => { values.push(spaceId, uid); });
    
    db.run(`INSERT OR IGNORE INTO space_members (space_id, user_id) VALUES ${placeholders}`, values, function(err) {
      console.log(`[DEBUG INVITE] space_members insertion err:`, err);
      if (err) return res.status(500).json({ error: 'Failed to invite users' });
      
      // Upsert PKI Key Shares dynamically extending access to newly invited participants natively blindly.
      if (keyShares && typeof keyShares === 'object') {
        const shareUserIds = Object.keys(keyShares);
        if (shareUserIds.length > 0) {
          const kp = shareUserIds.map(() => '(?, ?, ?)').join(', ');
          const kv = [];
          shareUserIds.forEach(uId => {
             kv.push(spaceId, Number(uId), keyShares[uId]);
          });
          db.run(`INSERT OR IGNORE INTO space_keys (space_id, user_id, encrypted_room_key) VALUES ${kp}`, kv, function(keyErr) {
             console.log(`[DEBUG INVITE] space_keys insertion completed. changes=${this.changes}, err=`, keyErr);
             if (keyErr) console.error('Failed to insert space_keys for invites', keyErr);
          });
        }
      }

      // Selectively push the room exclusively to the newly validated active sockets
      io.sockets.sockets.forEach(s => {
        if (s.user && invited_users.includes(s.user.userId)) {
          s.emit('space invited', space);
        }
      });
      res.json({ success: true, space, inserted: this.changes });
    });
  });
});

app.get('/api/messages/:spaceId', authenticateToken, (req, res) => {
  const spaceId = req.params.spaceId;
  db.all('SELECT * FROM messages WHERE space_id = ? ORDER BY id ASC LIMIT 100', [spaceId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows);
  });
});

app.get('/api/gifs', authenticateToken, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const apiKey = await getConfig('giphy_api_key', process.env.GIPHY_API_KEY || '');
  if (!apiKey) return res.status(400).json({ error: 'Giphy API key not configured' });
  try {
    const response = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(q)}&limit=20&rating=g`);
    const data = await response.json();
    res.json(data.data || []);
  } catch(e) {
    console.error('Giphy API error:', e);
    res.status(500).json({ error: 'Giphy API error' });
  }
});

app.get('/api/spaces/:id/members', authenticateToken, (req, res) => {
  const spaceId = req.params.id;
  // Check if space is private (has members table) or public (all users can see it)
  db.get('SELECT is_private, is_dm FROM spaces WHERE id = ?', [spaceId], (err, space) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!space) return res.status(404).json({ error: 'Space not found' });

    if (space.is_private || space.is_dm) {
      // Private/DM: return actual members
      db.all(`SELECT u.id, u.username, u.first_name, u.last_name, u.avatar 
              FROM users u JOIN space_members sm ON u.id = sm.user_id 
              WHERE sm.space_id = ?`, [spaceId], (err2, rows) => {
        if (err2) return res.status(500).json({ error: 'Database error' });
        res.json(rows || []);
      });
    } else {
      // Public: return all users (they can all join)
      db.all(`SELECT id, username, first_name, last_name, avatar FROM users`, [], (err2, rows) => {
        if (err2) return res.status(500).json({ error: 'Database error' });
        res.json(rows || []);
      });
    }
  });
});

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', authenticateToken, (req, res) => {
  const subscription = req.body;
  const userId = req.user.userId;
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  
  db.run(`
    INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET 
      user_id=excluded.user_id,
      keys_p256dh=excluded.keys_p256dh,
      keys_auth=excluded.keys_auth
  `, [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to save subscription' });
    res.status(201).json({ success: true });
  });
});

app.delete('/api/push/unsubscribe', authenticateToken, (req, res) => {
  const endpoint = req.query.endpoint;
  const userId = req.user.userId;
  if (!endpoint) return res.status(400).json({ error: 'Endpoint required' });
  
  db.run(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`, [userId, endpoint], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to remove subscription' });
    res.json({ success: true });
  });
});

app.post('/api/dms', authenticateToken, (req, res) => {
  const targetUserId = parseInt(req.body.targetUserId, 10);
  const myUserId = parseInt(req.user.userId, 10);
  const { keyShares } = req.body;

  if (!targetUserId || !myUserId) return res.status(400).json({ error: 'Invalid parameters' });

  const isSelf = targetUserId === myUserId;

  const insertKeyShares = (spaceId, cb) => {
    if (keyShares && typeof keyShares === 'object') {
      const shareUserIds = Object.keys(keyShares);
      if (shareUserIds.length > 0) {
        const kp = shareUserIds.map(() => '(?, ?, ?)').join(', ');
        const kv = [];
        shareUserIds.forEach(uId => { kv.push(spaceId, Number(uId), keyShares[uId]); });
        db.run(`INSERT OR IGNORE INTO space_keys (space_id, user_id, encrypted_room_key) VALUES ${kp}`, kv, (err) => {
          if(err) console.error("DM KeyShare Error:", err);
          cb();
        });
        return;
      }
    }
    cb();
  };

  if (isSelf) {
    db.get(`SELECT id FROM spaces WHERE is_dm = 1 AND name LIKE ? LIMIT 1`, [`self_${myUserId}_%`], (err, row) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (row) return res.json({ spaceId: row.id });
      
      db.run(`INSERT INTO spaces (name, created_by, is_private, is_dm) VALUES (?, ?, 1, 1)`, [`self_${myUserId}_${Date.now()}`, req.user.username], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to create DM' });
        const newId = this.lastID;
        db.run(`INSERT INTO space_members (space_id, user_id) VALUES (?, ?)`, [newId, myUserId], () => {
          insertKeyShares(newId, () => {
            io.emit('space created', { id: newId, name: `self_${myUserId}`, created_by: req.user.username, is_private: 1, is_dm: 1 });
            res.json({ spaceId: newId });
          });
        });
      });
    });
  } else {
    // Find identical 2-user DM
    db.get(`
      SELECT s.id FROM spaces s 
      JOIN space_members sm1 ON s.id = sm1.space_id AND sm1.user_id = ?
      JOIN space_members sm2 ON s.id = sm2.space_id AND sm2.user_id = ?
      WHERE s.is_dm = 1 LIMIT 1
    `, [myUserId, targetUserId], (err, row) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (row) return res.json({ spaceId: row.id });

      // Build new 2-user DM space
      db.run(`INSERT INTO spaces (name, created_by, is_private, is_dm) VALUES (?, ?, 1, 1)`, [`dm_${myUserId}_${targetUserId}_${Date.now()}`, req.user.username], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to create DM' });
        const newId = this.lastID;
        db.run(`INSERT INTO space_members (space_id, user_id) VALUES (?, ?)`, [newId, myUserId], () => {
          db.run(`INSERT INTO space_members (space_id, user_id) VALUES (?, ?)`, [newId, targetUserId], () => {
            insertKeyShares(newId, () => {
              io.emit('space created', { id: newId, name: `dm_${myUserId}_${targetUserId}`, created_by: req.user.username, is_private: 1, is_dm: 1 });
              res.json({ spaceId: newId });
            });
          });
        });
      });
    });
  }
});

app.get('/api/spaces/:id/messages', authenticateToken, (req, res) => {
  const spaceId = parseInt(req.params.id, 10);
  const beforeId = parseInt(req.query.before_id, 10);
  if (!spaceId || isNaN(beforeId)) return res.status(400).json({ error: 'Invalid parameters' });

  const fetchMessages = () => {
    db.all(`
      SELECT m.id, m.text, m.sender, m.timestamp, u.avatar, m.asset, m.edited, m.is_pinned, m.reactions, u.first_name, u.last_name
      FROM messages m 
      LEFT JOIN users u ON m.sender = u.username 
      WHERE m.space_id = ? AND m.id < ? 
      ORDER BY m.id DESC LIMIT 50
    `, [spaceId, beforeId], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json(rows.reverse().map(r => ({ ...r, timestamp: r.timestamp ? r.timestamp + 'Z' : null })));
    });
  };

  db.get('SELECT * FROM spaces WHERE id = ?', [spaceId], (err, space) => {
    if (err || !space) return res.status(404).json({ error: 'Space not found' });
    if (space.is_private === 1 && req.user.role !== 'admin') {
      db.get('SELECT * FROM space_members WHERE space_id = ? AND user_id = ?', [spaceId, req.user.userId], (err, member) => {
        if (member) fetchMessages();
        else res.status(403).json({ error: 'Forbidden' });
      });
    } else {
      fetchMessages();
    }
  });
});

app.get('/api/spaces/:id/pinned', authenticateToken, (req, res) => {
  const spaceId = parseInt(req.params.id, 10);
  if (!spaceId) return res.status(400).json({ error: 'Invalid parameters' });

  const fetchPinned = () => {
    db.all(`
      SELECT m.id, m.text, m.sender, m.timestamp, u.avatar, m.asset, m.edited, m.is_pinned, m.reactions, u.first_name, u.last_name
      FROM messages m 
      LEFT JOIN users u ON m.sender = u.username 
      WHERE m.space_id = ? AND m.is_pinned = 1 
      ORDER BY m.id DESC
    `, [spaceId], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json(rows);
    });
  };

  db.get('SELECT * FROM spaces WHERE id = ?', [spaceId], (err, space) => {
    if (err || !space) return res.status(404).json({ error: 'Space not found' });
    if (space.is_private === 1 && req.user.role !== 'admin') {
      db.get('SELECT * FROM space_members WHERE space_id = ? AND user_id = ?', [spaceId, req.user.userId], (err, member) => {
        if (member) fetchPinned();
        else res.status(403).json({ error: 'Forbidden' });
      });
    } else {
      fetchPinned();
    }
  });
});

app.post('/api/spaces/:id/remove', authenticateToken, (req, res) => {
  const spaceId = parseInt(req.params.id, 10);
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'User ID required' });
  
  db.get('SELECT created_by FROM spaces WHERE id = ?', [spaceId], (err, space) => {
    if (err || !space) return res.status(404).json({ error: 'Space not found' });
    if (req.user.role !== 'admin' && req.user.username !== space.created_by) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    db.run('DELETE FROM space_members WHERE space_id = ? AND user_id = ?', [spaceId, parseInt(userId, 10)], function(err) {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (this.changes === 0) {
        console.error('REMOVE ERROR: No rows deleted for spaceId=', spaceId, 'userId=', userId);
        return res.status(400).json({ error: 'User is not in this space' });
      }
      io.sockets.emit('space left', { spaceId, userId });
      res.json({ success: true });
    });
  });
});

app.post('/api/spaces/:id/leave', authenticateToken, (req, res) => {
  const spaceId = parseInt(req.params.id, 10);
  const uId = parseInt(req.user.userId || req.user.id, 10);
  if (spaceId === 1) return res.status(403).json({ error: 'Cannot leave the General space' });
  
  db.run('DELETE FROM space_members WHERE space_id = ? AND user_id = ?', [spaceId, uId], function(err) {
    if (err) return res.status(500).json({ error: 'Failed to leave space' });
    if (this.changes === 0) {
      console.error('LEAVE ERROR: No rows deleted. spaceId=', spaceId, 'uId=', uId, 'req.user=', req.user);
      return res.status(400).json({ error: 'You are not in this space' });
    }
    io.sockets.emit('space left', { spaceId, userId: uId });
    res.json({ success: true });
  });
});

app.delete('/api/spaces/:id', authenticateToken, (req, res) => {
  const spaceId = parseInt(req.params.id, 10);
  if (spaceId === 1) return res.status(403).json({ error: 'Cannot delete the General space' });
  
  db.get('SELECT created_by, name, is_dm FROM spaces WHERE id = ?', [spaceId], (err, space) => {
    if (err || !space) return res.status(404).json({ error: 'Space not found' });
    
    // Protect Notes to Self spaces from deletion
    if (space.is_dm === 1 && space.name.startsWith('self_')) {
      return res.status(403).json({ error: 'Cannot delete your Notes to Self space' });
    }
    
    if (req.user.role !== 'admin' && req.user.username !== space.created_by) {
      return res.status(403).json({ error: 'Only admins or the creator can delete this space.' });
    }
    
    db.run('DELETE FROM space_members WHERE space_id = ?', [spaceId], () => {
      db.run('DELETE FROM messages WHERE space_id = ?', [spaceId], (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        db.run('DELETE FROM spaces WHERE id = ?', [spaceId], function(err) {
          if (err) return res.status(500).json({ error: 'Database error' });
          io.sockets.emit('space deleted', spaceId);
          res.json({ success: true });
        });
      });
    });
  });
});

app.post('/api/upload', authenticateToken, upload.single('asset'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Check max upload size from admin config
  const maxMb = parseInt(await getConfig('max_upload_size_mb', '100'));
  if (maxMb > 0 && req.file.size > maxMb * 1024 * 1024) {
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    return res.status(413).json({ error: `File exceeds maximum upload size of ${maxMb}MB` });
  }

  const origName = req.file.originalname || 'asset';
  let baseName = path.parse(origName).name.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 40) || 'asset';
  const originalExt = path.extname(origName).toLowerCase().replace('.', '');
  const type = req.file.mimetype || 'application/octet-stream';
  const ext = originalExt || type.split('/')[1].split('+')[0] || 'bin';
  
  const filename = `${crypto.randomUUID().slice(0, 8)}-${baseName}.${ext}`;
  const filepath = path.join(UPLOADS_DIR, filename);

  // Backend HEIC Transcoding
  if (ext === 'heic' || type === 'image/heic' || type === 'image/heif') {
    try {
      console.log(`HEIC image detected via HTTP upload, transcoding to JPEG...`);
      const heicBuffer = fs.readFileSync(req.file.path);
      const jpegBuffer = await heicConvert({ buffer: heicBuffer, format: 'JPEG', quality: 0.8 });
      const newFilename = `${crypto.randomUUID().slice(0, 8)}-${baseName}.jpg`;
      const newFilepath = path.join(UPLOADS_DIR, newFilename);
      fs.writeFileSync(newFilepath, jpegBuffer);
      try { fs.unlinkSync(req.file.path); } catch(e) {}
      return res.json({ url: `/uploads/${newFilename}` });
    } catch (err) {
      console.error('Backend HEIC transcoding failed (falling back to original):', err);
    }
  }

  // Backend Video Transcoding (HEVC + 3GP)
  const is3gp = ext === '3gp' || type === 'video/3gpp';
  if (type.startsWith('video/') || is3gp) {
    let isHevc = false;
    if (!is3gp) {
      isHevc = await new Promise((resolve) => {
        ffmpeg.ffprobe(req.file.path, (err, metadata) => {
          if (err) return resolve(false);
          const stream = metadata.streams && metadata.streams.find(s => s.codec_type === 'video');
          resolve(stream && (stream.codec_name === 'hevc' || stream.codec_name === 'h265'));
        });
      }).catch(() => false);
    }

    if (isHevc || is3gp) {
      console.log(`Unplayable video detected HTTP upload (${is3gp ? '3GP' : 'HEVC'}), transcoding to H.264...`);
      const transcodedFilename = `transcoded-${crypto.randomUUID().slice(0, 8)}-${baseName}.mp4`;
      const transcodedFilepath = path.join(UPLOADS_DIR, transcodedFilename);
      
      const success = await new Promise((resolve) => {
        ffmpeg(req.file.path)
          .videoCodec('libx264')
          .outputOptions('-pix_fmt', 'yuv420p')
          .audioCodec('aac')
          .format('mp4')
          .on('end', () => resolve(true))
          .on('error', (err) => {
            console.error('FFmpeg transcoding error:', err.message);
            resolve(false);
          })
          .save(transcodedFilepath);
      });
      
      if (success && fs.existsSync(transcodedFilepath)) {
         try { fs.unlinkSync(req.file.path); } catch(e) {}
         return res.json({ url: `/uploads/${transcodedFilename}` });
      }
    }
  }

  // Standard File Move
  fs.renameSync(req.file.path, filepath);
  console.log(`Saved HTTP asset to ${filepath}`);
  res.json({ url: `/uploads/${filename}` });
});

// -- Video Room Participants REST --
app.get('/api/spaces/:id/video-participants', authenticateToken, (req, res) => {
  const spaceId = req.params.id;
  const participants = activeVideoRooms.get(spaceId) || [];
  res.json(Array.from(participants));
});

// -- Socket IO Auth Middleware --
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication error: No token provided'));
  }
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Authentication error: Invalid token'));
    
    db.get('SELECT id FROM users WHERE id = ?', [decoded.userId], (dbErr, user) => {
      if (dbErr || !user) return next(new Error('Authentication error: User missing'));
      socket.user = decoded;
      next();
    });
  });
});

const activeUsers = new Map();
const activeVideoRooms = new Map(); // spaceId -> Set of { socketId, username, first_name, last_name, avatar }

io.on('connection', (socket) => {
  const user = socket.user;
  const username = user.username;
  console.log(`A user connected: ${username} (${socket.id})`);
  socket.connectedAt = Date.now();
  socket.userAgentStr = socket.handshake?.headers?.['user-agent'] || 'Unknown';

  // Track active sessions per user
  db.get('SELECT username, first_name, last_name, avatar FROM users WHERE username = ?', [username], (err, row) => {
    if (!err && row) {
      socket.userProfile = row;
      const current = activeUsers.get(username);
      if (current) {
        current.count += 1;
        current.user = row;
      } else {
        activeUsers.set(username, { count: 1, user: row });
      }
      io.emit('presence', Array.from(activeUsers.values()).map(v => v.user));
    }
  });

  // Automatically subscribe sockets to all authorized background Spaces for unread badge dispatches
  db.all('SELECT id FROM spaces WHERE is_private = 0', [], (err, publicRows) => {
    if (!err && publicRows) publicRows.forEach(r => socket.join(r.id.toString()));
  });

  db.all('SELECT space_id FROM space_members WHERE user_id = ?', [user.userId], (err, privateRows) => {
    if (!err && privateRows) privateRows.forEach(r => socket.join(r.space_id.toString()));
  });

  socket.on('typing', (data) => {
    const spaceId = data.spaceId || data;
    const avatar = data.avatar || null;
    socket.to(spaceId.toString()).emit('user typing', { username, spaceId, avatar, first_name: socket.userProfile?.first_name });
  });

  socket.on('stop typing', (data) => {
    const spaceId = data.spaceId || data;
    socket.to(spaceId.toString()).emit('user stopped typing', { username, spaceId });
  });

  socket.on('join space', (spaceId) => {
    // SECURITY: Validate user has permission to join this socket room
    db.get('SELECT * FROM spaces WHERE id = ?', [spaceId], (err, space) => {
      if (err || !space) return; // Room does not exist

      const proceedWithJoin = () => {
        socket.currentSpace = spaceId;
        socket.join(spaceId.toString());

        // Send history for this space
        db.all(`
          SELECT m.id, m.text, m.sender, m.timestamp, u.avatar, m.asset, m.edited, m.is_pinned, m.reactions, u.first_name, u.last_name
          FROM messages m 
          LEFT JOIN users u ON m.sender = u.username 
          WHERE m.space_id = ?
          ORDER BY m.id DESC LIMIT 50
        `, [spaceId], (err, rows) => {
          if (!err) {
            const history = rows.reverse();
            socket.emit('space history', history.map(row => ({
              text: row.text, id: row.id, sender: row.sender, avatar: row.avatar, spaceId, asset: row.asset, edited: row.edited, is_pinned: row.is_pinned, reactions: row.reactions, first_name: row.first_name, last_name: row.last_name, timestamp: row.timestamp ? row.timestamp + 'Z' : null
            })));
          }
          
          db.all('SELECT username, message_id FROM read_receipts WHERE space_id = ?', [spaceId], (err, receipts) => {
            if (!err) {
               const receiptMap = {};
               receipts.forEach(r => receiptMap[r.username] = r.message_id);
               socket.emit('read_receipts_init', receiptMap);
            }
          });
        });
      };

      if (space.is_private === 1 && socket.user.role !== 'admin') {
        db.get('SELECT * FROM space_members WHERE space_id = ? AND user_id = ?', [spaceId, socket.user.userId], (err, member) => {
          if (member) proceedWithJoin();
        });
      } else {
        proceedWithJoin();
      }
    });
  });

  socket.on('mark_read', (data) => {
    const { space_id, message_id } = data;
    if (!space_id || !message_id) return;
    
    db.run(
      'INSERT INTO read_receipts (space_id, username, message_id) VALUES (?, ?, ?) ON CONFLICT(space_id, username) DO UPDATE SET message_id = excluded.message_id',
      [space_id, socket.user.username, message_id],
      (err) => {
        if (!err) {
          io.to(space_id.toString()).emit('read_receipt_update', {
            space_id,
            username: socket.user.username,
            message_id
          });
        }
      }
    );
  });

  // E2EE key distribution: relay key requests to online space members
  socket.on('request_room_key', (data) => {
    const { spaceId, requesterId, requesterPublicKey } = data;
    if (!spaceId || !requesterId || !requesterPublicKey) return;
    // Relay to all other sockets in this space room
    socket.to(spaceId.toString()).emit('request_room_key', {
      spaceId,
      requesterId,
      requesterPublicKey,
      requesterSocketId: socket.id
    });
  });

  // E2EE key distribution: relay granted key back to requester and persist
  socket.on('grant_room_key', (data) => {
    const { spaceId, requesterId, encryptedRoomKey, requesterSocketId } = data;
    if (!spaceId || !requesterId || !encryptedRoomKey) return;
    // Persist the key share in the database
    db.run('INSERT OR REPLACE INTO space_keys (space_id, user_id, encrypted_room_key) VALUES (?, ?, ?)',
      [spaceId, requesterId, encryptedRoomKey], (err) => {
        if (err) console.error('Failed to persist granted key share', err);
      });
    // Deliver to the requester's socket
    if (requesterSocketId) {
      io.to(requesterSocketId).emit('grant_room_key', { spaceId, encryptedRoomKey });
    }
  });

  socket.on('chat message', async (msg) => {
    if (!msg.spaceId) return; // Drop invalid or legacy un-routed payloads
    const sender = socket.user.username;
    const spaceId = msg.spaceId;
    const assetPath = msg.asset || null;
    

    db.get('SELECT avatar, first_name, last_name FROM users WHERE username = ?', [sender], (err, user) => {
      const avatar = user ? user.avatar : null;
      const firstName = user ? user.first_name : null;
      const lastName = user ? user.last_name : null;

      // Save to db FIRST
      db.run('INSERT INTO messages (text, sender, space_id, asset) VALUES (?, ?, ?, ?)', [msg.text, sender, spaceId, assetPath], function(err) {
        if (!err) {
          const outgoingMsg = { text: msg.text, id: this.lastID, sender, avatar, spaceId, asset: assetPath, edited: 0, is_pinned: 0, reactions: '{}', first_name: firstName, last_name: lastName, timestamp: new Date().toISOString() };
          
          // Broadcast the DB-authorized message globally
          io.to(spaceId.toString()).emit('chat message', outgoingMsg);
          
          // Send push notifications to space members (except sender)
          db.get('SELECT name, is_dm FROM spaces WHERE id = ?', [spaceId], (err, space) => {
            if (err || !space) return;
            const displayName = firstName ? `${firstName} ${lastName || ''}`.trim() : sender;
            const spaceName = space.name;
            const isDm = space.is_dm === 1;
            
            // Build context-aware title
            let title;
            if (isDm) {
              title = displayName;
            } else {
              title = `${displayName} in #${spaceName}`;
            }

            const pushPayload = {
              title,
              body: (outgoingMsg.text || (outgoingMsg.asset ? '📎 Sent an attachment' : '')).substring(0, 200),
              icon: (outgoingMsg.avatar && !outgoingMsg.avatar.startsWith('data:')) ? outgoingMsg.avatar : '/icon.png',
              data: {
                spaceId,
                spaceName,
                isDm,
                senderUsername: sender,
                senderDisplayName: displayName,
                timestamp: Date.now()
              }
            };

            // Only notify members of this space who aren't the sender
            db.all(`SELECT u.id FROM users u 
                    JOIN space_members sm ON u.id = sm.user_id 
                    WHERE sm.space_id = ? AND u.username != ?`, [spaceId, sender], (err, members) => {
              if (!err && members) {
                members.forEach(m => sendPushNotification(m.id, pushPayload));
              }
            });
          });
        }
      });
    });
  });

  socket.on('edit message', (data) => {
    const { id, text, spaceId } = data;
    const sender = socket.user.username;

    // Check ownership
    db.get('SELECT sender FROM messages WHERE id = ?', [id], (err, row) => {
      if (err || !row || row.sender !== sender) return;

      db.run('UPDATE messages SET text = ?, edited = 1 WHERE id = ?', [text, id], (err) => {
        if (!err) {
          io.to(spaceId.toString()).emit('message updated', { id, text, edited: 1, spaceId });
        }
      });
    });
  });

  socket.on('delete message', (data) => {
    const { id, spaceId } = data;
    const sender = socket.user.username;
    const userRole = socket.user.role;

    // Check ownership or admin status or space owner status
    db.get('SELECT m.sender, m.asset, s.created_by FROM messages m JOIN spaces s ON m.space_id = s.id WHERE m.id = ?', [id], (err, row) => {
      if (err || !row || (row.sender !== sender && userRole !== 'admin' && row.created_by !== sender)) return;

      db.run('DELETE FROM messages WHERE id = ?', [id], (err) => {
        if (!err) {
          io.to(spaceId.toString()).emit('message deleted', { id });
          // Asset deletion
          if (row.asset && row.asset.startsWith('/uploads/')) {
            const filename = path.basename(row.asset);
            const filepath = path.join(UPLOADS_DIR, filename);
            if (filepath.startsWith(UPLOADS_DIR) && fs.existsSync(filepath)) {
              try { fs.unlinkSync(filepath); } catch(e) {}
            }
          }
        }
      });
    });
  });

  socket.on('pin message', (data) => {
    const { id, spaceId, is_pinned } = data;
    const sender = socket.user.username;
    const userRole = socket.user.role;
    db.get('SELECT m.sender, s.created_by FROM messages m JOIN spaces s ON m.space_id = s.id WHERE m.id = ?', [id], (err, row) => {
      if (err || !row || (row.created_by !== sender && userRole !== 'admin')) return;
      db.run('UPDATE messages SET is_pinned = ? WHERE id = ?', [is_pinned ? 1 : 0, id], (err) => {
        if (!err) io.to(spaceId.toString()).emit('message pinned', { id, is_pinned: is_pinned ? 1 : 0 });
      });
    });
  });

  socket.on('react message', (data) => {
    const { id, spaceId, emoji } = data;
    const username = socket.user.username;
    db.get('SELECT reactions FROM messages WHERE id = ?', [id], (err, row) => {
      if (err || !row) return;
      let reactions = {};
      try { reactions = JSON.parse(row.reactions || '{}'); } catch(e) {}
      if (!reactions[emoji]) reactions[emoji] = [];
      const idx = reactions[emoji].indexOf(username);
      if (idx > -1) reactions[emoji].splice(idx, 1);
      else reactions[emoji].push(username);
      if (reactions[emoji].length === 0) delete reactions[emoji];
      
      const newReactions = JSON.stringify(reactions);
      db.run('UPDATE messages SET reactions = ? WHERE id = ?', [newReactions, id], (err) => {
        if (!err) io.to(spaceId.toString()).emit('message reacted', { id, reactions: newReactions });
      });
    });
  });

  // -- WebRTC Signaling --
  socket.on('join-video-room', (spaceId) => {
    const room = `video-${spaceId}`;
    socket.join(room);
    socket.videoSpaceId = spaceId;
    
    const participant = {
      socketId: socket.id,
      username: socket.user.username,
      first_name: socket.userProfile?.first_name,
      last_name: socket.userProfile?.last_name,
      avatar: socket.userProfile?.avatar || socket.user.avatar
    };
    
    // Track in activeVideoRooms
    if (!activeVideoRooms.has(spaceId)) activeVideoRooms.set(spaceId, []);
    activeVideoRooms.get(spaceId).push(participant);
    
    // Notify existing participants
    socket.to(room).emit('user-joined-video', {
      userId: socket.id,
      ...participant
    });
    
    // Broadcast updated participant list to the space (for call badge in sidebar)
    io.to(spaceId.toString()).emit('video-room-update', {
      spaceId,
      participants: activeVideoRooms.get(spaceId)
    });
  });

  socket.on('call-ringing', ({ spaceId }) => {
    // Broadcast ringing event to everyone in the space (not just video room)
    socket.to(spaceId.toString()).emit('call-ringing', {
      spaceId,
      caller: {
        username: socket.user.username,
        first_name: socket.userProfile?.first_name,
        last_name: socket.userProfile?.last_name,
        avatar: socket.userProfile?.avatar
      }
    });
  });

  // Targeted call invite — ring only specific users
  socket.on('call-invite', ({ spaceId, targetUserIds, audioOnly }) => {
    const caller = {
      username: socket.user.username,
      first_name: socket.userProfile?.first_name,
      last_name: socket.userProfile?.last_name,
      avatar: socket.userProfile?.avatar
    };
    const payload = { spaceId, caller, audioOnly: !!audioOnly };

    // Find sockets for targeted users and emit directly
    for (const [socketId, s] of io.of('/').sockets) {
      if (s.user && targetUserIds.includes(s.user.userId) && socketId !== socket.id) {
        s.emit('call-ringing', payload);
      }
    }

    // Also send push notifications to targeted users
    if (targetUserIds.length > 0) {
      const placeholders = targetUserIds.map(() => '?').join(',');
      db.all(`SELECT ps.subscription FROM push_subscriptions ps
              JOIN users u ON ps.user_id = u.id
              WHERE u.id IN (${placeholders})`, targetUserIds, (err, rows) => {
        if (!err && rows) {
          const callerName = caller.first_name || caller.username;
          rows.forEach(row => {
            try {
              const sub = JSON.parse(row.subscription);
              webpush.sendNotification(sub, JSON.stringify({
                title: `${callerName} is calling`,
                body: audioOnly ? 'Audio call' : 'Video call',
                data: { spaceId, type: 'call' }
              })).catch(() => {});
            } catch (e) {}
          });
        }
      });

      // Look up the space name for logging
      db.get('SELECT name FROM spaces WHERE id = ?', [spaceId], (err, space) => {
        console.log(`[CALL] ${caller.username} invited ${targetUserIds.length} user(s) to ${audioOnly ? 'audio' : 'video'} call in space ${space?.name || spaceId}`);
      });
    }
  });

  socket.on('screen-share-started', ({ spaceId }) => {
    const room = `video-${spaceId}`;
    socket.to(room).emit('screen-share-started', {
      userId: socket.id,
      username: socket.user.username,
      first_name: socket.userProfile?.first_name
    });
  });

  socket.on('screen-share-stopped', ({ spaceId }) => {
    const room = `video-${spaceId}`;
    socket.to(room).emit('screen-share-stopped', { userId: socket.id });
  });

  socket.on('camera-toggled', ({ spaceId, isVideoOff }) => {
    const room = `video-${spaceId}`;
    socket.to(room).emit('camera-toggled', { userId: socket.id, isVideoOff });
  });

  socket.on('video-offer', (data) => {
    io.to(data.targetUserId).emit('video-offer', {
      senderId: socket.id,
      offer: data.offer,
      username: socket.user.username,
      first_name: socket.userProfile?.first_name,
      last_name: socket.userProfile?.last_name,
      avatar: socket.userProfile?.avatar
    });
  });

  socket.on('video-answer', (data) => {
    io.to(data.targetUserId).emit('video-answer', {
      senderId: socket.id,
      answer: data.answer
    });
  });

  socket.on('new-ice-candidate', (data) => {
    io.to(data.targetUserId).emit('new-ice-candidate', {
      senderId: socket.id,
      candidate: data.candidate
    });
  });

  const cleanupVideoRoom = (spaceId) => {
    if (!spaceId) return;
    const room = `video-${spaceId}`;
    socket.leave(room);
    socket.to(room).emit('user-left-video', socket.id);
    
    // Remove from tracking
    const participants = activeVideoRooms.get(spaceId);
    if (participants) {
      const filtered = participants.filter(p => p.socketId !== socket.id);
      if (filtered.length === 0) {
        activeVideoRooms.delete(spaceId);
        // Notify space that call has ended
        io.to(spaceId.toString()).emit('call-ended', { spaceId });
      } else {
        activeVideoRooms.set(spaceId, filtered);
      }
      // Broadcast updated participant list
      io.to(spaceId.toString()).emit('video-room-update', {
        spaceId,
        participants: activeVideoRooms.get(spaceId) || []
      });
    }
  };

  socket.on('leave-video-room', (spaceId) => {
    cleanupVideoRoom(spaceId);
    socket.videoSpaceId = null;
  });

  // ─── Admin Broadcast ───
  socket.on('admin broadcast', (data) => {
    if (!data?.message?.trim()) return;
    db.get('SELECT role, first_name, last_name FROM users WHERE username = ?', [username], (err, row) => {
      if (err || !row || row.role !== 'admin') return;
      io.emit('broadcast', {
        message: data.message.trim(),
        sender: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : username,
        timestamp: new Date().toISOString()
      });
    });
  });

  socket.on('disconnect', () => {
    // Clean up video room on disconnect
    if (socket.videoSpaceId) {
      cleanupVideoRoom(socket.videoSpaceId);
    }

    console.log('User disconnected:', socket.id);

    // Decrement session count and update Global Presence
    const current = activeUsers.get(username);
    if (current) {
      if (current.count <= 1) {
        activeUsers.delete(username);
      } else {
        current.count -= 1;
      }
      io.emit('presence', Array.from(activeUsers.values()).map(v => v.user));
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
