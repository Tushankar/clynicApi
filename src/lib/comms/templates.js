'use strict';

const path = require('path');
const fs = require('fs');
const config = require('../../config/env');

// Compact Clynic logo shipped with the API — inlined into emails as a CID attachment
// (the only way Gmail reliably renders embedded images). A clinic's own hosted logoUrl
// (http/https) takes precedence when set.
const EMAIL_LOGO_PATH = path.join(__dirname, '..', '..', '..', 'assets', 'clynic-logo-email.png');
const EMAIL_LOGO_CID = 'brand-logo@clynic';

// Professional icon set (Heroicons solid → PNG via scripts/generate-email-icons.js) — email
// clients strip SVG, so icons ride along as tiny CID attachments (~1KB each).
const ICON_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'email-icons');
const BADGE_ICON = { birthday: 'cake-white', followup: 'calendar-days-white', reengage: 'heart-white', generic: 'bell-white' };
const iconPath = (name) => path.join(ICON_DIR, `${name}.png`);
const iconCid = (name) => `icon-${name}@clynic`;
const HERO_IMAGE_CID = 'hero-image@clynic'; // uploaded template image, inlined at send time

// ---- Editable email color theme (crmSettings.emailTheme; empty fields fall back here) ----
const DEFAULT_THEME = {
  accent: '#2563eb', // hero gradient + buttons + hairlines
  bg: '#eef1f7', // outer canvas
  heading: '#10182b', // headline on white (image hero)
  text: '#46506a', // body copy
};
function resolveTheme(clinic) {
  const t = clinic?.crmSettings?.emailTheme || {};
  const legacyAccent = clinic?.website?.theme?.primaryColor; // pre-emailTheme fallback
  const isHex = (v) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v || '').trim());
  return {
    accent: isHex(t.accent) ? t.accent.trim() : isHex(legacyAccent) ? legacyAccent.trim() : DEFAULT_THEME.accent,
    bg: isHex(t.bg) ? t.bg.trim() : DEFAULT_THEME.bg,
    heading: isHex(t.heading) ? t.heading.trim() : DEFAULT_THEME.heading,
    text: isHex(t.text) ? t.text.trim() : DEFAULT_THEME.text,
  };
}

/**
 * CRM message templates (§5.13) — professional defaults every plan gets, plus rendering
 * with per-clinic OVERRIDES (Premium / TEMPLATE_EDITING).
 *
 * The HTML variant is a polished, email-client-safe layout (tables + inline CSS only —
 * no flex/grid, bulletproof buttons, hidden preheader, system font stack) with a
 * campaign-specific hero, CTA buttons (book online / call), a clinic info panel, and a
 * compliant footer. Placeholders: {{patient_name}} {{clinic_name}} {{clinic_phone}}
 * {{clinic_address}} — all substituted values are HTML-escaped so template text can never
 * inject markup. Marketing/logistics copy only — never medical content (rule 2).
 */

// Each default includes a professional hero image (Unsplash) — the owner can replace or
// clear it per template (Premium/TEMPLATE_EDITING). Remote images are fine in email:
// Gmail/Outlook proxy-load https images.
const DEFAULT_TEMPLATES = {
  birthday: {
    label: 'Birthday wish',
    subject: 'Happy birthday, {{patient_name}}! — from {{clinic_name}}',
    imageUrl: 'https://images.unsplash.com/photo-1530103862676-de8c9debad1d?auto=format&fit=crop&w=1240&q=80',
    body:
      'Dear {{patient_name}},\n\n' +
      'All of us at {{clinic_name}} wish you a very happy birthday and a healthy year ahead!\n\n' +
      'As a small birthday gesture, mention this message on your next visit for priority booking.\n\n' +
      'Warm wishes,\nTeam {{clinic_name}}',
  },
  followup: {
    label: 'Follow-up reminder',
    subject: 'A gentle reminder from {{clinic_name}} — your follow-up is due',
    imageUrl: 'https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?auto=format&fit=crop&w=1240&q=80',
    body:
      'Dear {{patient_name}},\n\n' +
      'This is a friendly reminder that your follow-up visit at {{clinic_name}} is due. ' +
      'Staying on schedule helps your doctor track your progress properly.\n\n' +
      'Book online or call us — our front desk will find you a convenient slot.\n\n' +
      'See you soon,\nTeam {{clinic_name}}',
  },
  reengage: {
    label: 'Re-engagement',
    subject: 'We miss you at {{clinic_name}}, {{patient_name}}',
    imageUrl: 'https://images.unsplash.com/photo-1576091160550-2173dba999ef?auto=format&fit=crop&w=1240&q=80',
    body:
      'Dear {{patient_name}},\n\n' +
      "It's been a while since your last visit to {{clinic_name}}. If you're due for a " +
      'check-up or follow-up, we would love to see you again.\n\n' +
      'Book online or call us and our front desk will find you a convenient slot.\n\n' +
      'Warm regards,\nTeam {{clinic_name}}',
  },
};

