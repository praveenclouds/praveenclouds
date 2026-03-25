/**
 * db/mark-offboarding.js
 * Migration: upserts all historically offboarded employees as Inactive
 * with their last working date.
 * - Existing users → status set to Inactive + lastWorkingDate updated
 * - Missing users  → created with status Inactive + lastWorkingDate
 *
 * Usage:
 *   node db/mark-offboarding.js
 *
 * Source: Terzo Employees List – Offboarding tab (India + US teams), March 2026
 */

const mongoose = require('mongoose');
const { MONGO_URI } = require('../config');
const User = require('./models/User');

const OFFBOARDED = [
  // ── India ──
  { first: 'Abishek',      last: 'Kashyab',         email: 'abishek@terzocloud.com',        location: 'India', lastWorkingDate: '2022-01-31' },
  { first: 'Harishini',    last: 'Ravi',             email: 'harshini@terzocloud.com',       location: 'India', lastWorkingDate: '2022-08-31' },
  { first: 'Loganathan',   last: '',                 email: 'loganathan@terzocloud.com',     location: 'India', lastWorkingDate: '2022-09-20' },
  { first: 'Manikandan',   last: '',                 email: 'manikandan@terzocloud.com',     location: 'India', lastWorkingDate: '2023-08-31' },
  { first: 'Gowthami',     last: '',                 email: 'gowthami@terzocloud.com',       location: 'India', lastWorkingDate: '2023-08-31' },
  { first: 'Yuvraj',       last: 'B',                email: 'yuvaraj@terzocloud.com',        location: 'India', lastWorkingDate: '2023-08-31' },
  { first: 'Muthazhahi',   last: '',                 email: 'muthazhahi@terzocloud.com',     location: 'India', lastWorkingDate: '2023-08-31' },
  { first: 'Sudarshan',    last: '',                 email: 'sudarshan@terzocloud.com',      location: 'India', lastWorkingDate: '2023-08-31' },
  { first: 'Raghul',       last: '',                 email: 'raghul@terzocloud.com',         location: 'India', lastWorkingDate: '2023-08-31' },
  { first: 'Santhiya',     last: '',                 email: 'santhiya@terzocloud.com',       location: 'India', lastWorkingDate: '2023-08-31' },
  { first: 'Madhumitha',   last: '',                 email: 'madhumitha@terzocloud.com',     location: 'India', lastWorkingDate: '2023-08-31' },
  { first: 'Niranjan',     last: '',                 email: 'niranjan@terzocloud.com',       location: 'India', lastWorkingDate: '2023-10-31' },
  { first: 'Pranesh',      last: '',                 email: 'pranesh@terzocloud.com',        location: 'India', lastWorkingDate: '2023-11-30' },
  { first: 'Dayalan',      last: '',                 email: 'dayalan@terzocloud.com',        location: 'India', lastWorkingDate: '2025-03-08' },
  { first: 'Sethuraman',   last: '',                 email: 'sethuraman@terzocloud.com',     location: 'India', lastWorkingDate: '2025-03-08' },
  { first: 'Nandhini',     last: '',                 email: 'nandhini@terzocloud.com',       location: 'India', lastWorkingDate: '2025-03-08' },
  { first: 'Harwintha',    last: '',                 email: 'harwintha@terzocloud.com',      location: 'India', lastWorkingDate: '2025-03-08' },
  { first: 'Gokila',       last: '',                 email: 'gokila@terzocloud.com',         location: 'India', lastWorkingDate: '2025-03-08' },
  { first: 'Tamilselvan',  last: '',                 email: 'tamil@terzocloud.com',          location: 'India', lastWorkingDate: '2025-03-08' },
  { first: 'Nandhakumar',  last: '',                 email: 'nandhakumar@terzocloud.com',    location: 'India', lastWorkingDate: '2025-03-17' },
  { first: 'Padmalakshmi', last: '',                 email: 'padmalakshmi.a@terzocloud.com', location: 'India', lastWorkingDate: '2025-03-08' },
  { first: 'Ramalakshmi',  last: 'V',                email: 'ramalakshmi@terzocloud.com',    location: 'India', lastWorkingDate: '2025-06-03' },
  { first: 'Rashmi',       last: 'S',                email: 'rashmi.s@terzocloud.com',       location: 'India', lastWorkingDate: '2025-06-03' },
  { first: 'Yusvanth',     last: '',                 email: 'yusvanth@terzocloud.com',       location: 'India', lastWorkingDate: '2025-06-03' },
  { first: 'Yuvaraj',      last: 'M',                email: 'yuvaraj.m@terzocloud.com',      location: 'India', lastWorkingDate: '2025-06-03' },
  { first: 'Gokul',        last: '',                 email: 'gokul@terzocloud.com',          location: 'India', lastWorkingDate: '2025-06-03' },
  { first: 'Aparna',       last: '',                 email: 'aparna@terzocloud.com',         location: 'India', lastWorkingDate: '2025-06-03' },
  { first: 'Yogavarshan',  last: '',                 email: 'yogavarshan@terzocloud.com',    location: 'India', lastWorkingDate: '2025-06-03' },
  { first: 'Monisha',      last: '',                 email: 'monisha@terzocloud.com',        location: 'India', lastWorkingDate: '2025-06-03' },
  { first: 'Vinodhini',    last: 'S',                email: 'vinodhini@terzocloud.com',      location: 'India', lastWorkingDate: '2025-06-03' },
  { first: 'Giridharan',   last: 'GR',               email: 'giridharan@terzocloud.com',     location: 'India', lastWorkingDate: '2025-06-03' },
  // ── USA ──
  { first: 'Roger',        last: 'Laforce',          email: 'rlaforce@terzocloud.com',       location: 'USA',   lastWorkingDate: '2023-09-01' },
  { first: 'David',        last: 'St. Pierre',       email: 'stpierre.dav@gmail.com',        location: 'USA',   lastWorkingDate: '2023-07-22' },
  { first: 'Elvis',        last: 'Goncalves',        email: 'egoncalves@terzocloud.com',     location: 'USA',   lastWorkingDate: '2023-07-21' },
  { first: 'Alexander',    last: 'Giocondi',         email: 'agiocondi@terzocloud.com',      location: 'USA',   lastWorkingDate: '2024-01-01' },
  { first: 'Amanda',       last: 'Olsen',            email: 'amanda.olsen@zuora.com',        location: 'USA',   lastWorkingDate: '2023-03-17' },
  { first: 'Charles',      last: 'White',            email: 'gbst1357@gmail.com',            location: 'USA',   lastWorkingDate: '2023-09-15' },
  { first: 'Courtney',     last: "D'Amato",          email: 'cdamato@terzocloud.com',        location: 'USA',   lastWorkingDate: '2022-10-21' },
  { first: 'Dane',         last: 'Teschner',         email: 'dane.teschner@gmail.com',       location: 'USA',   lastWorkingDate: '2023-03-17' },
  { first: 'Justin',       last: 'Hiatt',            email: 'justin@terzocloud.com',         location: 'USA',   lastWorkingDate: '2024-07-31' },
  { first: 'Morganne',     last: 'Pace',             email: 'mpace@terzocloud.com',          location: 'USA',   lastWorkingDate: '2023-07-07' },
  { first: 'Ryan',         last: 'Schubert',         email: 'rynschubert@gmail.com',         location: 'USA',   lastWorkingDate: '2023-07-07' },
  { first: 'Shila',        last: 'Amiri',            email: 'shila.amiri@terzocloud.com',    location: 'USA',   lastWorkingDate: '2022-03-01' },
  { first: 'Alex',         last: 'Rymarz',           email: 'alex.rymarz@gmail.com',         location: 'USA',   lastWorkingDate: '2023-07-08' },
  { first: 'Anthony',      last: 'Falbo',            email: 'afalbo@terzocloud.com',         location: 'USA',   lastWorkingDate: '2022-06-10' },
  { first: 'Ashley',       last: 'Kaplan',           email: 'akaplan@terzocloud.com',        location: 'USA',   lastWorkingDate: '2022-05-06' },
  { first: 'Benjamin',     last: 'Nave',             email: 'ben@terzocloud.com',            location: 'USA',   lastWorkingDate: '2023-01-06' },
  { first: 'Ben',          last: 'Tu',               email: 'btu@terzocloud.com',            location: 'USA',   lastWorkingDate: '2022-12-16' },
  { first: 'Bethany',      last: 'Barker',           email: 'bbarker@terzocloud.com',        location: 'USA',   lastWorkingDate: '2022-07-27' },
  { first: 'Boglarka',     last: 'Kiss',             email: 'bkiss@terzocloud.com',          location: 'USA',   lastWorkingDate: '2023-07-07' },
  { first: 'Chad',         last: 'Ketchum',          email: 'chad.ketcham@terzocloud.com',   location: 'USA',   lastWorkingDate: '2022-04-26' },
  { first: 'Chris',        last: 'Kunz',             email: 'ckunz@terzocloud.com',          location: 'USA',   lastWorkingDate: '2023-03-17' },
  { first: 'Emily',        last: 'Beisel',           email: 'ebeisel@terzocloud.com',        location: 'USA',   lastWorkingDate: '2023-07-07' },
  { first: 'Eric',         last: 'Dungey',           email: 'edungey@terzocloud.com',        location: 'USA',   lastWorkingDate: '2022-12-15' },
  { first: 'Evan',         last: 'Attipoe',          email: 'evan.attipoe@terzocloud.com',   location: 'USA',   lastWorkingDate: '2022-06-10' },
  { first: 'Lexi',         last: 'Rector',           email: 'lrector@terzocloud.com',        location: 'USA',   lastWorkingDate: '2022-05-15' },
  { first: 'Marni',        last: 'Klee',             email: 'mklee@terzocloud.com',          location: 'USA',   lastWorkingDate: '2022-06-10' },
  { first: 'Mary Jane',    last: 'Anderson',         email: 'manderson@terzocloud.com',      location: 'USA',   lastWorkingDate: '2022-12-15' },
  { first: 'Michael',      last: 'Enwright',         email: 'menwright@terzocloud.com',      location: 'USA',   lastWorkingDate: '2023-07-07' },
  { first: 'Neal',         last: 'Mehta',            email: 'neil.mehta@terzocloud.com',     location: 'USA',   lastWorkingDate: '2022-06-10' },
  { first: 'Ronnell',      last: 'Shaw',             email: 'rshaw@terzocloud.com',          location: 'USA',   lastWorkingDate: '2023-07-08' },
  { first: 'Sarah',        last: 'Hale',             email: 'shale@terzocloud.com',          location: 'USA',   lastWorkingDate: '2022-03-19' },
  { first: 'Tale',         last: 'Kornfeld',         email: 'tkornfeld@terzocloud.com',      location: 'USA',   lastWorkingDate: '2023-07-07' },
  { first: 'Vuk',          last: 'Micunovic',        email: 'vmicunovic@terzocloud.com',     location: 'USA',   lastWorkingDate: '2024-08-05' },
  { first: 'Johanna',      last: 'Torres',           email: 'jtorres@terzocloud.com',        location: 'USA',   lastWorkingDate: '2024-09-17' },
  { first: 'Gabrial',      last: 'Bidot',            email: 'gbidot@terzocloud.com',         location: 'USA',   lastWorkingDate: '2025-07-12' },
  { first: 'Jake',         last: 'Flaherty',         email: 'jflaherty@terzocloud.com',      location: 'USA',   lastWorkingDate: '2025-02-14' },
  { first: 'Catherine',    last: 'Knott',            email: 'cknott@terzocloud.com',         location: 'USA',   lastWorkingDate: '2025-03-17' },
  { first: 'Danielle',     last: 'Adams',            email: 'dadams@terzocloud.com',         location: 'USA',   lastWorkingDate: '2025-05-12' },
  { first: 'Juan Pablo',   last: 'Giraldo Ramirez',  email: 'juanpablo@terzocloud.com',      location: 'USA',   lastWorkingDate: '2025-09-02' },
  { first: 'Kireeth',      last: 'Karunakaran',      email: 'kireeth@terzocloud.com',        location: 'USA',   lastWorkingDate: '2025-05-14' },
  { first: 'Shiv',         last: 'Patel',            email: 'shiv_patel@terzocloud.com',     location: 'USA',   lastWorkingDate: '2026-02-20' },
  { first: 'Andy',         last: 'Zschach',          email: 'andyz@terzocloud.com',          location: 'USA',   lastWorkingDate: '2026-02-20' },
  { first: 'Nicholas',     last: 'Theodorakis',      email: 'nicktheo@terzocloud.com',       location: 'USA',   lastWorkingDate: '2026-03-13' },
  { first: 'Michael',      last: 'Tran',             email: 'michael@terzocloud.com',        location: 'USA',   lastWorkingDate: '2026-03-24' },
];

