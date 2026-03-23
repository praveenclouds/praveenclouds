const { SupportMailTemplate } = require('../db');
const { DEFAULT_SUPPORT_MAIL_TEMPLATES } = require('../db/models/SupportMailTemplate');

let ensured = false;

async function ensureSupportMailTemplates() {
  if (ensured) return;

  const existing = await SupportMailTemplate.find().select('key').lean();
  const existingKeys = new Set((existing || []).map(item => item.key));
  const missing = DEFAULT_SUPPORT_MAIL_TEMPLATES.filter(template => !existingKeys.has(template.key));
  if (missing.length) {
    await SupportMailTemplate.insertMany(missing);
  }
  ensured = true;
}

function defaultTemplateByKey(key) {
  return DEFAULT_SUPPORT_MAIL_TEMPLATES.find(template => template.key === key) || null;
}

function interpolateTemplate(value, context = {}) {
  return String(value || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, token) => (
    Object.prototype.hasOwnProperty.call(context, token) ? String(context[token] ?? '') : ''
  ));
}

async function listSupportMailTemplates() {
  await ensureSupportMailTemplates();
  return SupportMailTemplate.find().sort({ sortOrder: 1, key: 1 }).lean();
}

async function getSupportMailTemplateByKey(key) {
  await ensureSupportMailTemplates();
  return SupportMailTemplate.findOne({ key }).lean();
}

async function updateSupportMailTemplate(id, input = {}) {
  await ensureSupportMailTemplates();
  const template = await SupportMailTemplate.findById(id);
  if (!template) throw new Error('Mail template not found.');

  const next = {
    subjectTemplate: String(input.subjectTemplate || '').trim(),
    introTemplate: String(input.introTemplate || '').trim(),
    bodyTemplate: String(input.bodyTemplate || '').trim(),
    ctaLabel: String(input.ctaLabel || '').trim(),
    secondaryCtaLabel: String(input.secondaryCtaLabel || '').trim(),
    footerNote: String(input.footerNote || '').trim(),
  };

  if (!next.subjectTemplate) throw new Error('Subject template is required.');
  if (!next.bodyTemplate) throw new Error('Body template is required.');

  Object.assign(template, next);
  await template.save();
  return template.toObject();
}

async function renderSupportMailTemplate(key, context = {}) {
  const template = await getSupportMailTemplateByKey(key) || defaultTemplateByKey(key);
  if (!template) {
    throw new Error(`Mail template "${key}" not found.`);
  }

  return {
    ...template,
    subject: interpolateTemplate(template.subjectTemplate, context).trim(),
    intro: interpolateTemplate(template.introTemplate, context).trim(),
    body: interpolateTemplate(template.bodyTemplate, context).trim(),
    ctaLabel: interpolateTemplate(template.ctaLabel, context).trim(),
    secondaryCtaLabel: interpolateTemplate(template.secondaryCtaLabel, context).trim(),
    footerNote: interpolateTemplate(template.footerNote, context).trim(),
  };
}

module.exports = {
  DEFAULT_SUPPORT_MAIL_TEMPLATES,
  ensureSupportMailTemplates,
  getSupportMailTemplateByKey,
  interpolateTemplate,
  listSupportMailTemplates,
  renderSupportMailTemplate,
  updateSupportMailTemplate,
};