// Per-campaign hero treatment (professional icon badge + headline + tagline).
const HERO = {
  birthday: { icon: BADGE_ICON.birthday, title: (v) => `Happy birthday, ${firstName(v.patient_name)}!`, tagline: (v) => `A warm wish from everyone at ${v.clinic_name}` },
  followup: { icon: BADGE_ICON.followup, title: () => 'Time for your follow-up', tagline: (v) => `A gentle reminder from ${v.clinic_name}` },
  reengage: { icon: BADGE_ICON.reengage, title: (v) => `We've missed you, ${firstName(v.patient_name)}`, tagline: (v) => `${v.clinic_name} is here whenever you're ready` },
  generic: { icon: BADGE_ICON.generic, title: (v, t) => t || 'A message from your clinic', tagline: (v) => v.clinic_name },
};

function firstName(name) {
  return String(name || 'there').trim().split(/\s+/)[0];
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fill(text, vars, { escape = false } = {}) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = vars[key] ?? '';
    return escape ? escapeHtml(v) : String(v);
  });
}

/** Resolve the effective template for a clinic: per-clinic override (if set) else default. */
function templateFor(clinic, kind) {
  const def = DEFAULT_TEMPLATES[kind];
  if (!def) throw new Error(`Unknown template kind: ${kind}`);
  const over = clinic?.crmSettings?.templates?.[kind] || {};
  const imgOverride = (over.imageUrl || '').trim();
  const imageKey = (over.imageKey || '').trim(); // uploaded image (private storage) → CID at send
  return {
    kind,
    label: def.label,
    subject: (over.subject || '').trim() || def.subject,
    body: (over.body || '').trim() || def.body,
    // Precedence: uploaded image (key) → 'none' clears → external URL override → default URL.
    imageKey,
    imageUrl: imageKey ? '' : imgOverride === 'none' ? '' : imgOverride || def.imageUrl,
    customized: Boolean((over.subject || '').trim() || (over.body || '').trim() || imgOverride || imageKey),
  };
}

// ---- Premium email shell -------------------------------------------------------------

// Inter — the professional font most SaaS products use — loaded via Google Fonts where the
// client supports it (Apple Mail, Outlook macOS, Thunderbird); Gmail/Outlook-Windows fall
// back to the closest system faces in the stack. This is the industry-standard approach.
const FONT = "'Inter','Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT_LINK = '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" type="text/css">';