async function run() {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  console.log(`✅  Connected → ${MONGO_URI}`);

  const allEmails = OFFBOARDED.map(e => e.email);

  // Find which users already exist
  const existing = await User.find({ email: { $in: allEmails } }, 'email').lean();
  const existingEmails = new Set(existing.map(u => u.email.toLowerCase()));

  const toUpdate = OFFBOARDED.filter(e => existingEmails.has(e.email));
  const toInsert = OFFBOARDED.filter(e => !existingEmails.has(e.email));

  // 1. Update existing users → Inactive + lastWorkingDate
  let updatedCount = 0;
  for (const emp of toUpdate) {
    await User.updateOne(
      { email: emp.email },
      { $set: { status: 'Inactive', lastWorkingDate: new Date(emp.lastWorkingDate) } }
    );
    updatedCount++;
  }
  if (updatedCount) console.log(`✅  Updated  ${updatedCount} existing user(s) → Inactive + lastWorkingDate`);

  // 2. Insert missing users as Inactive with lastWorkingDate
  if (toInsert.length) {
    const docs = toInsert.map(e => ({
      first:           e.first,
      last:            e.last,
      email:           e.email,
      location:        e.location,
      status:          'Inactive',
      role:            'Staff',
      employmentType:  'Full Time',
      lastWorkingDate: new Date(e.lastWorkingDate),
    }));
    await User.insertMany(docs, { ordered: false });
    console.log(`✅  Inserted ${toInsert.length} new user(s) as Inactive with lastWorkingDate`);
  }

  console.log(`\n📋  Summary: ${updatedCount} updated, ${toInsert.length} created — total ${OFFBOARDED.length} offboarded employees`);
  await mongoose.disconnect();
  console.log('🔌  Disconnected.');
}

run().catch(err => {
  console.error('❌  Migration failed:', err.message);
  process.exit(1);
});
