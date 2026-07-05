'use strict';
const { connectDB, disconnectDB } = require('../src/config/db');
const { Clinic } = require('../src/models');

const pages = [
  {
    slug: 'employers',
    title: 'Maven for Employers',
    published: true,
    body: `Reimagine family benefits with the world's leading virtual clinic.

Maven partners with employers to improve health outcomes, lower healthcare claims costs, and help employees navigate the journey of planning, starting, and raising a family.

What we offer:
- Fertility & Family Building: Support for IVF, IUI, adoption, surrogacy, and egg freezing.
- Maternity & Newborn Care: Continuous care from conception through return-to-work, including pediatric sleep and lactation consultation.
- Parenting & Pediatrics: Guidance for parents of children ages 0-18, focusing on behavioral health, speech, and occupational therapy.
- Menopause & Midlife: Tailored medical care, symptom management, and hormone therapy coaching.

Over 2,300 employers trust Maven to deliver clinically validated results that employees love.`
  },
  {
    slug: 'health-plans',
    title: 'Maven for Health Plans',
    published: true,
    body: `Drive high-value, integrated maternity and family care for your members.

Maven integrates with health plan benefits to identify high-risk members early, reduce costly neonatal intensive care unit (NICU) admissions, and support lower cesarean section rates.

How we partner:
- Comprehensive Risk Screening: Clinical assessments identify clinical and social risk factors.
- Specialized 24/7 Care Teams: Immediate access to OB/GYNs, doulas, mental health specialists, and care advocates.
- Multi-channel Engagement: Engaging members through mobile apps, direct messaging, and video consultations.
- Seamless Care Coordination: Working with local network providers and existing health plan programs.

Lower costs, improve clinical outcomes, and elevate member satisfaction.`
  },
  {
    slug: 'clinical-quality',
    title: 'Clinical Quality & Outcomes at Maven',
    published: true,
    body: `Clinical excellence is at the core of everything we do.

Our care model is designed and led by clinical experts, backed by peer-reviewed studies, and supported by a global board of medical advisors.

Clinical Pillars:
- Peer-reviewed Studies: 40+ publications validating our impact on reducing ER visits, lowering C-section rates, and improving maternal mental health.
- Global Provider Network: Over 35 specialties representing diverse backgrounds, languages, and clinical expertise.
- Specialized Clinical Protocols: Evidence-based guidelines for prenatal care, high-risk pregnancy, postpartum depression, and pediatrics.
- Patient Safety & Quality: HIPAA-compliant, secure platform with continuous monitoring of clinical outcomes.

Experience healthcare built on rigorous quality standards and compassion.`
  }
];

async function run() {
  await connectDB();
  const res = await Clinic.updateOne(
    { slug: 'clynic' },
    { $set: { 'website.pages': pages } }
  );
  console.log('Update pages result:', res);
  await disconnectDB();
}
run();
