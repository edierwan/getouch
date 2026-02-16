/**
 * Auth routes — Login, Register, Logout
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../lib/db');
const { loadUser } = require('../lib/auth');

const router = express.Router();

/* ── GET /auth/login ─────────────────────────────────────── */
router.get('/login', loadUser, (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  const fs = require('fs');
  const path = require('path');
  let html = fs.readFileSync(path.join(__dirname, '..', 'views', 'login.html'), 'utf8');
  const error = req.query.error || '';
  html = html.replace('{{ERROR}}', error ? `<div class="form-error">${escapeHtml(error)}</div>` : '');
  html = html.replace('{{YEAR}}', String(new Date().getFullYear()));
  res.type('html').send(html);
});

/* ── GET /auth/register ──────────────────────────────────── */
router.get('/register', loadUser, (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  const fs = require('fs');
  const path = require('path');
  let html = fs.readFileSync(path.join(__dirname, '..', 'views', 'register.html'), 'utf8');
  const error = req.query.error || '';
  html = html.replace('{{ERROR}}', error ? `<div class="form-error">${escapeHtml(error)}</div>` : '');
  html = html.replace('{{YEAR}}', String(new Date().getFullYear()));
  res.type('html').send(html);
});

/* ── POST /auth/register ─────────────────────────────────── */
router.post('/register', async (req, res) => {
  const { email, name, password, confirmPassword } = req.body;

  if (!email || !password || !name) {
    return res.redirect('/auth/register?error=' + encodeURIComponent('All fields are required'));
  }
  if (password.length < 8) {
    return res.redirect('/auth/register?error=' + encodeURIComponent('Password must be at least 8 characters'));
  }
  if (password !== confirmPassword) {
    return res.redirect('/auth/register?error=' + encodeURIComponent('Passwords do not match'));
  }

  try {
    // Check if email exists
    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.rows.length > 0) {
      return res.redirect('/auth/register?error=' + encodeURIComponent('Email already registered'));
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [email.toLowerCase().trim(), name.trim(), passwordHash]
    );

    // Auto-login
    req.session.userId = result.rows[0].id;
    req.session.save(() => {
      res.redirect('/dashboard');
    });
  } catch (err) {
    console.error('[auth] Register error:', err.message);
    res.redirect('/auth/register?error=' + encodeURIComponent('Registration failed. Please try again.'));
  }
});

/* ── POST /auth/login ────────────────────────────────────── */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('Email and password are required'));
  }

  try {
    const result = await query(
      'SELECT id, email, name, password_hash, is_active FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.redirect('/auth/login?error=' + encodeURIComponent('Invalid email or password'));
    }

    const user = result.rows[0];
    if (!user.is_active) {
      return res.redirect('/auth/login?error=' + encodeURIComponent('Account is deactivated'));
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.redirect('/auth/login?error=' + encodeURIComponent('Invalid email or password'));
    }

    req.session.userId = user.id;
    req.session.save(() => {
      res.redirect('/dashboard');
    });
  } catch (err) {
    console.error('[auth] Login error:', err.message);
    res.redirect('/auth/login?error=' + encodeURIComponent('Login failed. Please try again.'));
  }
});

/* ── POST /auth/logout ───────────────────────────────────── */
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

/* ── GET /auth/logout (convenience) ──────────────────────── */
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = router;
