'use strict';

// Recipient for Contact Us notifications only. CONTACT_INBOX_EMAIL lets the
// Contact Us form deliver to its own inbox without touching the shared
// ADMIN_EMAIL used by vendor onboarding, Partner Support and other admin mail.
// Unset or blank falls back to ADMIN_EMAIL, so behaviour is unchanged until
// the setting is added.

const CONTACT_INBOX_ENV = 'CONTACT_INBOX_EMAIL';

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isContactInboxExplicit(env = process.env) {
  return trimmed(env[CONTACT_INBOX_ENV]) !== '';
}

function getContactInboxEmail(env = process.env) {
  return trimmed(env[CONTACT_INBOX_ENV]) || trimmed(env.ADMIN_EMAIL) || undefined;
}

module.exports = { CONTACT_INBOX_ENV, getContactInboxEmail, isContactInboxExplicit };
