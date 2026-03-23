/**
 * seed/software.seed.js — Initial data seeds
 *
 * seedSoftware()   — inserts the software catalogue on first run (skips if data exists)
 * seedAdminUser()  — creates / migrates the default super-admin account
 */
const { Software, AdminUser } = require('../db');

// ── Software catalogue ────────────────────────────────────────────────────────
const SOFTWARE_SEED = [
  { csvId:'A-01', name:'Zoom', owner:'Brandon Card', admins:'Praveen M', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Management', purpose:'Communication', subscriptionPlan:'Zoom Workspace Business Plus', renewalPeriod:'Annual', annualCost:12098, licensePricePerUserMonth:25, purchasedLicenses:37, usedLicenses:46, siteUSA:true, siteCAN:true, siteIND:true, costUSA:6539, costCAN:3924, costIND:1635 },
  { csvId:'A-02', name:'Adobe Acrobat', owner:'Praveen M', admins:'Praveen M', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'HR & Legal', purpose:'PDF Editor', subscriptionPlan:'Business Plan', renewalPeriod:'Monthly', annualCost:1360.20, licensePricePerUserMonth:22.67, purchasedLicenses:5, usedLicenses:6, siteUSA:true, siteCAN:false, siteIND:true, costUSA:816, costCAN:0, costIND:544 },
  { csvId:'A-03', name:'Asana', owner:'Brandon Card', admins:'Praveen M', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Customer Success & AI Service', purpose:'Project Management', subscriptionPlan:'Business Starter Plan', renewalPeriod:'Annual', annualCost:6540, licensePricePerUserMonth:10.90, purchasedLicenses:50, usedLicenses:42, siteUSA:true, siteCAN:true, siteIND:true, costUSA:2861, costCAN:1635, costIND:2044 },
  { csvId:'A-04', name:'Jira (Atlassian)', owner:'Brandon Card', admins:'Praveen M / Mohanraja / Vasanth', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Engineering', purpose:'ITSM & Ticketing', subscriptionPlan:'', renewalPeriod:'Monthly', annualCost:28200, licensePricePerUserMonth:15, purchasedLicenses:48, usedLicenses:49, siteUSA:true, siteCAN:true, siteIND:true, costUSA:6600, costCAN:3000, costIND:18600 },
  { csvId:'A-05', name:'GitHub (Microsoft)', admins:'Vasanth', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Engineering', purpose:'Version Control', subscriptionPlan:'', renewalPeriod:'Monthly', annualCost:1584, licensePricePerUserMonth:4, purchasedLicenses:34, usedLicenses:29, siteUSA:true, siteCAN:false, siteIND:true, costUSA:170, costCAN:0, costIND:1414 },
  { csvId:'A-06', name:'Google Workspace', owner:'Brandon Card', admins:'Praveen M', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'All Departments', purpose:'Gmail & Productivity Suite', subscriptionPlan:'Enterprise Standard', renewalPeriod:'Monthly', annualCost:36240, licensePricePerUserMonth:20, purchasedLicenses:154, usedLicenses:154, siteUSA:true, siteCAN:true, siteIND:true, costUSA:13030, costCAN:7329, costIND:15880 },
  { csvId:'A-07', name:'HubSpot', owner:'Brandon Card', admins:'Brandon Card', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Sales', purpose:'CRM', subscriptionPlan:'', renewalPeriod:'Annual', annualCost:18370, purchasedLicenses:23, usedLicenses:19, siteUSA:true, siteCAN:false, siteIND:true, costUSA:14503, costCAN:0, costIND:3867 },
  { csvId:'A-08', name:'IntelliJ IDEA (JetBrains)', owner:'Mohanraja', admins:'Praveen M / Mohanraja', billedTo:'Eric Pritchett', deploymentType:'On-premises', department:'Engineering', purpose:'Coding IDE', subscriptionPlan:'IntelliJ Ultimate', renewalPeriod:'Annual', annualCost:8292.90, licensePricePerUserMonth:17.10, purchasedLicenses:23, usedLicenses:19, siteUSA:false, siteCAN:false, siteIND:true, costUSA:0, costCAN:0, costIND:8293 },
  { csvId:'A-09', name:'Loom', owner:'Brandon Card', admins:'Praveen M / Ragav', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Sales & Customer Success', purpose:'Screen Recording & Presentations', subscriptionPlan:'Loom Business', renewalPeriod:'Monthly', annualCost:1728, licensePricePerUserMonth:8, purchasedLicenses:18, usedLicenses:18, siteUSA:true, siteCAN:false, siteIND:true, costUSA:1152, costCAN:0, costIND:576 },
  { csvId:'A-10', name:'Microsoft 365', owner:'Brandon Card', admins:'Praveen M', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Management', purpose:'Office Suite', subscriptionPlan:'Business Premium', renewalPeriod:'Annual', annualCost:4488, licensePricePerUserMonth:22, purchasedLicenses:25, usedLicenses:26, siteUSA:true, siteCAN:false, siteIND:true, costUSA:3052, costCAN:0, costIND:1436 },
  { csvId:'A-11', name:'Slack', owner:'Brandon Card', admins:'Praveen M', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'All Departments', purpose:'Team Communication', subscriptionPlan:'Slack Business+', renewalPeriod:'Annual', annualCost:16020, licensePricePerUserMonth:15, purchasedLicenses:89, usedLicenses:92, siteUSA:true, siteCAN:true, siteIND:true, costUSA:5760, costCAN:3240, costIND:7020 },
  { csvId:'A-12', name:'Mosyle MDM', owner:'Praveen M', admins:'Praveen M', billedTo:'', deploymentType:'Freeware', department:'IT', purpose:'Device Management', subscriptionPlan:'Free', renewalPeriod:'Freeware', annualCost:0, purchasedLicenses:30, usedLicenses:25, siteUSA:false, siteCAN:false, siteIND:true, costUSA:0, costCAN:0, costIND:0 },
  { csvId:'A-13', name:'OpenVPN', owner:'Praveen M', admins:'Praveen M', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Engineering', purpose:'VPN / Private Network', subscriptionPlan:'', renewalPeriod:'Annual', annualCost:1680, licensePricePerUserMonth:6, purchasedLicenses:20, usedLicenses:20, siteUSA:true, siteCAN:true, siteIND:true, costUSA:84, costCAN:84, costIND:1512 },
  { csvId:'A-14', name:'Canva', owner:'Brandon Card', admins:'Praveen M', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Management', purpose:'Design & Presentations', subscriptionPlan:'Canva Teams', renewalPeriod:'Monthly', annualCost:1981, licensePricePerUserMonth:5.16, purchasedLicenses:32, usedLicenses:32, siteUSA:true, siteCAN:true, siteIND:true, costUSA:1424, costCAN:186, costIND:371 },
  { csvId:'A-15', name:'Postman', deploymentType:'Freeware', department:'Engineering', purpose:'API Testing', subscriptionPlan:'Freeware', renewalPeriod:'Freeware', annualCost:0, siteUSA:true, siteCAN:false, siteIND:true },
  { csvId:'A-16', name:'Freshworks', owner:'Gowtham Manohar', admins:'Harish', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Customer Support / HR', purpose:'Employee Onboarding & Offboarding', subscriptionPlan:'', renewalPeriod:'Annual', annualCost:3117, licensePricePerUserMonth:1039, purchasedLicenses:3, usedLicenses:3, siteUSA:false, siteCAN:false, siteIND:true, costUSA:0, costCAN:0, costIND:3117 },
  { csvId:'A-17', name:'Windsurf', owner:'Vasanth', admins:'Vasanth', billedTo:'Eric Pritchett', deploymentType:'On-premises', department:'Engineering', purpose:'Coding IDE', subscriptionPlan:'Teams Plan', renewalPeriod:'Monthly', annualCost:3960, licensePricePerUserMonth:30, purchasedLicenses:11, usedLicenses:12, siteUSA:false, siteCAN:false, siteIND:true, costUSA:0, costCAN:0, costIND:3960 },
  { csvId:'A-18', name:'Plaid', owner:'Mohanraja', admins:'Mohanraja', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Engineering', purpose:'Banking API Integration', subscriptionPlan:'Pay-as-you-go', renewalPeriod:'Monthly', annualCost:0, purchasedLicenses:3, usedLicenses:3, siteUSA:true, siteCAN:false, siteIND:true },
  { csvId:'A-19', name:'ProductBoard', owner:'Brad Grabowski', admins:'Himalaya / Brad', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Product', purpose:'Product Management & Roadmapping', subscriptionPlan:'Pro Plan', renewalPeriod:'Annual', annualCost:1416, licensePricePerUserMonth:59, purchasedLicenses:2, usedLicenses:4, siteUSA:true, siteCAN:false, siteIND:true, costUSA:708, costCAN:0, costIND:708 },
  { csvId:'A-20', name:'DocuSign', owner:'Brandon Card', admins:'Gowtham Manohar', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'HR / Legal', purpose:'Digital Signatures', subscriptionPlan:'Business Pro – Envelope Edition', renewalPeriod:'Annual', annualCost:7237.76, purchasedLicenses:9, usedLicenses:9, siteUSA:true, siteCAN:false, siteIND:true, costUSA:4825, costCAN:0, costIND:2413 },
  { csvId:'A-21', name:'Vercel', owner:'Himalaya', admins:'Himalaya', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Product', purpose:'Frontend Deployment', subscriptionPlan:'Pro Plan', renewalPeriod:'Monthly', annualCost:240, licensePricePerUserMonth:20, purchasedLicenses:1, usedLicenses:1, siteUSA:false, siteCAN:false, siteIND:true, costUSA:0, costCAN:0, costIND:240 },
  { csvId:'A-22', name:'Twilio SendGrid', owner:'Vasanth', admins:'Vasanth', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Engineering', purpose:'Transactional Email Service', subscriptionPlan:'Pro Plan (100k Mails)', renewalPeriod:'Monthly', annualCost:1988.04, licensePricePerUserMonth:165.57, purchasedLicenses:4, usedLicenses:4, siteUSA:false, siteCAN:false, siteIND:true, costUSA:0, costCAN:0, costIND:1988 },
  { csvId:'A-23', name:'Datadog', owner:'Vasanth', admins:'Vasanth / Ajay', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Engineering', purpose:'Monitoring & Observability', subscriptionPlan:'Pay-as-you-go', renewalPeriod:'Monthly', annualCost:56100, purchasedLicenses:35, usedLicenses:35, siteUSA:true, siteCAN:true, siteIND:true, costUSA:8014, costCAN:3206, costIND:44880 },
  { csvId:'A-24', name:'Gong', owner:'Brandon Card', admins:'Praveen / Brody', billedTo:'', deploymentType:'SAAS', department:'Sales', purpose:'Sales Call Recording & Analytics', subscriptionPlan:'', renewalPeriod:'Annual', annualCost:8250, purchasedLicenses:6, usedLicenses:7, siteUSA:true, siteCAN:true, siteIND:false, costUSA:7219, costCAN:1031, costIND:0 },
  { csvId:'A-25', name:'Figma', owner:'Brad Grabowski', admins:'Praveen / Brad Grabowski', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Engineering', purpose:'UI/UX Design', subscriptionPlan:'', renewalPeriod:'Annual', annualCost:500, purchasedLicenses:0, usedLicenses:0, siteUSA:true, siteCAN:false, siteIND:true, costUSA:500, costCAN:0, costIND:0 },
  { csvId:'A-26', name:'ChatGPT (OpenAI)', owner:'Brandon Card', admins:'Praveen / Brandon', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Management / AI Service', purpose:'AI Assistant', subscriptionPlan:'Teams Plan', renewalPeriod:'Monthly', annualCost:8280, licensePricePerUserMonth:30, purchasedLicenses:26, usedLicenses:28, siteUSA:true, siteCAN:true, siteIND:true, costUSA:4458, costCAN:2548, costIND:1274 },
  { csvId:'A-27', name:'Jenkins', owner:'Vasanth', admins:'Praveen M / Vasanth / Ajay', billedTo:'', deploymentType:'Open Source', department:'Engineering', purpose:'CI/CD Build Pipeline', subscriptionPlan:'Open Source', renewalPeriod:'Freeware', annualCost:0, purchasedLicenses:20, usedLicenses:0, siteUSA:false, siteCAN:true, siteIND:true },
  { csvId:'A-28', name:'Orum', owner:'Brody', admins:'Brody', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Sales', purpose:'Sales Calling Platform', subscriptionPlan:'', renewalPeriod:'Monthly', annualCost:3000, licensePricePerUserMonth:250, purchasedLicenses:1, usedLicenses:1, siteUSA:true, siteCAN:false, siteIND:false, costUSA:3000, costCAN:0, costIND:0 },
  { csvId:'A-29', name:'Apple Business Manager', owner:'Praveen M', admins:'Praveen M', billedTo:'', deploymentType:'Freeware', department:'IT', purpose:'Apple ID & Device Management', subscriptionPlan:'Freeware', renewalPeriod:'Freeware', annualCost:0, siteUSA:true, siteCAN:true, siteIND:true },
  { csvId:'A-30', name:'ChatPRD', owner:'Himalaya', admins:'Himalaya', billedTo:'Himalaya', deploymentType:'SAAS', department:'Product', purpose:'AI Product Requirements', subscriptionPlan:'Pro Plan', renewalPeriod:'Annual', annualCost:179, licensePricePerUserMonth:14.90, purchasedLicenses:1, usedLicenses:1, siteUSA:false, siteCAN:false, siteIND:true, costUSA:0, costCAN:0, costIND:179 },
  { csvId:'A-31', name:'AWS', owner:'Pradeep', admins:'Vasanth / Pradeep', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Engineering', purpose:'Cloud Infrastructure', subscriptionPlan:'Pay-as-you-go', renewalPeriod:'Monthly', annualCost:0, purchasedLicenses:0, usedLicenses:25, siteUSA:false, siteCAN:false, siteIND:true },
  { csvId:'A-32', name:'Miro', owner:'Himalaya', admins:'Praveen M / Himalaya', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Product', purpose:'Digital Whiteboard & Workflow', subscriptionPlan:'Starter Plan', renewalPeriod:'Monthly', annualCost:96, licensePricePerUserMonth:8, purchasedLicenses:1, usedLicenses:1, siteUSA:false, siteCAN:false, siteIND:true, costUSA:0, costCAN:0, costIND:96 },
  { csvId:'A-33', name:'Claude (Anthropic)', owner:'Luis', admins:'Luis', billedTo:'Eric Pritchett', deploymentType:'SAAS', department:'Engineering', purpose:'AI Assistant', subscriptionPlan:'Teams Plan', renewalPeriod:'Monthly', annualCost:0, purchasedLicenses:45, usedLicenses:45, siteUSA:false, siteCAN:false, siteIND:false },
];

// ── Seed software catalogue ────────────────────────────────────────────────────
// Normal mode  : skips if data already exists (safe for server restarts)
// Force mode   : upserts every entry from SOFTWARE_SEED (run with --force-software)
async function seedSoftware(force = false) {
  if (!force) {
    const count = await Software.countDocuments();
    if (count > 0) return;
  }
  // Upsert each app by csvId so existing portal edits are preserved for unlisted fields
  const ops = SOFTWARE_SEED.map(app => ({
    updateOne: {
      filter: { csvId: app.csvId },
      update: { $set: app },
      upsert: true,
    },
  }));
  const result = await Software.bulkWrite(ops);
  console.log(`✅  Software synced: ${result.upsertedCount} inserted, ${result.modifiedCount} updated (${SOFTWARE_SEED.length} total)`);
}

// ── Seed / migrate default super-admin account ────────────────────────────────
async function seedAdminUser() {
  // Migrate legacy placeholder email if it still exists
  const old = await AdminUser.findOne({ email: 'admin@terzocloud.com' });
  if (old) {
    old.email = 'praveen.m@terzocloud.com';
    old.name  = 'Praveen M.';
    old.role  = 'super_admin';
    await old.save();
    console.log('✅  Super admin migrated → praveen.m@terzocloud.com');
    return;
  }
  // Fresh install — create only if no admin users exist yet
  const count = await AdminUser.countDocuments();
  if (count > 0) return;
  await AdminUser.create({
    name:     'Praveen M.',
    email:    'praveen.m@terzocloud.com',
    password: 'Admin@123',
    role:     'super_admin',
    status:   'Active',
  });
  console.log('✅  Default super admin seeded → praveen.m@terzocloud.com / Admin@123');
}

module.exports = { seedSoftware, seedAdminUser };