function expandHex(hex) {
  const s = String(hex || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) return s.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(s) ? s : null;
}
/** Shift a hex color toward black (amt>0) or white (amt<0) — gradient depth / tints. */
function shade(hex, amt = 0.18) {
  const s = expandHex(hex);
  if (!s) return hex;
  const n = parseInt(s, 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((v) => (amt >= 0 ? Math.round(v * (1 - amt)) : Math.round(v + (255 - v) * -amt)));
  return `#${((ch[0] << 16) | (ch[1] << 8) | ch[2]).toString(16).padStart(6, '0')}`;
}
const darken = (hex, amt = 0.18) => shade(hex, Math.abs(amt));

/** The clinic's email logo: its own hosted logoUrl if http(s), else the bundled Clynic mark (CID). */
function brandLogoSrc(clinic) {
  const url = String(clinic?.logoUrl || '').trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (fs.existsSync(EMAIL_LOGO_PATH)) return `cid:${EMAIL_LOGO_CID}`;
  return null;
}

/**
 * Nodemailer attachments needed by emails rendered with this shell: the brand logo (CID),
 * the campaign badge icon, the info-panel icons in use, and — when the clinic uploaded a
 * hero image — that image (read from private storage and inlined via CID). Async because the
 * uploaded image is fetched through the storage facade (driver-agnostic). Returns an array of
 * nodemailer attachment objects; the in-app preview reuses it to inline the same bytes.
 */
async function emailAttachments(clinic, kind = 'generic') {
  const out = [];
  const url = String(clinic?.logoUrl || '').trim();
  if (!/^https?:\/\//i.test(url) && fs.existsSync(EMAIL_LOGO_PATH)) {
    out.push({ filename: 'logo.png', path: EMAIL_LOGO_PATH, cid: EMAIL_LOGO_CID });
  }
  const badge = BADGE_ICON[kind] || BADGE_ICON.generic;
  if (fs.existsSync(iconPath(badge))) out.push({ filename: `${badge}.png`, path: iconPath(badge), cid: iconCid(badge) });
  if (clinic?.address && fs.existsSync(iconPath('map-pin-slate'))) out.push({ filename: 'map-pin.png', path: iconPath('map-pin-slate'), cid: iconCid('map-pin-slate') });
  if (clinic?.phone && fs.existsSync(iconPath('phone-slate'))) out.push({ filename: 'phone.png', path: iconPath('phone-slate'), cid: iconCid('phone-slate') });

  // Uploaded hero image → read bytes from storage and inline via CID. Only real campaign
  // templates carry a hero image ('generic' reminders reuse this shell without one).
  if (DEFAULT_TEMPLATES[kind]) {
    const t = templateFor(clinic, kind);
    if (t.imageKey && clinic?.clinicId) {
      try {
        const storage = require('../storage');
        const buffer = await storage.readBuffer({ clinicId: clinic.clinicId, key: t.imageKey });
        if (buffer && buffer.length) out.push({ filename: 'hero.jpg', content: buffer, cid: HERO_IMAGE_CID });
      } catch {
        /* image missing/unreadable → email still renders without it */
      }
    }
  }
  return out;
}

/** Bulletproof (table-based) email button. */
function button({ href, label, bg, outline = false }) {
  const deep = darken(bg, 0.22);
  const style = outline
    ? `border:2px solid ${bg};border-radius:12px;background:#ffffff;`
    : `border-radius:12px;background:${bg};background-image:linear-gradient(135deg,${bg} 0%,${deep} 100%);box-shadow:0 2px 6px rgba(16,24,40,.18);`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-table;margin:0 8px 10px 0;"><tr>
    <td style="${style}">
      <a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:13px 24px;font-family:${FONT};font-size:14px;font-weight:700;letter-spacing:.2px;text-decoration:none;color:${outline ? bg : '#ffffff'};">${escapeHtml(label)}</a>
    </td>
  </tr></table>`;
}

/**
 * The branded shell: logo row → hero (image banner OR accent gradient, professional icon
 * badge, headline) → letter body → CTA buttons → clinic info panel → footer. 620px card on
 * a cool-slate canvas; tables + inline CSS only (email-client-safe; Inter with system
 * fallbacks; gradients degrade to solid accent in Outlook).
 */
function emailShell({ clinic, hero, bodyHtml, preheader = '', ctas = [], imageSrc = '' }) {
  const theme = resolveTheme(clinic);
  const accent = theme.accent;
  const accentDeep = darken(accent, 0.28);
  const canvasTop = shade(theme.bg, 0.05);
  const canvas = theme.bg;
  const heading = theme.heading;
  const body = theme.text;
  const tagline = shade(theme.heading, -0.42); // muted heading for image-hero taglines
  const clinicName = escapeHtml(clinic?.name || 'Your clinic');
  const address = escapeHtml(clinic?.address || '');
  const phone = escapeHtml(clinic?.phone || '');
  const ctaHtml = ctas.filter(Boolean).map((c) => button({ ...c, bg: accent })).join('');
  const logoSrc = brandLogoSrc(clinic);
  // Hero image src: external URL as-is, or the CID for an uploaded image.
  const heroImg = String(imageSrc || '').trim();
  const badgeImg = `<img src="cid:${iconCid(hero.icon)}" alt="" width="28" height="28" style="display:inline-block;width:28px;height:28px;border:0;vertical-align:middle;" />`;

  const infoRow = (iconName, label, value, link) => `
    <tr>
      <td style="padding:11px 0;border-top:1px solid #e9eef7;vertical-align:middle;width:42px;">
        <span style="display:inline-block;width:32px;height:32px;background:#ffffff;border:1px solid #e3e9f4;border-radius:9px;line-height:32px;text-align:center;">
          <img src="cid:${iconCid(iconName)}" alt="" width="16" height="16" style="display:inline-block;width:16px;height:16px;border:0;vertical-align:middle;" />
        </span>
      </td>
      <td style="padding:11px 0 11px 6px;border-top:1px solid #e9eef7;vertical-align:middle;">
        <span style="display:block;font-family:${FONT};font-size:10px;font-weight:800;letter-spacing:.9px;text-transform:uppercase;color:#93a0ba;">${label}</span>
        ${link
          ? `<a href="${link}" style="font-family:${FONT};font-size:14px;font-weight:600;color:#1c2743;text-decoration:none;">${value}</a>`
          : `<span style="font-family:${FONT};font-size:14px;font-weight:600;color:#1c2743;">${value}</span>`}
      </td>
    </tr>`;

  // Hero: with an image → full-bleed banner + light header block; without → accent gradient band.
  const heroHtml = heroImg
    ? `
          <!-- hero image banner -->
          <tr><td style="padding:0;font-size:0;line-height:0;">
            <img src="${escapeHtml(heroImg)}" alt="" width="620" style="display:block;width:100%;height:250px;object-fit:cover;border:0;" />
          </td></tr>
          <tr><td style="height:4px;background:${accent};background-image:linear-gradient(90deg,${accent},${accentDeep});font-size:0;line-height:0;">&nbsp;</td></tr>
          <!-- header block -->
          <tr>
            <td align="center" style="padding:30px 32px 4px;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                <td align="center" style="width:56px;height:56px;background:${accent};background-image:linear-gradient(135deg,${accent} 0%,${accentDeep} 100%);border-radius:16px;line-height:56px;text-align:center;box-shadow:0 4px 12px rgba(23,32,64,.18);">${badgeImg}</td>
              </tr></table>
              <h1 style="margin:16px 0 6px;font-family:${FONT};font-size:26px;line-height:1.22;font-weight:800;letter-spacing:-.4px;color:${heading};">${escapeHtml(hero.title)}</h1>
              <p style="margin:0;font-family:${FONT};font-size:14px;font-weight:500;color:${tagline};">${escapeHtml(hero.tagline)}</p>
            </td>
          </tr>`
    : `
          <!-- hero (accent gradient) -->
          <tr>
            <td align="center" style="background:${accent};background-image:linear-gradient(135deg,${accent} 0%,${accentDeep} 100%);padding:44px 32px 38px;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                <td align="center" style="width:68px;height:68px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.38);border-radius:50%;line-height:68px;text-align:center;">${badgeImg}</td>
              </tr></table>
              <h1 style="margin:20px 0 7px;font-family:${FONT};font-size:27px;line-height:1.22;font-weight:800;letter-spacing:-.4px;color:#ffffff;">${escapeHtml(hero.title)}</h1>
              <p style="margin:0;font-family:${FONT};font-size:14px;font-weight:500;color:rgba(255,255,255,.82);">${escapeHtml(hero.tagline)}</p>
            </td>
          </tr>
          <tr><td style="height:4px;background:${accentDeep};background-image:linear-gradient(90deg,${accentDeep},${accent},${accentDeep});font-size:0;line-height:0;">&nbsp;</td></tr>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${FONT_LINK}
  </head>
  <body style="margin:0;padding:0;background:${canvas};">
    <!-- preheader (hidden preview text) -->
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${canvas};background-image:linear-gradient(180deg,${canvasTop} 0%,${canvas} 260px);padding:36px 12px 28px;">
      <tr><td align="center">

        <!-- logo row -->
        <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">
          <tr><td align="center" style="padding:0 6px 18px;">
            ${logoSrc
              ? `<img src="${logoSrc}" alt="${clinicName}" height="34" style="display:inline-block;height:34px;width:auto;border:0;outline:none;" />`
              : `<span style="font-family:${FONT};font-size:16px;font-weight:800;letter-spacing:.3px;color:#33405e;">${clinicName}</span>`}
          </td></tr>
        </table>

        <!-- card -->
        <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e2e8f2;box-shadow:0 6px 24px rgba(23,32,64,.09),0 1px 3px rgba(23,32,64,.06);">
${heroHtml}

          <!-- letter body -->
          <tr>
            <td style="padding:36px 40px 8px;">
              <div style="font-family:${FONT};font-size:15px;line-height:1.8;color:${body};">${bodyHtml}</div>
            </td>
          </tr>

          ${ctaHtml ? `<tr><td style="padding:20px 40px 8px;">${ctaHtml}</td></tr>` : ''}

          <!-- clinic info panel -->
          ${address || phone
            ? `<tr><td style="padding:20px 40px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fd;border:1px solid #e7ecf6;border-radius:16px;">
                  <tr><td style="padding:18px 22px 8px;">
                    <span style="font-family:${FONT};font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#8a96b2;">Visit us</span>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:9px;">
                      ${address ? infoRow('map-pin-slate', 'Address', address) : ''}
                      ${phone ? infoRow('phone-slate', 'Phone', phone, `tel:${phone.replace(/[^+\d]/g, '')}`) : ''}
                    </table>
                  </td></tr>
                </table>
              </td></tr>`
            : '<tr><td style="padding:0 0 24px;"></td></tr>'}

          <!-- footer -->
          <tr>
            <td style="padding:20px 40px 24px;border-top:1px solid #edf1f8;background:#fafbfe;">
              <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.7;font-weight:600;color:#8a96b2;">
                ${[clinicName, address, phone].filter(Boolean).join('&nbsp;&nbsp;·&nbsp;&nbsp;')}
              </p>
              <p style="margin:9px 0 0;font-family:${FONT};font-size:11px;line-height:1.65;color:#aeb7cb;">
                This message is about clinic services and appointments only — it is not medical advice. For medical concerns, please consult your doctor.
              </p>
            </td>
          </tr>
        </table>

        <!-- sub-footer -->
        <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">
          <tr><td align="center" style="padding:18px 6px 0;">
            <p style="margin:0;font-family:${FONT};font-size:11px;letter-spacing:.2px;color:#a3adc4;">Sent by ${clinicName} &nbsp;·&nbsp; Powered by <span style="font-weight:700;color:#7e8bab;">Clynic</span></p>
          </td></tr>
        </table>

      </td></tr>
    </table>
  </body>
</html>`;
}

function textToParagraphs(text) {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px;">${p.replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

/** CTA set for a clinic: Book online (public booking page) + Call (tel:). Accent set by the shell. */
function defaultCtas(clinic) {
  const ctas = [];
  if (clinic?.slug && clinic?.website?.published !== false) {
    ctas.push({ href: `${config.publicSiteBaseUrl}/c/${clinic.slug}/book`, label: 'Book an appointment' });
  }
  if (clinic?.phone) {
    ctas.push({ href: `tel:${String(clinic.phone).replace(/[^+\d]/g, '')}`, label: `Call ${clinic.phone}`, outline: true });
  }
  return ctas;
}

/** Resolve the hero <img src>: external URL as-is, uploaded image → CID reference, else none. */
function heroImageSrc(t) {
  if (t.imageKey) return `cid:${HERO_IMAGE_CID}`;
  if (/^https?:\/\//i.test(String(t.imageUrl || '').trim())) return String(t.imageUrl).trim();
  return '';
}

/**
 * Render a template for a patient → { subject, text, html }.
 * `bodyTextOverride` lets callers pass AI-personalized text (Premium) while keeping
 * the same subject, hero, CTAs, and branded shell.
 */
function render(clinic, kind, patient, { bodyTextOverride } = {}) {
  const t = templateFor(clinic, kind);
  const vars = {
    patient_name: patient?.name || 'there',
    clinic_name: clinic?.name || 'your clinic',
    clinic_phone: clinic?.phone || '',
    clinic_address: clinic?.address || '',
  };
  const subject = fill(t.subject, vars);
  const text = bodyTextOverride || fill(t.body, vars);
  const hero = HERO[kind] || HERO.generic;
  const html = emailShell({
    clinic,
    hero: { icon: hero.icon, title: hero.title(vars), tagline: hero.tagline(vars) },
    bodyHtml: textToParagraphs(text),
    preheader: text.split('\n').find((l) => l.trim()) || subject,
    ctas: defaultCtas(clinic),
    imageSrc: heroImageSrc(t),
  });
  return { subject, text, html, template: t };
}

/** Wrap arbitrary text (e.g. appointment reminders) in the same branded shell. */
function wrapHtml(clinic, { title, text }) {
  const vars = { clinic_name: clinic?.name || 'your clinic' };
  const hero = HERO.generic;
  return emailShell({
    clinic,
    hero: { icon: hero.icon, title: hero.title(vars, title), tagline: hero.tagline(vars) },
    bodyHtml: textToParagraphs(text || ''),
    preheader: title || '',
    ctas: defaultCtas(clinic),
  });
}

module.exports = { DEFAULT_TEMPLATES, DEFAULT_THEME, templateFor, resolveTheme, render, wrapHtml, fill, emailAttachments };
