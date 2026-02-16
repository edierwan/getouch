/**
 * Passport.js configuration — Google + Facebook OAuth strategies
 *
 * Provider console settings:
 *
 * Google Cloud Console (https://console.cloud.google.com/apis/credentials):
 *   Authorized JavaScript origins: https://getouch.co
 *   Authorized redirect URI:       https://getouch.co/api/auth/callback/google
 *
 * Meta for Developers (https://developers.facebook.com):
 *   Valid OAuth Redirect URIs:      https://getouch.co/api/auth/callback/facebook
 *   App Domains:                    getouch.co
 */

'use strict';

const passport      = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const { query }     = require('./db');

const BASE_URL = process.env.NEXTAUTH_URL || process.env.BASE_URL || 'https://getouch.co';

/* ── Serialize / Deserialize ─────────────────────────────── */

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const result = await query(
      'SELECT id, email, name, avatar_url, is_active FROM users WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return done(null, false);
    done(null, result.rows[0]);
  } catch (err) {
    done(err);
  }
});

/* ── Shared upsert logic ─────────────────────────────────── */

/**
 * Find or create a user from an OAuth profile.
 * 1) If oauth_accounts row exists for (provider, providerAccountId) → return linked user.
 * 2) Else if a `users` row exists with matching email → link + return.
 * 3) Otherwise create user + oauth_accounts row.
 */
async function findOrCreateOAuthUser(provider, profile, accessToken, refreshToken) {
  const providerAccountId = profile.id;
  const email = (profile.emails && profile.emails[0] && profile.emails[0].value || '').toLowerCase().trim();
  const name  = profile.displayName || '';
  const avatar = (profile.photos && profile.photos[0] && profile.photos[0].value) || null;

  // 1) Already linked?
  const linked = await query(
    `SELECT u.id, u.email, u.name, u.avatar_url, u.is_active
     FROM oauth_accounts oa
     JOIN users u ON u.id = oa.user_id
     WHERE oa.provider = $1 AND oa.provider_account_id = $2`,
    [provider, providerAccountId]
  );

  if (linked.rows.length > 0) {
    // Update tokens
    await query(
      `UPDATE oauth_accounts SET access_token = $1, refresh_token = $2, updated_at = NOW()
       WHERE provider = $3 AND provider_account_id = $4`,
      [accessToken, refreshToken, provider, providerAccountId]
    );
    // Refresh avatar if changed
    if (avatar && !linked.rows[0].avatar_url) {
      await query('UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2', [avatar, linked.rows[0].id]);
    }
    return linked.rows[0];
  }

  // 2) User with same email exists? → link
  if (email) {
    const existing = await query(
      'SELECT id, email, name, avatar_url, is_active FROM users WHERE email = $1',
      [email]
    );
    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      await query(
        `INSERT INTO oauth_accounts (user_id, provider, provider_account_id, provider_email, provider_name, access_token, refresh_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (provider, provider_account_id) DO UPDATE SET access_token = $6, refresh_token = $7, updated_at = NOW()`,
        [user.id, provider, providerAccountId, email, name, accessToken, refreshToken]
      );
      if (avatar && !user.avatar_url) {
        await query('UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2', [avatar, user.id]);
      }
      if (!user.name && name) {
        await query('UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2', [name, user.id]);
      }
      return user;
    }
  }

  // 3) Brand new user
  const newUser = await query(
    `INSERT INTO users (email, name, avatar_url, email_verified_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING id, email, name, avatar_url, is_active`,
    [email || `${provider}_${providerAccountId}@oauth.getouch.co`, name, avatar]
  );
  const user = newUser.rows[0];

  await query(
    `INSERT INTO oauth_accounts (user_id, provider, provider_account_id, provider_email, provider_name, access_token, refresh_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [user.id, provider, providerAccountId, email, name, accessToken, refreshToken]
  );

  return user;
}

/* ── Google Strategy ─────────────────────────────────────── */

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  `${BASE_URL}/api/auth/callback/google`,
    scope:        ['profile', 'email'],
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const user = await findOrCreateOAuthUser('google', profile, accessToken, refreshToken);
      done(null, user);
    } catch (err) {
      console.error('[passport] Google error:', err.message);
      done(err);
    }
  }));
  console.log('[passport] Google strategy registered');
} else {
  console.warn('[passport] Google OAuth not configured (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
}

/* ── Facebook Strategy ───────────────────────────────────── */

if (process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET) {
  passport.use(new FacebookStrategy({
    clientID:     process.env.FACEBOOK_CLIENT_ID,
    clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
    callbackURL:  `${BASE_URL}/api/auth/callback/facebook`,
    profileFields: ['id', 'displayName', 'emails', 'photos'],
    enableProof:  true,
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const user = await findOrCreateOAuthUser('facebook', profile, accessToken, refreshToken);
      done(null, user);
    } catch (err) {
      console.error('[passport] Facebook error:', err.message);
      done(err);
    }
  }));
  console.log('[passport] Facebook strategy registered');
} else {
  console.warn('[passport] Facebook OAuth not configured (missing FACEBOOK_CLIENT_ID / FACEBOOK_CLIENT_SECRET)');
}

module.exports = passport;
