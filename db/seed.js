/**
 * db/seed.js
 * Populates the Terzo Asset Portal database with the 40 users and 42 assets
 * that currently live in user-asset-portal.html.
 *
 * Run:
 *   node db/seed.js                          — seed users + assets
 *   node db/seed.js --force-software         — seed users + assets AND force-sync software
 *   MONGO_URI=mongodb://... node db/seed.js  — with custom DB URI
 *
 * The script clears users + assets before inserting. Software is only re-synced
 * when --force-software is passed.
 */

require('dotenv').config(); // optional – reads .env if present
const { connect, disconnect, User, Asset } = require('./index');
const { seedSoftware } = require('../seed/software.seed');
const FORCE_SOFTWARE = process.argv.includes('--force-software');
const SAFE_MODE = process.argv.includes('--safe');

// ─── 1. USERS ──────────────────────────────────────────────────────────────────
const USERS_RAW = [
  {legacyId:'u1', first:'Ajay Christopher', last:'Hubert', email:'ajay.christopher.hubert@terzocloud.com', role:'Editor', status:'Active', dept:'Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Staff Software Engineer', reportingManager:'Vasanth Pandian'},
  {legacyId:'u2', first:'Karthi', last:'', email:'karthi@terzocloud.com', role:'Editor', status:'Active', dept:'Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Software Engineer III', reportingManager:'Vasanth Pandian'},
  {legacyId:'u3', first:'Ahamad', last:'Riyas', email:'ahamad.riyas@terzocloud.com', role:'Editor', status:'Active', dept:'Data Science - Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Software Engineer III', reportingManager:'Ragav R'},
  {legacyId:'u4', first:'Kavipriya', last:'', email:'kavipriya@terzocloud.com', role:'Editor', status:'Active', dept:'Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Software Engineer III', reportingManager:'Vasanth Pandian'},
  {legacyId:'u5', first:'Ananya', last:'', email:'ananya@terzocloud.com', role:'Editor', status:'Active', dept:'Data Science - Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Software Engineer III', reportingManager:'Ragav R'},
  {legacyId:'u6', first:'Shunmugavel', last:'', email:'shunmugavel@terzocloud.com', role:'Editor', status:'Active', dept:'Data Science - Engineering', location:'Coimbatore', phone:'', joined:'2023-01-01', jobTitle:'Software Engineer III', reportingManager:'Ragav R'},
  {legacyId:'u7', first:'Prasanna', last:'Kumar', email:'prasanna.kumar@terzocloud.com', role:'Viewer', status:'Active', dept:'Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Senior Software Engineer', reportingManager:'Paventhan PKP'},
  {legacyId:'u8', first:'Hariharan', last:'', email:'hariharan@terzocloud.com', role:'Editor', status:'Active', dept:'Data Science', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Lead Software Engineer', reportingManager:'Ragav R'},
  {legacyId:'u9', first:'Paventhan', last:'', email:'paventhan@terzocloud.com', role:'Editor', status:'Active', dept:'Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Senior Manager', reportingManager:'Pradeep Thangavel'},
  {legacyId:'u10', first:'Vinotha', last:'', email:'vinotha@terzocloud.com', role:'Editor', status:'Active', dept:'Engineering', location:'Coimbatore', phone:'', joined:'2023-01-01', jobTitle:'Senior Software Engineer', reportingManager:'Vasanth Pandian'},
  {legacyId:'u11', first:'Mythilipriya', last:'', email:'mythilipriya@terzocloud.com', role:'Editor', status:'Active', dept:'Data Science - Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Software Engineer III', reportingManager:'Ragav R'},
  {legacyId:'u12', first:'Divya', last:'R', email:'divya.r@terzocloud.com', role:'Editor', status:'Active', dept:'Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Software Engineer III', reportingManager:'Vasanth Pandian'},
  {legacyId:'u13', first:'Dineshkumar', last:'V', email:'dineshkumar.v@terzocloud.com', role:'Editor', status:'Active', dept:'Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Software Engineer III', reportingManager:'Vasanth Pandian'},
  {legacyId:'u14', first:'Dinesh', last:'B', email:'dinesh.b@terzocloud.com', role:'Editor', status:'Active', dept:'Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Staff Software Engineer', reportingManager:'Vasanth Pandian'},
  {legacyId:'u15', first:'Vasanth', last:'Pandian', email:'vasanth.pandian@terzocloud.com', role:'Editor', status:'Active', dept:'Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Director of Engineering', reportingManager:'Luis Ocegueda'},
  {legacyId:'u16', first:'Mohanamala', last:'', email:'mohanamala@terzocloud.com', role:'Editor', status:'Active', dept:'Data Science - Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Staff Software Engineer', reportingManager:'Ragav R'},
  {legacyId:'u17', first:'Divya', last:'M', email:'divya.m@terzocloud.com', role:'Editor', status:'Active', dept:'Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Senior Software Engineer', reportingManager:'Vasanth Pandian'},
  {legacyId:'u18', first:'Gowtham', last:'V', email:'gowtham.v@terzocloud.com', role:'Editor', status:'Active', dept:'Data Science - Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Staff Software Engineer', reportingManager:'Ragav R'},
  {legacyId:'u19', first:'Iyyappan', last:'', email:'iyyappan@terzocloud.com', role:'Editor', status:'Active', dept:'Data Science - Engineering', location:'Coimbatore', phone:'', joined:'2023-01-01', jobTitle:'Staff Software Engineer', reportingManager:'Ragav R'},
  {legacyId:'u20', first:'Ragav', last:'', email:'ragav@terzocloud.com', role:'Editor', status:'Active', dept:'Data Science - Engineering', location:'Coimbatore', phone:'', joined:'2023-01-01', jobTitle:'Director of Engineering', reportingManager:'Luis Ocegueda'},
  {legacyId:'u21', first:'Harshni', last:'', email:'harshni@terzocloud.com', role:'Editor', status:'Active', dept:'AI Services', location:'Coimbatore', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst (IN)', reportingManager:'Dhanusha Arumugam'},
  {legacyId:'u22', first:'Priyadharshini', last:'', email:'priyadharshini@terzocloud.com', role:'Editor', status:'Active', dept:'AI Services', location:'Coimbatore', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst (IN)', reportingManager:'Dhanusha Arumugam'},
  {legacyId:'u23', first:'Aswini', last:'', email:'aswini@terzocloud.com', role:'Editor', status:'Active', dept:'AI Services', location:'Coimbatore', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst (IN)', reportingManager:'Dhanusha Arumugam'},
  {legacyId:'u24', first:'Dharshini', last:'', email:'dharshini@terzocloud.com', role:'Editor', status:'Active', dept:'AI Services', location:'Coimbatore', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst (IN)', reportingManager:'Dhanusha Arumugam'},
  {legacyId:'u25', first:'Kavimitraa', last:'', email:'kavimitraa@terzocloud.com', role:'Editor', status:'Active', dept:'AI Services', location:'Coimbatore', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst (IN)', reportingManager:'Dhanusha Arumugam'},
  {legacyId:'u26', first:'Nivetha', last:'', email:'nivetha@terzocloud.com', role:'Editor', status:'Active', dept:'AI Services', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Senior Data Analyst (IN)', reportingManager:'Dhanusha Arumugam'},
  {legacyId:'u27', first:'Dhanusha', last:'', email:'dhanusha@terzocloud.com', role:'Editor', status:'Active', dept:'AI Services', location:'Coimbatore', phone:'', joined:'2023-01-01', jobTitle:'Lead Analyst (IN)', reportingManager:'Yogesh Selvakumaran'},
  {legacyId:'u28', first:'Sowmya', last:'', email:'sowmya@terzocloud.com', role:'Viewer', status:'Active', dept:'Engineering', location:'Coimbatore', phone:'', joined:'2023-01-01', jobTitle:'Senior Software Engineer', reportingManager:'Paventhan PKP'},
  {legacyId:'u29', first:'Harish', last:'', email:'harish@terzocloud.com', role:'Viewer', status:'Active', dept:'Operations', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'India, General Manager & Head of Customer Support', reportingManager:'Pradeep Thangavel'},
  {legacyId:'u30', first:'Praveen', last:'M', email:'praveen.m@terzocloud.com', role:'Admin', status:'Active', dept:'IT', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'', reportingManager:''},
  {legacyId:'u31', first:'Karthick', last:'R', email:'karthick.r@terzocloud.com', role:'Editor', status:'Active', dept:'AI Services', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst (IN)', reportingManager:'Dhanusha Arumugam'},
  {legacyId:'u32', first:'Leo', last:'Deepak', email:'leo.deepak@terzocloud.com', role:'Editor', status:'Active', dept:'AI Services', location:'Coimbatore', phone:'', joined:'2023-01-01', jobTitle:'Senior Data Analyst (IN)', reportingManager:'Dhanusha Arumugam'},
  {legacyId:'u33', first:'Gowtham', last:'Manohar', email:'gowtham.manohar@terzocloud.com', role:'Manager', status:'Active', dept:'AI Services', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'AI Operations Manager', reportingManager:'Kevin Character'},
  {legacyId:'u34', first:'Himalaya', last:'', email:'himalaya@terzocloud.com', role:'Manager', status:'Active', dept:'Product', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Product Manager', reportingManager:'Zeyad Rajabi'},
  {legacyId:'u35', first:'Yogesh', last:'', email:'yogesh@terzocloud.com', role:'Editor', status:'Active', dept:'AI Services', location:'Coimbatore', phone:'', joined:'2023-01-01', jobTitle:'Manager - AI Services, India Lead', reportingManager:'Griffin Rutstein'},
  {legacyId:'u36', first:'Mohanraja', last:'', email:'mohanraja@terzocloud.com', role:'Editor', status:'Active', dept:'Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Senior Principal Engineer', reportingManager:'Luis Ocegueda'},
  {legacyId:'u37', first:'Urvasi', last:'', email:'urvasi@terzocloud.com', role:'Viewer', status:'Active', dept:'Accounts', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'', reportingManager:''},
  {legacyId:'u38', first:'Pradeep', last:'', email:'pradeep@terzocloud.com', role:'Editor', status:'Active', dept:'Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Executive Vice President (India)', reportingManager:'Zeyad Rajabi'},
  {legacyId:'u39', first:'Niranjan', last:'', email:'niranjan@terzocloud.com', role:'Editor', status:'Active', dept:'Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Software Engineer III', reportingManager:'Vasanth Pandian'},
  {legacyId:'u40', first:'Revathi', last:'', email:'revathi@terzocloud.com', role:'Editor', status:'Active', dept:'Engineering', location:'Chennai', phone:'', joined:'2023-01-01', jobTitle:'Staff Engineer', reportingManager:'Ragav R'},
  {legacyId:'u41', first:'Brandon', last:'Card', email:'bcard@terzocloud.com', role:'Viewer', status:'Active', dept:'Executive', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Chief Executive Officer', reportingManager:'', employmentType:'Full Time'},
  {legacyId:'u42', first:'Brad', last:'Grabowski', email:'bradg@terzocloud.com', role:'Viewer', status:'Active', dept:'Product', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Director of Product Design', reportingManager:'Zeyad Rajabi', employmentType:'Full Time'},
  {legacyId:'u43', first:'Eric', last:'Pritchett', email:'epritchett@terzocloud.com', role:'Viewer', status:'Active', dept:'Executive', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Chief Operations Officer', reportingManager:'', employmentType:'Full Time'},
  {legacyId:'u44', first:'Spencer', last:'Ross', email:'sross@terzocloud.com', role:'Viewer', status:'Active', dept:'Sales', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Director of Global Sales', reportingManager:'Brandon Card', employmentType:'Full Time'},
  {legacyId:'u45', first:'Michail', last:'Angarsky', email:'michael.angarsky@terzocloud.com', role:'Viewer', status:'Active', dept:'Legal', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'General Counsel and Head of HR', reportingManager:'Brandon Card', employmentType:'Full Time'},
  {legacyId:'u46', first:'Griffin', last:'Rutstein', email:'griffin@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Head of Global AI Services', reportingManager:'Kevin Character', employmentType:'Full Time'},
  {legacyId:'u47', first:'Kevin', last:'Redwine', email:'kredwine@terzocloud.com', role:'Viewer', status:'Active', dept:'Executive', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Chief Data Science Officer', reportingManager:'', employmentType:'Full Time'},
  {legacyId:'u48', first:'Vincent', last:'Halle', email:'vincent@terzocloud.com', role:'Viewer', status:'Active', dept:'Data Science', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Director of Development', reportingManager:'Luis Ocegueda', employmentType:'Full Time'},
  {legacyId:'u49', first:'Kristen', last:'Pritchett', email:'kristenp@terzocloud.com', role:'Viewer', status:'Active', dept:'Human Resources', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Manager, Human Resources', reportingManager:'Michail Angarsky', employmentType:'Full Time'},
  {legacyId:'u50', first:'Andrew', last:'Forbes', email:'andrew@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Manager, Data Strategy (CAN)', reportingManager:'Griffin Rutstein', employmentType:'Full Time'},
  {legacyId:'u51', first:'Anna', last:'Gurvits', email:'anna@terzocloud.com', role:'Viewer', status:'Active', dept:'Marketing', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Integrated Marketing Manager', reportingManager:'Heather Silverman', employmentType:'Full Time'},
  {legacyId:'u52', first:'Ashlee', last:'Vargas', email:'av@terzocloud.com', role:'Viewer', status:'Active', dept:'Executive Administration', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Executive Assistant to the CEO', reportingManager:'Brandon Card', employmentType:'Full Time'},
  {legacyId:'u53', first:'Brody', last:'Elkins', email:'belkins@terzocloud.com', role:'Viewer', status:'Active', dept:'Sales', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Account Executive', reportingManager:'Brandon Card', employmentType:'Full Time'},
  {legacyId:'u54', first:'Caelan', last:'Seto', email:'cseto@terzocloud.com', role:'Viewer', status:'Active', dept:'Data Science', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Associate Software Developer', reportingManager:'Vasanth Pandian', employmentType:'Full Time'},
  {legacyId:'u55', first:'Daniela', last:'Nash', email:'daniela@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst  (CAN)', reportingManager:'Stephanie Yaacoub', employmentType:'Full Time'},
  {legacyId:'u56', first:'Feroz', last:'Mudupully', email:'ferozkhan@terzocloud.com', role:'Viewer', status:'Active', dept:'Customer Operations', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Engagement Director', reportingManager:'Kevin Character', employmentType:'Full Time'},
  {legacyId:'u57', first:'Heather', last:'Silverman', email:'hsilverman@terzocloud.com', role:'Viewer', status:'Active', dept:'Marketing', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Vice President of Marketing and Communications', reportingManager:'Brandon Card', employmentType:'Full Time'},
  {legacyId:'u58', first:'Jason', last:'Anderman', email:'janderman@terzocloud.com', role:'Viewer', status:'Active', dept:'Legal', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Deputy General Counsel', reportingManager:'Michail Angarsky', employmentType:'Full Time'},
  {legacyId:'u59', first:'JP', last:'Giraldo Ramirez', email:'juanpablo@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst', reportingManager:'Kioaka Bynum', employmentType:'Full Time'},
  {legacyId:'u60', first:'Justin', last:'Adams', email:'justin.a@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst', reportingManager:'Kioaka Bynum', employmentType:'Full Time'},
  {legacyId:'u61', first:'Kade', last:'Manuel', email:'kade@terzocloud.com', role:'Viewer', status:'Active', dept:'Customer Operations', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Customer Support Manager', reportingManager:'Kevin Character', employmentType:'Full Time'},
  {legacyId:'u62', first:'Ken', last:'Calder', email:'kcalder@terzocloud.com', role:'Viewer', status:'Active', dept:'Data Science', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Senior Full Stack Developer', reportingManager:'Luis Ocegueda', employmentType:'Full Time'},
  {legacyId:'u63', first:'Kevin', last:'Character', email:'kcharacter@terzocloud.com', role:'Viewer', status:'Active', dept:'Customer Operations', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Vice President, Customer Operations', reportingManager:'Brandon Card', employmentType:'Full Time'},
  {legacyId:'u64', first:'Kieran', last:'Murphy', email:'kieran@terzocloud.com', role:'Viewer', status:'Active', dept:'Marketing', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Creative Director', reportingManager:'Heather Silverman', employmentType:'Full Time'},
  {legacyId:'u65', first:'Kioaka', last:'Bynum', email:'kbynum@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Manager, AI Services (US)', reportingManager:'Griffin Rutstein', employmentType:'Full Time'},
  {legacyId:'u66', first:'Lindsey', last:'Still', email:'lindsey@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst II', reportingManager:'Kioaka Bynum', employmentType:'Full Time'},
  {legacyId:'u67', first:'Luc', last:'Belanger', email:'luc.belanger@terzocloud.com', role:'Viewer', status:'Active', dept:'Data Science', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Principal Applied Science', reportingManager:'Philippe Grangier', employmentType:'Full Time'},
  {legacyId:'u68', first:'Lucia', last:'Steiner', email:'lucia@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst (CAN)', reportingManager:'Stephanie Yaacoub', employmentType:'Full Time'},
  {legacyId:'u69', first:'Luis', last:'Ocegueda', email:'luis@terzocloud.com', role:'Viewer', status:'Active', dept:'Engineering', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Director of Engineering', reportingManager:'Zeyad Rajabi', employmentType:'Full Time'},
  {legacyId:'u70', first:'Luke', last:'Ashworth', email:'lashworth@terzocloud.com', role:'Viewer', status:'Active', dept:'Customer Operations', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Engagement Manager II', reportingManager:'Kevin Character', employmentType:'Full Time'},
  {legacyId:'u71', first:'Matt', last:'Hines', email:'matt.hines@terzocloud.com', role:'Viewer', status:'Active', dept:'Accounting / Finance', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Corporate Controller', reportingManager:'', employmentType:'Full Time'},
  {legacyId:'u72', first:'Max', last:'Ferguson', email:'maxferguson@terzocloud.com', role:'Viewer', status:'Active', dept:'Sales', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Director of Strategic Partnerships', reportingManager:'Brandon Card', employmentType:'Full Time'},
  {legacyId:'u73', first:'Max', last:'Perlstein', email:'max@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Senior Data Analyst', reportingManager:'Kioaka Bynum', employmentType:'Full Time'},
  {legacyId:'u74', first:'Maxime', last:'Jacques', email:'maxime@terzocloud.com', role:'Viewer', status:'Active', dept:'Data Science', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Senior AI/ML Developer', reportingManager:'Ragav R', employmentType:'Full Time'},
  {legacyId:'u75', first:'Melany', last:'Delgado', email:'melany@terzocloud.com', role:'Viewer', status:'Active', dept:'Data Science', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Technical Program Manager', reportingManager:'Zeyad Rajabi', employmentType:'Full Time'},
  {legacyId:'u76', first:'Miaoyin', last:'Li', email:'miaoyin@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst (CAN)', reportingManager:'Stephanie Yaacoub', employmentType:'Full Time'},
  {legacyId:'u77', first:'Michael', last:'Tran', email:'michael@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst', reportingManager:'Kioaka Bynum', employmentType:'Full Time'},
  {legacyId:'u78', first:'Natan', last:'Sakajiri', email:'natan@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst (CAN)', reportingManager:'Stephanie Yaacoub', employmentType:'Full Time'},
  {legacyId:'u79', first:'Nicholas', last:'McGaughey', email:'nicholas@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst', reportingManager:'Kioaka Bynum', employmentType:'Full Time'},
  {legacyId:'u80', first:'Nicholas', last:'Theodorakis', email:'nicktheo@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst (CAN)', reportingManager:'Stephanie Yaacoub', employmentType:'Full Time'},
  {legacyId:'u81', first:'Philippe', last:'Grangier', email:'philippe@terzocloud.com', role:'Viewer', status:'Active', dept:'Data Science', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Director, Applied Science', reportingManager:'Luis Ocegueda', employmentType:'Full Time'},
  {legacyId:'u82', first:'Ritu', last:'Patel', email:'ritu@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst', reportingManager:'Kioaka Bynum', employmentType:'Full Time'},
  {legacyId:'u83', first:'Sena', last:'Onen Oz', email:'sena@terzocloud.com', role:'Viewer', status:'Active', dept:'Data Science', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Scientist', reportingManager:'Philippe Grangier', employmentType:'Full Time'},
  {legacyId:'u84', first:'Stephanie', last:'Yaacoub', email:'stephanie@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Manager, AI Services (CAN LEAD)', reportingManager:'Griffin Rutstein', employmentType:'Full Time'},
  {legacyId:'u85', first:'Stephen', last:'Horn', email:'stephen@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst II', reportingManager:'Kioaka Bynum', employmentType:'Full Time'},
  {legacyId:'u86', first:'Tian', last:'Gao', email:'tian@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst (CAN)', reportingManager:'Stephanie Yaacoub', employmentType:'Full Time'},
  {legacyId:'u87', first:'Zeyad', last:'Rajabi', email:'zeyad.r@terzocloud.com', role:'Viewer', status:'Active', dept:'Executive', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Chief Product Officer', reportingManager:'Brandon Card', employmentType:'Full Time'},
  {legacyId:'u88', first:'Ryan', last:'Tanner', email:'rtanner@terzocloud.com', role:'Viewer', status:'Active', dept:'Marketing', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Marketing-Designer', reportingManager:'', employmentType:'Contractor'},
  {legacyId:'u89', first:'Sameer', last:'Sharma', email:'sameer@terzocloud.com', role:'Viewer', status:'Active', dept:'Customer Operations', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Engagement Director', reportingManager:'Kevin Character', employmentType:'Full Time'},
  {legacyId:'u90', first:'Avinesh', last:'Bedi', email:'avinesh@terzocloud.com', role:'Viewer', status:'Active', dept:'Customer Operations', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Engagement Associate', reportingManager:'', employmentType:'Full Time'},
  {legacyId:'u91', first:'Edward', last:'Warszycki', email:'edward@terzocloud.com', role:'Viewer', status:'Active', dept:'Sales', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Director of Sales, Northeast', reportingManager:'Brandon Card', employmentType:'Full Time'},
  {legacyId:'u92', first:'Parker', last:'Walrod', email:'parker@terzocloud.com', role:'Viewer', status:'Active', dept:'AI Services', location:'Remote', phone:'', joined:'2023-01-01', jobTitle:'Data Analyst', reportingManager:'Kioaka Bynum', employmentType:'Full Time'},
  {legacyId:'u93', first:'Michael', last:'Deal', email:'michael.deal@terzocloud.com', role:'Viewer', status:'Active', dept:'Accounting / Finance', location:'USA', phone:'', joined:'2023-01-01', jobTitle:'Head of Finance', reportingManager:'Brandon Card', employmentType:'Full Time'},
];

// ─── 2. ASSETS (legacyAssignTo references user legacyId) ──────────────────────
const ASSETS_RAW = [
  {csvId:'A-01',name:'Macbook Pro 14',  type:'Laptop',serial:'KP93V707J0',   brand:'Apple / M2 Pro',  desc:'16GB RAM - 512GB SSD M2-PRO',         status:'In-Use',    legacyAssignTo:'u1', location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-02',name:'Macbook Pro 14',  type:'Laptop',serial:'GF4R65H4DH',   brand:'Apple / M2 Pro',  desc:'16GB RAM - 512GB SSD M2-PRO',         status:'In-Use',    legacyAssignTo:'u2', location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-03',name:'Macbook Pro 14',  type:'Laptop',serial:'L043T093TR',   brand:'Apple / M2 Pro',  desc:'16GB RAM - 512GB SSD M2-PRO',         status:'In-Use',    legacyAssignTo:'u3', location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-04',name:'Macbook Pro 14',  type:'Laptop',serial:'RVM9Q97FJD',   brand:'Apple / M2 Pro',  desc:'16GB RAM - 512GB SSD M2-PRO',         status:'In-Use',    legacyAssignTo:'u4', location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-05',name:'Macbook Pro 14',  type:'Laptop',serial:'G59R0CG61T',   brand:'Apple / M2 Pro',  desc:'16GB RAM - 512GB SSD M2-PRO',         status:'In-Use',    legacyAssignTo:'u5', location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-06',name:'Macbook Pro 14',  type:'Laptop',serial:'XVGHD2R64D',   brand:'Apple / M2 Pro',  desc:'16GB RAM - 512GB SSD M2-PRO',         status:'In-Use',    legacyAssignTo:'u6', location:'Coimbatore', dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-07',name:'Macbook Pro 14',  type:'Laptop',serial:'X4L9414L27',   brand:'Apple / M2 Pro',  desc:'16GB RAM - 512GB SSD M2-PRO',         status:'In-Use',    legacyAssignTo:'u7', location:'Chennai',    dept:'QA',               vendor:'Sniper Systems',notes:''},
  {csvId:'A-08',name:'Macbook Pro 14',  type:'Laptop',serial:'P4Y43FNJWR',   brand:'Apple / M2 Pro',  desc:'16GB RAM - 512GB SSD M2-PRO',         status:'In-Use',    legacyAssignTo:'u8', location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-09',name:'Macbook Pro 14',  type:'Laptop',serial:'FQKJ3X4X13',   brand:'Apple / M2 Pro',  desc:'16GB RAM - 512GB SSD M2-PRO',         status:'In-Use',    legacyAssignTo:'u9', location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-10',name:'Macbook Pro 14',  type:'Laptop',serial:'JQRXPG4X5Y',   brand:'Apple / M2 Pro',  desc:'16GB RAM - 512GB SSD M2-PRO',         status:'Available', legacyAssignTo:'',   location:'Coimbatore', dept:'Engineering',      vendor:'Sniper Systems',notes:'MLB Replaced & Speaker 9/01/2026 (Murali)'},
  {csvId:'A-11',name:'Macbook Pro 14',  type:'Laptop',serial:'GR242J52P1',   brand:'Apple / M2 Pro',  desc:'16GB RAM - 512GB SSD M2-PRO',         status:'In-Use',    legacyAssignTo:'u11',location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-12',name:'Macbook Pro 14',  type:'Laptop',serial:'LQJ326N9Y5',   brand:'Apple / M2 Pro',  desc:'16GB RAM - 512GB SSD M2-PRO',         status:'In-Use',    legacyAssignTo:'u12',location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-13',name:'Macbook Pro 14',  type:'Laptop',serial:'SQ95WC16JDP',  brand:'Apple / M1 Pro',  desc:'16GB RAM - 512GB SSD M1-PRO',         status:'In-Use',    legacyAssignTo:'u13',location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-14',name:'Macbook Pro 14',  type:'Laptop',serial:'SC7XG64K4M0',  brand:'Apple / M1 Pro',  desc:'16GB RAM - 512GB SSD M1-PRO',         status:'In-Use',    legacyAssignTo:'u14',location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-15',name:'Macbook Pro 14',  type:'Laptop',serial:'ST6DP29K320',  brand:'Apple / M1 Pro',  desc:'16GB RAM - 512GB SSD M1-PRO',         status:'In-Use',    legacyAssignTo:'u15',location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-16',name:'Macbook Pro 14',  type:'Laptop',serial:'KG4P92VL2F',   brand:'Apple / M1 Pro',  desc:'16GB RAM - 512GB SSD M1-PRO',         status:'In-Use',    legacyAssignTo:'u16',location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:'Display, battery, speaker replaced 03/10/2023'},
  {csvId:'A-17',name:'Macbook Pro 14',  type:'Laptop',serial:'SPYH4X30W36',  brand:'Apple / M1 Pro',  desc:'16GB RAM - 512GB SSD M1-PRO',         status:'In-Use',    legacyAssignTo:'u17',location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-18',name:'Macbook Pro 14',  type:'Laptop',serial:'X1YJ2WGFTH',   brand:'Apple / M1 Pro',  desc:'16GB RAM - 512GB SSD M1-PRO',         status:'In-Use',    legacyAssignTo:'u18',location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:'MLB Replaced 30/01/2024'},
  {csvId:'A-19',name:'Macbook Pro 14',  type:'Laptop',serial:'WXQG52LV27',   brand:'Apple / M1 Pro',  desc:'16GB RAM - 512GB SSD M1-PRO',         status:'In-Use',    legacyAssignTo:'u19',location:'Coimbatore', dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-20',name:'Macbook Pro 14',  type:'Laptop',serial:'K06D165GJF',   brand:'Apple / M1 Pro',  desc:'16GB RAM - 512GB SSD M1-PRO',         status:'In-Use',    legacyAssignTo:'u20',location:'Coimbatore', dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-21',name:'Macbook Pro 13',  type:'Laptop',serial:'SFVHFJ132Q05D',brand:'Apple / M1',      desc:'8GB RAM - 256GB SSD M1',              status:'In-Use',    legacyAssignTo:'u21',location:'Coimbatore', dept:'AI-Service',       vendor:'Sniper Systems',notes:''},
  {csvId:'A-22',name:'Macbook Pro 13',  type:'Laptop',serial:'SFVHFJ13MQ05D',brand:'Apple / M1',      desc:'8GB RAM - 256GB SSD M1',              status:'In-Use',    legacyAssignTo:'u22',location:'Coimbatore', dept:'AI-Service',       vendor:'Sniper Systems',notes:''},
  {csvId:'A-23',name:'Macbook Pro 13',  type:'Laptop',serial:'SFVFG3WSPQ05D',brand:'Apple / M1',      desc:'8GB RAM - 256GB SSD M1',              status:'In-Use',    legacyAssignTo:'u23',location:'Coimbatore', dept:'AI-Service',       vendor:'Sniper Systems',notes:''},
  {csvId:'A-24',name:'Macbook Pro 13',  type:'Laptop',serial:'SFVFFHMRQQ05D',brand:'Apple / M1',      desc:'8GB RAM - 256GB SSD M1',              status:'In-Use',    legacyAssignTo:'u24',location:'Coimbatore', dept:'AI-Service',       vendor:'Sniper Systems',notes:''},
  {csvId:'A-25',name:'Macbook Pro 13',  type:'Laptop',serial:'SFVFFJ2YKQ05D',brand:'Apple / M1',      desc:'8GB RAM - 256GB SSD M1',              status:'In-Use',    legacyAssignTo:'u25',location:'Coimbatore', dept:'AI-Service',       vendor:'Sniper Systems',notes:''},
  {csvId:'A-26',name:'Macbook Pro 13',  type:'Laptop',serial:'FVHFJ157Q05D', brand:'Apple / Intel i5',desc:'8GB RAM - 128GB SSD Intel i5',        status:'In-Use',    legacyAssignTo:'u26',location:'Chennai',    dept:'AI-Service',       vendor:'Sniper Systems',notes:''},
  {csvId:'A-27',name:'Macbook Pro 13',  type:'Laptop',serial:'FVFFFL1UQ05D', brand:'Apple / M1',      desc:'8GB RAM - 256GB SSD M1',              status:'In-Use',    legacyAssignTo:'u27',location:'Coimbatore', dept:'AI-Service',       vendor:'Sniper Systems',notes:''},
  {csvId:'A-28',name:'Macbook Pro 13',  type:'Laptop',serial:'FVFFHMRBQ05D', brand:'Apple / M1',      desc:'8GB RAM - 256GB SSD M1',              status:'In-Use',    legacyAssignTo:'u28',location:'Coimbatore', dept:'QA',               vendor:'Sniper Systems',notes:''},
  {csvId:'A-29',name:'Macbook Air 13',  type:'Laptop',serial:'C02F29NWQ6L7', brand:'Apple / M1',      desc:'8GB RAM - 256GB SSD M1',              status:'In-Use',    legacyAssignTo:'u29',location:'Chennai',    dept:'Customer Support', vendor:'Sniper Systems',notes:''},
  {csvId:'A-30',name:'Macbook Air 13',  type:'Laptop',serial:'SC02G37NBQ6L4',brand:'Apple / M1',      desc:'8GB RAM - 256GB SSD M1',              status:'In-Use',    legacyAssignTo:'u30',location:'Chennai',    dept:'IT',               vendor:'Sniper Systems',notes:''},
  {csvId:'A-31',name:'Macbook Air 13',  type:'Laptop',serial:'SFVFJK7D0Q6L4',brand:'Apple / M1',      desc:'8GB RAM - 256GB SSD M1',              status:'In-Use',    legacyAssignTo:'u31',location:'Chennai',    dept:'AI-Service',       vendor:'Sniper Systems',notes:''},
  {csvId:'A-32',name:'Macbook Air 13',  type:'Laptop',serial:'SFVFJK743Q6L4',brand:'Apple / M1',      desc:'8GB RAM - 256GB SSD M1',              status:'In-Use',    legacyAssignTo:'u32',location:'Coimbatore', dept:'AI-Service',       vendor:'Sniper Systems',notes:''},
  {csvId:'A-33',name:'Macbook Air 13',  type:'Laptop',serial:'SDY2VLXJ6MH',  brand:'Apple / M2',      desc:'8GB RAM - 256GB SSD M2',              status:'In-Use',    legacyAssignTo:'u33',location:'Chennai',    dept:'HR',               vendor:'Sniper Systems',notes:''},
  {csvId:'A-34',name:'Macbook Air 13',  type:'Laptop',serial:'SK9242NXCJ3',  brand:'Apple / M2',      desc:'8GB RAM - 256GB SSD M2',              status:'In-Use',    legacyAssignTo:'u34',location:'Chennai',    dept:'Product',          vendor:'Sniper Systems',notes:''},
  {csvId:'A-35',name:'Macbook Air 13',  type:'Laptop',serial:'C0XCLQ1WR1',   brand:'Apple / M2',      desc:'8GB RAM - 256GB SSD M2',              status:'In-Use',    legacyAssignTo:'u35',location:'Coimbatore', dept:'AI-Service',       vendor:'Sniper Systems',notes:''},
  {csvId:'A-36',name:'Macbook Pro 15',  type:'Laptop',serial:'C02XH82KJG5L', brand:'Apple / Intel i9',desc:'16GB RAM - 512GB SSD Intel i9',       status:'In-Use',    legacyAssignTo:'u36',location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-37',name:'Lenovo Ideapad',  type:'Laptop',serial:'PG02HQZX',     brand:'Lenovo / AMD R5', desc:'8GB RAM - 512GB SSD AMD R5',          status:'In-Use',    legacyAssignTo:'u30',location:'Chennai',    dept:'IT',               vendor:'—',             notes:''},
  {csvId:'A-38',name:'Lenovo Ideapad',  type:'Laptop',serial:'PF34LNF2',     brand:'Lenovo / AMD R5', desc:'8GB RAM - 512GB SSD AMD R5',          status:'In-Use',    legacyAssignTo:'u37',location:'Chennai',    dept:'Accounts',         vendor:'—',             notes:''},
  {csvId:'A-39',name:'Macbook Air 13',  type:'Laptop',serial:'SCPF9R49RXV',  brand:'Apple / M4',      desc:'24GB RAM - 512GB SSD M4',             status:'In-Use',    legacyAssignTo:'u38',location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-40',name:'Macbook Pro 16',  type:'Laptop',serial:'SJYCRWJQ9DW',  brand:'Apple / M4 Pro',  desc:'24GB RAM - 512GB SSD M4 Pro',         status:'In-Use',    legacyAssignTo:'u36',location:'Chennai',    dept:'Engineering',      vendor:'Sniper Systems',notes:''},
  {csvId:'A-41',name:'Macbook Pro 14',  type:'Laptop',serial:'J73DKJ34PP',   brand:'Apple / M4 Pro',  desc:'24GB RAM - 512GB SSD M4 Pro',         status:'In-Use',    legacyAssignTo:'u39',location:'Chennai',    dept:'Engineering',      vendor:'Apple',         notes:''},
  {csvId:'A-42',name:'Macbook Pro 15',  type:'Laptop',serial:'J6R7D6Y6LF',   brand:'Apple / M4 Pro',  desc:'24GB RAM - 512GB SSD M4 Pro',         status:'In-Use',    legacyAssignTo:'u40',location:'Chennai',    dept:'Engineering',      vendor:'—',             notes:''},
];

const roleMap = {
  Editor: 'Staff',
  Viewer: 'Staff',
  Admin: 'Admin',
  Manager: 'Manager',
  Staff: 'Staff',
};
const locationMap = {
  Remote: 'USA',
  Chennai: 'India',
  Coimbatore: 'India',
  India: 'India',
  USA: 'USA',
  Canada: 'Canada',
};
const normalizeLocation = (value, fallback = 'India') => locationMap[value] || fallback;
const normalizeUser = (user) => ({
  ...user,
  joined: new Date(user.joined),
  role: roleMap[user.role] || 'Staff',
  location: normalizeLocation(user.location, 'India'),
});

async function seedDestructive() {
  console.log('🗑️   Clearing users…');
  await User.deleteMany({});

  console.log('👤  Inserting 93 users…');
  const insertedUsers = await User.insertMany(USERS_RAW.map(normalizeUser));

  const userMap = {};
  insertedUsers.forEach((user) => {
    userMap[user.legacyId] = user._id;
  });

  console.log('🗑️   Clearing assets…');
  await Asset.deleteMany({});

  console.log('💻  Inserting 42 assets…');
  await Asset.insertMany(
    ASSETS_RAW.map(({ legacyAssignTo, ...asset }) => ({
      ...asset,
      location: normalizeLocation(asset.location, 'India'),
      assignedTo: legacyAssignTo ? (userMap[legacyAssignTo] ?? null) : null,
    }))
  );
}

async function seedSafe() {
  console.log('🛡️   Safe seed mode (no deletes).');
  console.log('👤  Upserting users…');

  const rawEmails = USERS_RAW.map((user) => String(user.email || '').toLowerCase().trim());
  const rawLegacyIds = USERS_RAW.map((user) => user.legacyId).filter(Boolean);
  const existingUsers = await User.find({
    $or: [
      { email: { $in: rawEmails } },
      { legacyId: { $in: rawLegacyIds } },
    ],
  }).select('_id email legacyId').lean();

  const byEmail = new Map();
  const byLegacyId = new Map();
  existingUsers.forEach((user) => {
    if (user.email) byEmail.set(user.email, user);
    if (user.legacyId) byLegacyId.set(user.legacyId, user);
  });

  let updatedUsers = 0;
  let insertedUsers = 0;
  let skippedUsers = 0;
  const userOps = [];

  for (const rawUser of USERS_RAW) {
    const normalizedUser = normalizeUser(rawUser);
    const email = String(normalizedUser.email || '').toLowerCase().trim();
    const matchByLegacy = normalizedUser.legacyId ? byLegacyId.get(normalizedUser.legacyId) : null;
    const matchByEmail = byEmail.get(email);

    if (matchByLegacy && matchByEmail && String(matchByLegacy._id) !== String(matchByEmail._id)) {
      skippedUsers += 1;
      console.warn(
        `⚠️  Skipping conflicting user mapping for legacyId=${normalizedUser.legacyId}, email=${email}`
      );
      continue;
    }

    const matchedUser = matchByLegacy || matchByEmail;
    if (matchedUser) {
      userOps.push({
        updateOne: {
          filter: { _id: matchedUser._id },
          update: { $set: normalizedUser },
        },
      });
      updatedUsers += 1;
    } else {
      userOps.push({
        insertOne: {
          document: normalizedUser,
        },
      });
      insertedUsers += 1;
    }
  }

  if (userOps.length) await User.bulkWrite(userOps, { ordered: false });
  console.log(`   Users updated: ${updatedUsers}, inserted: ${insertedUsers}, skipped: ${skippedUsers}`);

  const seededUsers = await User.find({
    legacyId: { $in: rawLegacyIds },
  }).select('_id legacyId email').lean();

  const userMap = {};
  seededUsers.forEach((user) => {
    if (user.legacyId) userMap[user.legacyId] = user._id;
  });

  console.log('💻  Upserting assets…');
  let updatedAssets = 0;
  let insertedAssets = 0;
  const assetOps = ASSETS_RAW.map(({ legacyAssignTo, ...asset }) => ({
    updateOne: {
      filter: { csvId: asset.csvId },
      update: {
        $set: {
          ...asset,
          location: normalizeLocation(asset.location, 'India'),
          assignedTo: legacyAssignTo ? (userMap[legacyAssignTo] ?? null) : null,
        },
      },
      upsert: true,
    },
  }));
  if (assetOps.length) {
    const assetResult = await Asset.bulkWrite(assetOps, { ordered: false });
    updatedAssets = assetResult.modifiedCount || 0;
    insertedAssets = assetResult.upsertedCount || 0;
  }
  console.log(`   Assets updated: ${updatedAssets}, inserted: ${insertedAssets}`);
}

// ─── 3. MAIN ───────────────────────────────────────────────────────────────────
async function seed() {
  await connect();
  if (SAFE_MODE) {
    await seedSafe();
  } else {
    await seedDestructive();
  }

  // --- Summary ---
  const totalUsers  = await User.countDocuments();
  const totalAssets = await Asset.countDocuments();
  const inUse       = await Asset.countDocuments({ status: 'In-Use' });
  const available   = await Asset.countDocuments({ status: 'Available' });

  // --- Software (optional force-resync) ---
  if (FORCE_SOFTWARE) {
    console.log('🔄  Force-syncing software catalogue…');
    await seedSoftware(true);
  }

  console.log(`\n✅  Seed complete (${SAFE_MODE ? 'safe mode' : 'destructive mode'})`);
  console.log(`   Users  : ${totalUsers}`);
  console.log(`   Assets : ${totalAssets}  (In-Use: ${inUse}, Available: ${available})`);
  if (FORCE_SOFTWARE) console.log('   Software: synced from seed file');

  await disconnect();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
