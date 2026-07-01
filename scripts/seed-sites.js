'use strict';

/**
 * Seed 3 distinct live public websites (one per template) so /c/<slug> shows visually different,
 * beautiful sites — proof of the template system + tenant isolation. Idempotent.
 *   node scripts/seed-sites.js
 */
const { connectDB, disconnectDB } = require('../src/config/db');
const { Clinic, Doctor } = require('../src/models');

const CLYNIC_ID = 'org_3FtYI1hcVjcxoVB0ABj6XAcJKDC';
const img = (seed, w, h) => `https://picsum.photos/seed/${seed}/${w}/${h}`;
const mapOf = (q) => `https://maps.google.com/maps?q=${encodeURIComponent(q)}&output=embed`;
const AVAIL = { mon: [{ start: '10:00', end: '14:00' }, { start: '16:00', end: '19:00' }], tue: [{ start: '10:00', end: '14:00' }], wed: [{ start: '10:00', end: '14:00' }, { start: '16:00', end: '19:00' }], thu: [{ start: '10:00', end: '14:00' }], fri: [{ start: '10:00', end: '14:00' }, { start: '16:00', end: '19:00' }], sat: [{ start: '10:00', end: '13:00' }], sun: [] };

async function upsertClinic(clinicId, fields) {
  const existing = await Clinic.findOne({ clinicId });
  if (existing) { Object.assign(existing, fields); await existing.save(); return existing; }
  return Clinic.create({ clinicId, ...fields });
}
async function ensureDoctor(clinicId, name, specialization, fee) {
  const existing = await Doctor.findOne({ clinicId, name });
  if (existing) return existing;
  return Doctor.create({ clinicId, name, specialization, consultationFee: fee, isActive: true, availability: AVAIL, slotDurationMinutes: 30 });
}

