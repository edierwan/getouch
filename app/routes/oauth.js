/**
 * OAuth Routes — /api/auth/*
 *
 * GET  /api/auth/google            → redirect to Google consent screen
 * GET  /api/auth/callback/google   → Google callback → session → /dashboard
 * GET  /api/auth/facebook          → redirect to Facebook login
 * GET  /api/auth/callback/facebook → Facebook callback → session → /dashboard
 */

'use strict';

const express  = require('express');
const passport = require('../lib/passport');

const router = express.Router();

/* ── Google ──────────────────────────────────────────────── */

router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
}));

router.get('/callback/google', passport.authenticate('google', {
  failureRedirect: '/auth/login?error=' + encodeURIComponent('Google login failed. Please try again.'),
}), (req, res) => {
  // Passport puts the user object on req.user after deserialisation.
  // We also need to set req.session.userId for our own requireAuth middleware.
  if (req.user) {
    req.session.userId = req.user.id;
  }
  req.session.save(() => {
    res.redirect('/dashboard');
  });
});

/* ── Facebook ────────────────────────────────────────────── */

router.get('/facebook', passport.authenticate('facebook', {
  scope: ['email'],
}));

router.get('/callback/facebook', passport.authenticate('facebook', {
  failureRedirect: '/auth/login?error=' + encodeURIComponent('Facebook login failed. Please try again.'),
}), (req, res) => {
  if (req.user) {
    req.session.userId = req.user.id;
  }
  req.session.save(() => {
    res.redirect('/dashboard');
  });
});

module.exports = router;