async function run() {
  await connectDB();

  // 1) CLYNIC → "Modern Specialist" template, teal palette (dental)
  await upsertClinic(CLYNIC_ID, {
    name: 'Clynic', slug: 'clynic', phone: '033-4000-1000', address: 'Park Street, Kolkata',
    subscriptionPlan: 'premium',
    website: {
      published: true, template: 'modern-specialist',
      theme: { primaryColor: '#14b8a6', accentColor: '#0f766e', logoUrl: '' },
      content: {
        hero: { headline: 'Precision dental care, beautifully done', tagline: 'Advanced, gentle dentistry in the heart of Kolkata — same-day appointments available.', imageUrl: img('clynic-hero', 1600, 1000) },
        about: 'Clynic brings specialist-grade dentistry to Kolkata: painless procedures, transparent pricing, and a calm, modern clinic. Our team blends experience with the latest technology so every visit is quick, comfortable, and reassuring.',
        services: [
          { name: 'Root Canal Treatment', description: 'Painless, single-sitting RCT with modern rotary tools.', icon: 'activity' },
          { name: 'Dental Implants', description: 'Titanium implants that look and feel natural, with lifetime support.', icon: 'shield' },
          { name: 'Clear Aligners', description: 'Discreet orthodontics — straighten your smile invisibly.', icon: 'heart' },
        ],
        gallery: [img('clynic-1', 900, 700), img('clynic-2', 900, 700), img('clynic-3', 900, 700), img('clynic-4', 900, 700)],
        contact: { phone: '033-4000-1000', email: 'care@clynic.example', whatsapp: '+91 98300 00000', address: 'Park Street, Kolkata 700016' },
        mapEmbed: mapOf('Park Street, Kolkata'),
      },
      reviews: [
        { name: 'Rahul S.', text: 'Best dental experience I have had — painless and genuinely quick.', rating: 5, approved: true },
        { name: 'Priya D.', text: 'Spotless modern clinic and such caring staff. Highly recommend.', rating: 5, approved: true },
        { name: 'Anon', text: 'pending review, should NOT appear', rating: 3, approved: false },
      ],
      seo: { title: 'Clynic — Precision Dental Care in Kolkata', description: 'Painless dentistry, implants and aligners. Book online in seconds.', keywords: 'dentist, kolkata, root canal, dental implants' },
    },
  });
  console.log('  Clynic → modern-specialist (teal)  → /c/clynic');

  // 2) SUNRISE FAMILY CLINIC → "Warm Family Care" template, amber palette
  await upsertClinic('org_demo_sunrise', {
    name: 'Sunrise Family Clinic', slug: 'sunrise-family', phone: '033-2222-3333', address: 'Salt Lake, Kolkata',
    subscriptionPlan: 'premium',
    website: {
      published: true, template: 'warm-family',
      theme: { primaryColor: '#ea7317', accentColor: '#f4a259', logoUrl: '' },
      content: {
        hero: { headline: 'Caring for your family, every step of the way', tagline: 'Friendly family medicine and paediatrics — where everyone feels at home.', imageUrl: img('sunrise-hero', 1600, 1000) },
        about: 'Sunrise Family Clinic has looked after Salt Lake families for over a decade. From your little one’s first check-up to grandparents’ routine care, our warm, unhurried approach puts your family first.',
        services: [
          { name: 'Family Medicine', description: 'Everyday care for the whole family under one roof.', icon: 'heart' },
          { name: 'Child Health & Vaccination', description: 'Gentle paediatric care and complete immunisation.', icon: 'shield' },
          { name: 'Health Check-ups', description: 'Preventive packages tailored to every age.', icon: 'activity' },
        ],
        gallery: [img('sunrise-1', 900, 700), img('sunrise-2', 900, 700), img('sunrise-3', 900, 700)],
        contact: { phone: '033-2222-3333', email: 'hello@sunrise.example', whatsapp: '+91 90000 11111', address: 'Sector V, Salt Lake, Kolkata 700091' },
        mapEmbed: mapOf('Salt Lake Sector V, Kolkata'),
      },
      reviews: [
        { name: 'Meena R.', text: 'They are wonderful with my kids — patient and kind.', rating: 5, approved: true },
        { name: 'Sundar', text: 'Feels like family. Never rushed, always thorough.', rating: 5, approved: true },
      ],
      seo: { title: 'Sunrise Family Clinic — Salt Lake, Kolkata', description: 'Warm family medicine and paediatric care. Book your visit online.', keywords: 'family doctor, paediatrician, salt lake, kolkata' },
    },
  });
  await ensureDoctor('org_demo_sunrise', 'Dr. Meera Nair', 'Family Physician', 400);
  await ensureDoctor('org_demo_sunrise', 'Dr. Arjun Rao', 'Paediatrician', 450);
  console.log('  Sunrise Family Clinic → warm-family (amber) → /c/sunrise-family');

  // 3) APEX ORTHOPAEDICS → "Clean Clinical" template, blue palette
  await upsertClinic('org_demo_apex', {
    name: 'Apex Orthopaedics', slug: 'apex-ortho', phone: '033-5555-7777', address: 'Ballygunge, Kolkata',
    subscriptionPlan: 'premium',
    website: {
      published: true, template: 'clean-clinical',
      theme: { primaryColor: '#2563eb', accentColor: '#1d4ed8', logoUrl: '' },
      content: {
        hero: { headline: 'Move better. Live better.', tagline: 'Specialist orthopaedic and sports-injury care with rapid recovery pathways.', imageUrl: img('apex-hero', 1600, 1000) },
        about: 'Apex Orthopaedics is a dedicated bone-and-joint centre led by senior surgeons. We combine precise diagnosis, minimally invasive surgery and structured physiotherapy to get you back on your feet, fast.',
        services: [
          { name: 'Joint Replacement', description: 'Advanced knee and hip replacement with quick recovery.', icon: 'activity' },
          { name: 'Sports Injury', description: 'Arthroscopy and rehab for athletes of every level.', icon: 'shield' },
          { name: 'Spine Care', description: 'Non-surgical and surgical solutions for back and neck pain.', icon: 'heart' },
        ],
        gallery: [img('apex-1', 900, 700), img('apex-2', 900, 700), img('apex-3', 900, 700)],
        contact: { phone: '033-5555-7777', email: 'appointments@apex.example', whatsapp: '+91 91234 56789', address: 'Ballygunge, Kolkata 700019' },
        mapEmbed: mapOf('Ballygunge, Kolkata'),
      },
      reviews: [
        { name: 'Colonel V.', text: 'Walked in on crutches, walked out running. Superb team.', rating: 5, approved: true },
        { name: 'Aisha K.', text: 'Clear explanations and a recovery plan that actually worked.', rating: 5, approved: true },
      ],
      seo: { title: 'Apex Orthopaedics — Bone & Joint Care, Kolkata', description: 'Joint replacement, sports injury and spine care. Book a consult online.', keywords: 'orthopaedic, kolkata, knee replacement, sports injury' },
    },
  });
  await ensureDoctor('org_demo_apex', 'Dr. Vikram Bose', 'Orthopaedic Surgeon', 900);
  console.log('  Apex Orthopaedics → clean-clinical (blue) → /c/apex-ortho');

  await disconnectDB();
}

run().then(() => { console.log('Done. Open each /c/<slug> to see three visually distinct sites.'); process.exit(0); }).catch((e) => { console.error('SEED SITES FAILED:', e.name, e.message); if (e.errors) console.error(Object.keys(e.errors).join(', ')); process.exit(1); });
