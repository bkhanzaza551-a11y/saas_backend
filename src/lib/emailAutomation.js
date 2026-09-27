import { prisma } from "./prisma.js";
import { attemptCustomerTemplateEmail } from "./emailNotifications.js";
import { sendMail } from "./mailer.js";
import { sendSms } from "./smsService.js";
import { sendWhatsApp } from "./whatsappService.js";
import { buildWhatsAppLink, getCampaignAudience, renderTemplateText, resolveTemplateContext } from "./phase3.js";
import { createAuditLog, createStaffNotification, createCustomerNotification } from "./phase4.js";

const DEFAULT_SCHEDULER_INTERVAL_MS = Number(process.env.EMAIL_SCHEDULER_INTERVAL_MS || 60_000);
const DEFAULT_REMINDER_LOOKAHEAD_MS = 8 * 24 * 60 * 60 * 1000;
const FEEDBACK_APPOINTMENT_ACTION = "AUTO_FEEDBACK_REQUEST_SENT";
const FEEDBACK_INVOICE_ACTION = "AUTO_FEEDBACK_REQUEST_SENT";
const REMINDER_ACTION = "REMINDER_EMAIL_SENT";

const toPlainObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getSalonAutomationSettings = async (salonId, branchId = null) => {
  const [branchSetting, globalSetting] = await Promise.all([
    branchId
      ? prisma.salonSetting.findFirst({
          where: { salonId, branchId }
        })
      : Promise.resolve(null),
    prisma.salonSetting.findFirst({
      where: { salonId, branchId: null }
    })
  ]);

  const effective = branchSetting || globalSetting || null;
  const advancedSettings = toPlainObject(effective?.advancedSettings);
  const genericSettings = toPlainObject(advancedSettings.genericSettings);
  const notificationSettings = toPlainObject(advancedSettings.notificationSettings);

  return {
    row: effective,
    advancedSettings,
    genericSettings,
    notificationSettings
  };
};

/**
 * Central gate: returns true if a named notification toggle is ON (or not explicitly set to false).
 * Also checks the top-level emailEnabled flag for email-type toggles.
 * toggleKey matches the keys in advancedSettings.notificationSettings.toggles.
 */
export const getNotificationToggles = async (salonId, branchId = null) => {
  const settings = await getSalonAutomationSettings(salonId, branchId);
  const toggles = toPlainObject(settings.notificationSettings.toggles);
  const emailEnabled = settings.notificationSettings.emailEnabled !== false;
  const smsEnabled = settings.notificationSettings.smsEnabled !== false;
  const whatsappEnabled = settings.notificationSettings.whatsappEnabled !== false;
  const pushEnabled = settings.notificationSettings.pushEnabled === true;

  /**
   * isOn(key) — returns true if toggle key is ON (default ON if not set).
   */
  const isOn = (key) => toggles[key] !== false;

  return { isOn, emailEnabled, smsEnabled, whatsappEnabled, pushEnabled, toggles };
};

const isEmailAutomationEnabled = (settings) => settings.notificationSettings.emailEnabled !== false;

const isReminderAutomationEnabled = (settings) =>
  isEmailAutomationEnabled(settings) &&
  settings.genericSettings.appointmentBookingEnabled !== false &&
  // respect reminder toggles (default: ON if not set)
  settings.notificationSettings.toggles?.appointmentReminderBeforeDays !== false &&
  settings.notificationSettings.toggles?.appointmentReminderBeforeHours !== false &&
  settings.notificationSettings.toggles?.messageForAppointments !== false &&
  settings.notificationSettings.toggles?.smsForServiceReminder !== false;

const getReminderWindowMs = (settings) => {
  const days = Math.max(0, toNumber(settings.genericSettings.appointmentReminderDays, 1));
  const hours = Math.max(0, toNumber(settings.genericSettings.appointmentReminderHours, 1));
  return (days * 24 + hours) * 60 * 60 * 1000;
};

const alreadySentAppointmentLog = async (appointmentId, action, marker) =>
  prisma.appointmentLog.findFirst({
    where: {
      appointmentId,
      action,
      ...(marker
        ? {
            details: {
              contains: marker
            }
          }
        : {})
    }
  });

const createReminderLog = async (appointmentId, details) =>
  prisma.appointmentLog.create({
    data: {
      appointmentId,
      action: REMINDER_ACTION,
      details
    }
  });

const createFeedbackAudit = async ({
  salonId,
  actorUserId = null,
  actorMembershipId = null,
  entityType,
  entityId,
  summary,
  metadata
}) =>
  createAuditLog({
    salonId,
    actorUserId,
    actorMembershipId,
    module: "FEEDBACK",
    action: entityType === "Appointment" ? FEEDBACK_APPOINTMENT_ACTION : FEEDBACK_INVOICE_ACTION,
    entityType,
    entityId,
    summary,
    metadata
  });

const feedbackAuditExists = async ({ salonId, entityType, entityId }) =>
  prisma.auditLog.findFirst({
    where: {
      salonId,
      module: "FEEDBACK",
      action: entityType === "Appointment" ? FEEDBACK_APPOINTMENT_ACTION : FEEDBACK_INVOICE_ACTION,
      entityType,
      entityId
    }
  });

export const maybeSendFeedbackRequestForAppointment = async ({
  salonId,
  appointmentId,
  actorUserId = null,
  actorMembershipId = null
}) => {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, salonId },
    include: {
      customer: true
    }
  });
  if (!appointment?.customer?.email) {
    return { skipped: true, reason: "missing-recipient" };
  }
  if (String(appointment.status || "").toUpperCase() !== "COMPLETED") {
    return { skipped: true, reason: "appointment-not-completed" };
  }

  const alreadySent = await feedbackAuditExists({
    salonId,
    entityType: "Appointment",
    entityId: appointment.id
  });
  if (alreadySent) {
    return { skipped: true, reason: "already-sent" };
  }

  const delivery = await attemptCustomerTemplateEmail({
    salonId,
    toEmail: appointment.customer.email,
    templateType: "feedback_request_template",
    context: {
      appointmentId: appointment.id,
      customerId: appointment.customerId
    }
  });

  if (!delivery.skipped) {
    await createFeedbackAudit({
      salonId,
      actorUserId,
      actorMembershipId,
      entityType: "Appointment",
      entityId: appointment.id,
      summary: "Automatic feedback request email sent after appointment completion",
      metadata: {
        customerId: appointment.customerId,
        templateType: "feedback_request_template"
      }
    });
  }

  return delivery;
};

export const maybeSendFeedbackRequestForInvoice = async ({
  salonId,
  invoiceId,
  actorUserId = null,
  actorMembershipId = null
}) => {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, salonId },
    include: {
      customer: true,
      appointment: true
    }
  });
  if (!invoice?.customer?.email) {
    return { skipped: true, reason: "missing-recipient" };
  }
  if (String(invoice.status || "").toUpperCase() !== "PAID") {
    return { skipped: true, reason: "invoice-not-paid" };
  }
  if (invoice.appointmentId) {
    const appointmentFeedbackSent = await feedbackAuditExists({
      salonId,
      entityType: "Appointment",
      entityId: invoice.appointmentId
    });
    if (appointmentFeedbackSent) {
      return { skipped: true, reason: "appointment-feedback-already-sent" };
    }
  }

  const alreadySent = await feedbackAuditExists({
    salonId,
    entityType: "Invoice",
    entityId: invoice.id
  });
  if (alreadySent) {
    return { skipped: true, reason: "already-sent" };
  }

  const delivery = await attemptCustomerTemplateEmail({
    salonId,
    toEmail: invoice.customer.email,
    templateType: "feedback_request_template",
    context: {
      invoiceId: invoice.id,
      customerId: invoice.customerId
    }
  });

  if (!delivery.skipped) {
    await createFeedbackAudit({
      salonId,
      actorUserId,
      actorMembershipId,
      entityType: "Invoice",
      entityId: invoice.id,
      summary: "Automatic feedback request email sent after invoice payment",
      metadata: {
        customerId: invoice.customerId,
        templateType: "feedback_request_template"
      }
    });
  }

  return delivery;
};

const sendCampaignEmail = async ({ salonId, campaign, customer }) => {
  if (!customer?.email) {
    return { skipped: true, reason: "missing-email" };
  }
  const variables = await resolveTemplateContext(salonId, {
    customerId: customer.id
  });
  const renderedBody = renderTemplateText(campaign.message || "", variables);
  return sendMail({
    to: customer.email,
    subject: campaign.name || "Salon Campaign",
    html: `<div>${renderedBody}</div>`,
    text: renderedBody
  });
};

export const CAMPAIGN_DISPATCHABLE_TYPES = ["EMAIL", "WHATSAPP", "SMS"];

/**
 * Reads the optional Meta WhatsApp template wiring stored on the campaign.
 * Expected location: audienceMeta.whatsapp = { templateName, paramVars: [...] }
 * with a fallback to the wizard draft state at audienceMeta.draftState.templateId.
 */
const getCampaignWhatsAppTemplateConfig = (campaign) => {
  const meta = toPlainObject(campaign.audienceMeta);
  const draft = toPlainObject(meta.draftState);
  const config = toPlainObject(meta.whatsapp);

  const templateName = config.templateName || config.templateId || meta.templateName || draft.templateId || null;
  const paramVars = Array.isArray(config.paramVars)
    ? config.paramVars
    : (Array.isArray(meta.paramVars) ? meta.paramVars : null);

  return { templateName: templateName || null, paramVars };
};

const sendCampaignWhatsApp = async ({ salonId, campaign, customer }) => {
  const variables = await resolveTemplateContext(salonId, { customerId: customer.id });
  const { templateName, paramVars } = getCampaignWhatsAppTemplateConfig(campaign);

  // A Meta template is only usable when we know the ordered parameter list.
  // Sending a template with placeholders but no params is rejected by Meta, so
  // in that case fall back to rendered free text.
  const useTemplate = Boolean(templateName) && Array.isArray(paramVars) && paramVars.length > 0;

  // templateParams is an ordered array — its position defines {{1}}, {{2}}, ...
  const templateParams = useTemplate
    ? paramVars.map((key) => renderTemplateText(`{{${key}}}`, variables))
    : [];

  const renderedBody = renderTemplateText(campaign.message || "", variables, {
    numberedVariables: templateParams.length ? templateParams : null
  });

  const result = await sendWhatsApp({
    salonId,
    to: customer.phone,
    message: renderedBody,
    customerId: customer.id,
    campaignId: campaign.id,
    templateName: useTemplate ? templateName : undefined,
    templateParams: useTemplate ? templateParams : undefined,
    imageUrl: campaign.bannerUrl || undefined
  });

  await prisma.whatsAppLog.create({
    data: {
      salonId,
      customerId: customer.id,
      campaignId: campaign.id,
      phone: customer.phone,
      templateType: useTemplate ? templateName : "campaign_free_text",
      message: renderedBody,
      status: result.success ? "SENT" : "FAILED",
      metadata: {
        channel: "WHATSAPP",
        messageId: result.messageId || null,
        error: result.error || null,
        templateName: useTemplate ? templateName : null
      }
    }
  }).catch(() => {});

  return { ...result, renderedBody, templateName: useTemplate ? templateName : null };
};

const sendCampaignSms = async ({ salonId, campaign, customer }) => {
  const variables = await resolveTemplateContext(salonId, { customerId: customer.id });
  const renderedBody = renderTemplateText(campaign.message || "", variables);
  const result = await sendSms({ salonId, to: customer.phone, message: renderedBody });
  return { ...result, renderedBody };
};

/**
 * Deducts message credits from salon advancedSettings. Credits are clamped at 0
 * and never block a send — this only makes usage match the balance shown in the UI.
 */
const deductCampaignCredits = async (salonId, creditKey, count) => {
  if (!count || count <= 0) return 0;
  try {
    const setting = await prisma.salonSetting.findFirst({ where: { salonId, branchId: null } });
    if (!setting) return 0;
    const advanced = toPlainObject(setting.advancedSettings);
    const next = Math.max(0, toNumber(advanced[creditKey], 0) - count);
    await prisma.salonSetting.update({
      where: { id: setting.id },
      data: { advancedSettings: { ...advanced, [creditKey]: next } }
    });
    return count;
  } catch (err) {
    console.error(`[campaigns] Failed to deduct ${creditKey}: ${err.message}`);
    return 0;
  }
};

export const dispatchCampaign = async ({
  salonId,
  campaignId,
  actorUserId = null,
  actorMembershipId = null
}) => {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, salonId }
  });
  if (!campaign) {
    const error = new Error("Campaign not found");
    error.status = 404;
    throw error;
  }

  const audience = await getCampaignAudience(salonId, campaign.audienceFilter, campaign.audienceMeta || {});
  const reachable = [];
  const skipped = [];

  for (const customer of audience) {
    if (campaign.type === "EMAIL") {
      if (customer.email) reachable.push(customer);
      else skipped.push({ id: customer.id, name: customer.name, reason: "Missing email address" });
      continue;
    }

    if (customer.phone) reachable.push(customer);
    else skipped.push({ id: customer.id, name: customer.name, reason: "Missing phone number" });
  }

  const deliveries = [];
  const whatsappLink = null;
  const channel = campaign.type;

  if (channel === "EMAIL") {
    const results = await Promise.allSettled(
      reachable.map((customer) => sendCampaignEmail({ salonId, campaign, customer }))
    );
    results.forEach((result, index) => {
      const customer = reachable[index];
      if (result.status === "fulfilled") {
        deliveries.push({
          customerId: customer.id,
          customerName: customer.name,
          channel: "EMAIL",
          success: true
        });
      } else {
        deliveries.push({
          customerId: customer.id,
          customerName: customer.name,
          channel: "EMAIL",
          success: false,
          error: result.reason?.message || "Email delivery failed"
        });
      }
    });
  } else if (channel === "WHATSAPP") {
    for (const customer of reachable) {
      try {
        const result = await sendCampaignWhatsApp({ salonId, campaign, customer });
        deliveries.push({
          customerId: customer.id,
          customerName: customer.name,
          channel: "WHATSAPP",
          success: Boolean(result.success),
          error: result.error || null
        });
      } catch (err) {
        deliveries.push({
          customerId: customer.id,
          customerName: customer.name,
          channel: "WHATSAPP",
          success: false,
          error: err.message
        });
      }
    }
  } else if (channel === "SMS") {
    for (const customer of reachable) {
      try {
        const result = await sendCampaignSms({ salonId, campaign, customer });
        deliveries.push({
          customerId: customer.id,
          customerName: customer.name,
          channel: "SMS",
          success: Boolean(result.success),
          error: result.error || null
        });
      } catch (err) {
        deliveries.push({
          customerId: customer.id,
          customerName: customer.name,
          channel: "SMS",
          success: false,
          error: err.message
        });
      }
    }
  } else {
    const error = new Error(
      `Campaign type ${channel} cannot be dispatched. Supported types: ${CAMPAIGN_DISPATCHABLE_TYPES.join(", ")}.`
    );
    error.status = 400;
    throw error;
  }

  const sentCount = deliveries.filter((entry) => entry.success).length;
  const failedCount = deliveries.filter((entry) => !entry.success).length;

  // CampaignStatus only allows DRAFT | SCHEDULED | SENT | CANCELLED.
  // Writing PARTIAL/FAILED here would violate the enum and throw on update,
  // so the precise outcome is recorded in the log and audit metadata instead.
  const status = "SENT";

  const creditsDeducted = await deductCampaignCredits(
    salonId,
    channel === "WHATSAPP" ? "whatsappCredits" : channel === "SMS" ? "smsCredits" : "whatsappCredits",
    channel === "EMAIL" ? 0 : sentCount
  );

  const updatedCampaign = await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      status,
      sentAt: new Date()
    }
  });

  await prisma.campaignLog.create({
    data: {
      campaignId: campaign.id,
      eventType: `${channel}_DISPATCHED`,
      details: `Audience matched ${audience.length}, reachable ${reachable.length}, sent ${sentCount}, failed ${failedCount}, skipped ${skipped.length}`
    }
  });

  await createAuditLog({
    salonId,
    actorUserId,
    actorMembershipId,
    module: "CAMPAIGNS",
    action: `${channel}_SENT`,
    entityType: "Campaign",
    entityId: campaign.id,
    summary: `Campaign ${campaign.name} processed`,
    metadata: {
      type: campaign.type,
      audienceCount: audience.length,
      reachableCount: reachable.length,
      sentCount,
      failedCount,
      skippedCount: skipped.length,
      creditsDeducted
    }
  });

  return {
    campaign: updatedCampaign,
    audienceCount: audience.length,
    reachableCount: reachable.length,
    sentCount,
    failedCount,
    skippedCount: skipped.length,
    skippedPreview: skipped.slice(0, 20),
    deliveryPreview: deliveries.slice(0, 20),
    whatsappLink
  };
};

export const processScheduledCampaigns = async () => {
  const dueCampaigns = await prisma.campaign.findMany({
    where: {
      status: "SCHEDULED",
      scheduledFor: {
        lte: new Date()
      }
    },
    orderBy: { scheduledFor: "asc" }
  });

  const results = [];
  for (const campaign of dueCampaigns) {
    try {
      results.push(await dispatchCampaign({ salonId: campaign.salonId, campaignId: campaign.id }));
    } catch (error) {
      await prisma.campaignLog.create({
        data: {
          campaignId: campaign.id,
          eventType: "SCHEDULE_FAILED",
          details: error.message || "Scheduled campaign dispatch failed"
        }
      });
    }
  }
  return results;
};

export const processAppointmentReminderEmails = async () => {
  const now = new Date();
  const upperBound = new Date(now.getTime() + DEFAULT_REMINDER_LOOKAHEAD_MS);
  const appointments = await prisma.appointment.findMany({
    where: {
      status: {
        in: ["PENDING", "CONFIRMED"]
      },
      startAt: {
        gte: now,
        lte: upperBound
      }
    },
    include: {
      customer: true
    },
    orderBy: { startAt: "asc" }
  });

  const results = [];

  for (const appointment of appointments) {
    if (!appointment.customer?.email) continue;
    const settings = await getSalonAutomationSettings(appointment.salonId, appointment.branchId);
    if (!isReminderAutomationEnabled(settings)) continue;

    const reminderWindowMs = getReminderWindowMs(settings);
    const msUntilStart = new Date(appointment.startAt).getTime() - now.getTime();
    if (msUntilStart < 0 || msUntilStart > reminderWindowMs) continue;

    const reminderMarker = `reminder-window:${reminderWindowMs}`;
    const alreadySent = await alreadySentAppointmentLog(appointment.id, REMINDER_ACTION, reminderMarker);
    if (alreadySent) continue;

    const delivery = await attemptCustomerTemplateEmail({
      salonId: appointment.salonId,
      toEmail: appointment.customer.email,
      templateType: "appointment_reminder",
      context: {
        appointmentId: appointment.id,
        customerId: appointment.customerId
      }
    });

    if (!delivery.skipped) {
      await createReminderLog(
        appointment.id,
        `${reminderMarker}; sent-at:${new Date().toISOString()}`
      );
      results.push({ appointmentId: appointment.id, sent: true });
    }
  }

  return results;
};


// ─── Lifecycle notification processor ────────────────────────────────────────
// Runs once per scheduler tick and dispatches birthday, anniversary, loyalty,
// membership, package, and gift card expiry notifications.

export const processLifecycleNotifications = async () => {
  const now = new Date();
  const todayStr = `${now.getMonth() + 1}-${now.getDate()}`; // MM-DD for birthday/anniversary match
  const results = { birthday: 0, anniversary: 0, loyaltyExpiry: 0, membershipExpiry: 0, packageExpiry: 0, giftCardExpiry: 0 };

  // Get all distinct salonIds that have settings
  const salonIds = await prisma.salonSetting.findMany({
    where: { branchId: null },
    select: { salonId: true }
  }).then((rows) => rows.map((r) => r.salonId));

  for (const salonId of salonIds) {
    const { isOn, emailEnabled, smsEnabled } = await getNotificationToggles(salonId).catch(() => ({ isOn: () => false, emailEnabled: false, smsEnabled: false }));

    // ── Birthday Offer ────────────────────────────────────────────────────────
    if (isOn("birthdayOffer") && (emailEnabled || smsEnabled)) {
      const birthdayCustomers = await prisma.customer.findMany({
        where: { salonId, dateOfBirth: { not: null } }
      });
      for (const customer of birthdayCustomers) {
        const bday = new Date(customer.dateOfBirth);
        const bdayStr = `${bday.getMonth() + 1}-${bday.getDate()}`;
        if (bdayStr !== todayStr) continue;
        const alreadySent = await prisma.auditLog.findFirst({
          where: { salonId, module: "LIFECYCLE", action: "BIRTHDAY_EMAIL_SENT", entityId: customer.id,
            createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) } }
        });
        if (alreadySent) continue;
        if (emailEnabled && customer.email) {
          await attemptCustomerTemplateEmail({ salonId, toEmail: customer.email, templateType: "birthday_offer_template", context: { customerId: customer.id } }).catch(() => {});
        }
        if (smsEnabled && customer.phone) {
          await sendSms({ salonId, to: customer.phone, message: `Happy Birthday ${customer.name}! Wishing you a wonderful birthday! Visit us for a special offer.` }).catch(() => {});
        }
        await createCustomerNotification({ salonId, customerId: customer.id, title: "🎂 Happy Birthday!", message: "Wishing you a wonderful birthday! A special offer awaits you." }).catch(() => {});
        await createAuditLog({ salonId, module: "LIFECYCLE", action: "BIRTHDAY_EMAIL_SENT", entityType: "Customer", entityId: customer.id, summary: "Birthday offer email sent" }).catch(() => {});
        results.birthday++;
      }
    }

    // ── Anniversary Offer ─────────────────────────────────────────────────────
    if (isOn("anniversaryOffer") && (emailEnabled || smsEnabled)) {
      const anniversaryCustomers = await prisma.customer.findMany({
        where: { salonId, anniversary: { not: null } }
      });
      for (const customer of anniversaryCustomers) {
        const anniv = new Date(customer.anniversary);
        const anniversaryStr = `${anniv.getMonth() + 1}-${anniv.getDate()}`;
        if (anniversaryStr !== todayStr) continue;
        const alreadySent = await prisma.auditLog.findFirst({
          where: { salonId, module: "LIFECYCLE", action: "ANNIVERSARY_EMAIL_SENT", entityId: customer.id,
            createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) } }
        });
        if (alreadySent) continue;
        if (emailEnabled && customer.email) {
          await attemptCustomerTemplateEmail({ salonId, toEmail: customer.email, templateType: "anniversary_offer_template", context: { customerId: customer.id } }).catch(() => {});
        }
        if (smsEnabled && customer.phone) {
          await sendSms({ salonId, to: customer.phone, message: `Happy Anniversary ${customer.name}! Wishing you a beautiful anniversary! Enjoy a special offer today.` }).catch(() => {});
        }
        await createCustomerNotification({ salonId, customerId: customer.id, title: "💍 Happy Anniversary!", message: "Wishing you a beautiful anniversary! Enjoy a special offer today." }).catch(() => {});
        await createAuditLog({ salonId, module: "LIFECYCLE", action: "ANNIVERSARY_EMAIL_SENT", entityType: "Customer", entityId: customer.id, summary: "Anniversary offer email sent" }).catch(() => {});
        results.anniversary++;
      }
    }

    // ── Loyalty Expiry Reminder ───────────────────────────────────────────────
    if (isOn("loyaltyExpiryReminder") && (emailEnabled || smsEnabled)) {
      const expiringIn7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const expiringLoyalty = await prisma.loyaltyTransaction.findMany({
        where: { salonId, type: "EARN", expiresAt: { gte: now, lte: expiringIn7Days } },
        include: { customer: true }
      });
      for (const txn of expiringLoyalty) {
        const alreadySent = await prisma.auditLog.findFirst({
          where: { salonId, module: "LIFECYCLE", action: "LOYALTY_EXPIRY_SENT", entityId: txn.id,
            createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }
        });
        if (alreadySent) continue;
        if (emailEnabled && txn.customer?.email) {
          await attemptCustomerTemplateEmail({ salonId, toEmail: txn.customer.email, templateType: "loyalty_expiry_template", context: { customerId: txn.customerId } }).catch(() => {});
        }
        if (smsEnabled && txn.customer?.phone) {
          await sendSms({ salonId, to: txn.customer.phone, message: `Your loyalty points expire in 7 days. Redeem them now before they expire!` }).catch(() => {});
        }
        await createCustomerNotification({ salonId, customerId: txn.customerId, title: "⚠️ Loyalty Points Expiring", message: `Your loyalty points expire in 7 days. Redeem them now!` }).catch(() => {});
        await createAuditLog({ salonId, module: "LIFECYCLE", action: "LOYALTY_EXPIRY_SENT", entityType: "LoyaltyTransaction", entityId: txn.id, summary: "Loyalty expiry reminder sent" }).catch(() => {});
        results.loyaltyExpiry++;
      }
    }

    // ── Membership Expiry & Renewal ───────────────────────────────────────────
    if (isOn("membershipExpiry") && (emailEnabled || smsEnabled)) {
      const expiringIn3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const expiringMemberships = await prisma.customerMembership.findMany({
        where: { salonId, status: "ACTIVE", endsAt: { gte: now, lte: expiringIn3Days } },
        include: { customer: true, membershipPlan: true }
      });
      for (const mem of expiringMemberships) {
        const alreadySent = await prisma.auditLog.findFirst({
          where: { salonId, module: "LIFECYCLE", action: "MEMBERSHIP_EXPIRY_SENT", entityId: mem.id,
            createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }
        });
        if (alreadySent) continue;
        if (emailEnabled && mem.customer?.email) {
          await attemptCustomerTemplateEmail({ salonId, toEmail: mem.customer.email, templateType: "membership_expiry_template", context: { customerId: mem.customerId, customerMembershipId: mem.id } }).catch(() => {});
        }
        if (smsEnabled && mem.customer?.phone) {
          await sendSms({ salonId, to: mem.customer.phone, message: `Your "${mem.membershipPlan?.name || 'membership'}" expires in 3 days. Renew now to continue enjoying benefits!` }).catch(() => {});
        }
        await createCustomerNotification({ salonId, customerId: mem.customerId, title: "⚠️ Membership Expiring Soon", message: `Your "${mem.membershipPlan?.name || 'membership'}" expires in 3 days. Renew now!` }).catch(() => {});
        await createAuditLog({ salonId, module: "LIFECYCLE", action: "MEMBERSHIP_EXPIRY_SENT", entityType: "CustomerMembership", entityId: mem.id, summary: "Membership expiry reminder sent" }).catch(() => {});
        results.membershipExpiry++;
      }
    }

    // ── Package Expiry Reminder ───────────────────────────────────────────────
    if (isOn("packageExpiryReminder") && (emailEnabled || smsEnabled)) {
      const expiringIn3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const expiringPackages = await prisma.customerPackage.findMany({
        where: { salonId, status: "ACTIVE", endsAt: { gte: now, lte: expiringIn3Days } },
        include: { customer: true, package: true }
      });
      for (const pkg of expiringPackages) {
        const alreadySent = await prisma.auditLog.findFirst({
          where: { salonId, module: "LIFECYCLE", action: "PACKAGE_EXPIRY_SENT", entityId: pkg.id,
            createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }
        });
        if (alreadySent) continue;
        if (emailEnabled && pkg.customer?.email) {
          await attemptCustomerTemplateEmail({ salonId, toEmail: pkg.customer.email, templateType: "package_expiry_template", context: { customerId: pkg.customerId, customerPackageId: pkg.id } }).catch(() => {});
        }
        if (smsEnabled && pkg.customer?.phone) {
          await sendSms({ salonId, to: pkg.customer.phone, message: `Your "${pkg.package?.name || 'package'}" expires in 3 days. Renew now to continue enjoying benefits!` }).catch(() => {});
        }
        await createCustomerNotification({ salonId, customerId: pkg.customerId, title: "⚠️ Package Expiring Soon", message: `Your "${pkg.package?.name || 'package'}" expires in 3 days.` }).catch(() => {});
        await createAuditLog({ salonId, module: "LIFECYCLE", action: "PACKAGE_EXPIRY_SENT", entityType: "CustomerPackage", entityId: pkg.id, summary: "Package expiry reminder sent" }).catch(() => {});
        results.packageExpiry++;
      }
    }

    // ── Gift Card Expiry Reminder ─────────────────────────────────────────────
    if (isOn("giftCardExpiryReminder") && (emailEnabled || smsEnabled)) {
      const expiringIn7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const expiringGiftCards = await prisma.giftCard.findMany({
        where: { salonId, isActive: true, expiresAt: { gte: now, lte: expiringIn7Days } },
        include: { issuedToCustomer: true }
      });
      for (const gc of expiringGiftCards) {
        const customer = gc.issuedToCustomer;
        const alreadySent = await prisma.auditLog.findFirst({
          where: { salonId, module: "LIFECYCLE", action: "GIFTCARD_EXPIRY_SENT", entityId: gc.id,
            createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }
        });
        if (alreadySent) continue;
        if (emailEnabled && customer?.email) {
          await attemptCustomerTemplateEmail({ salonId, toEmail: customer.email, templateType: "gift_card_expiry_template", context: { customerId: customer.id, giftCardId: gc.id } }).catch(() => {});
        }
        if (smsEnabled && customer?.phone) {
          await sendSms({ salonId, to: customer.phone, message: `Your gift card (${gc.code || gc.id}) expires in 7 days. Use it before it expires!` }).catch(() => {});
        }
        await createCustomerNotification({ salonId, customerId: customer.id, title: "🎁 Gift Card Expiring Soon", message: `Your gift card (${gc.code || gc.id}) expires in 7 days. Use it before it expires!` }).catch(() => {});
        await createAuditLog({ salonId, module: "LIFECYCLE", action: "GIFTCARD_EXPIRY_SENT", entityType: "GiftCard", entityId: gc.id, summary: "Gift card expiry reminder sent" }).catch(() => {});
        results.giftCardExpiry++;
      }
    }
  }

  return results;
};

// ─── Scheduled CRM follow-up email processor ────────────────────────────────
// Checks CustomerTimeline FOLLOW_UP entries where scheduledAt has passed
// and emailSent is false. Sends the user's message as email to the customer.

export const processScheduledFollowUps = async () => {
  const now = new Date();
  const timelines = await prisma.customerTimeline.findMany({
    where: {
      eventType: "FOLLOW_UP",
      details: { contains: "SCHEDULED" }
    },
    include: { customer: true }
  });

  const results = [];
  for (const entry of timelines) {
    try {
      const details = typeof entry.details === "string" ? JSON.parse(entry.details) : entry.details;
      if (!details || details.emailSent) continue;
      if (details.type !== "email") continue;
      if (!details.scheduledAt) continue;

      const scheduledTime = new Date(details.scheduledAt);
      if (scheduledTime > now) continue;

      const customer = entry.customer;
      if (!customer?.email) continue;

      const salonId = customer.salonId;
      const { emailEnabled = false } = await getNotificationToggles(salonId).catch(() => ({ emailEnabled: false }));
      if (!emailEnabled) continue;

      const messageContent = details.message || "Follow-up scheduled by our team.";
      const staffName = details.staffName || "our team";

      await sendMail({
        to: customer.email,
        subject: `Follow-Up from Skillify`,
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <p>Hi ${customer.name || "Customer"},</p>
          <p>${messageContent}</p>
          <p style="color: #64748b; font-size: 0.85rem;">— ${staffName}, Skillify</p>
        </div>`,
        text: `Hi ${customer.name || "Customer"},\n\n${messageContent}\n\n— ${staffName}, Skillify`
      }).catch(() => {});

      details.emailSent = true;
      await prisma.customerTimeline.update({
        where: { id: entry.id },
        data: { details: JSON.stringify(details) }
      });

      results.push({ timelineId: entry.id, customerId: customer.id, sent: true });
    } catch (err) {
      console.error("[emailAutomation] Follow-up email failed:", err.message);
    }
  }
  return results;
};

export const processServiceReminders = async () => {
  const now = new Date();
  
  // Get all distinct salonIds that have settings
  const salonIds = await prisma.salonSetting.findMany({
    where: { branchId: null },
    select: { salonId: true }
  }).then((rows) => rows.map((r) => r.salonId));

  const results = { serviceReminders: 0 };

  for (const salonId of salonIds) {
    const { emailEnabled } = await getNotificationToggles(salonId).catch(() => ({ emailEnabled: false }));
    if (!emailEnabled) continue;

    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    const appointmentServices = await prisma.appointmentService.findMany({
      where: {
        appointment: { salonId, status: "COMPLETED", startAt: { gte: oneYearAgo } },
        service: { serviceRemainderDays: { gt: 0 } }
      },
      include: {
        appointment: { include: { customer: true, salon: true } },
        service: true
      }
    });

    for (const item of appointmentServices) {
      if (!item.appointment.customer?.email) continue;
      
      const apptDate = new Date(item.appointment.startAt);
      const remainderDays = item.service.serviceRemainderDays;
      
      const dueDate = new Date(apptDate.getTime() + remainderDays * 24 * 60 * 60 * 1000);
      
      // If due date is exactly today
      if (
        dueDate.getFullYear() === now.getFullYear() &&
        dueDate.getMonth() === now.getMonth() &&
        dueDate.getDate() === now.getDate()
      ) {
        const alreadySent = await prisma.auditLog.findFirst({
          where: {
            salonId,
            module: "LIFECYCLE",
            action: "SERVICE_REMINDER_SENT",
            entityId: item.id // Tie to AppointmentService item to avoid duplicates per service taken
          }
        });
        
        if (alreadySent) continue;
        
        await attemptCustomerTemplateEmail({
          salonId,
          toEmail: item.appointment.customer.email,
          templateType: "service_reminder_template",
          context: {
            customerId: item.appointment.customerId,
            service_name: item.service.name,
            last_appointment_date: apptDate.toISOString().slice(0, 10),
            salon_name: item.appointment.salon.name
          }
        }).catch(() => {});
        
        await createCustomerNotification({
          salonId,
          customerId: item.appointment.customerId,
          title: "Service Reminder",
          message: `It's time for your next ${item.service.name}! Book an appointment today.`
        }).catch(() => {});
        
        await createAuditLog({
          salonId,
          module: "LIFECYCLE",
          action: "SERVICE_REMINDER_SENT",
          entityType: "AppointmentService",
          entityId: item.id,
          summary: `Service reminder sent for ${item.service.name}`
        }).catch(() => {});
        
        results.serviceReminders++;
      }
    }
  }
  return results;
};

let schedulerHandle = null;
let schedulerRunning = false;

import { sendDailyDigestsToAllOwners, sendWeeklyDigestsToAllOwners } from "./ownerDigestEmail.js";

let lastDailyDigestDate = "";
let lastWeeklyDigestDate = "";

const checkAndSendOwnerDigests = async () => {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const hour = now.getHours();

  // Trigger daily digest around 8 PM
  if (hour >= 20 && lastDailyDigestDate !== dateKey) {
    lastDailyDigestDate = dateKey;
    sendDailyDigestsToAllOwners().catch((err) => console.error("Daily owner digest failed:", err));
  }

  // Trigger weekly digest on Sunday evening around 8 PM
  if (now.getDay() === 0 && hour >= 20 && lastWeeklyDigestDate !== dateKey) {
    lastWeeklyDigestDate = dateKey;
    sendWeeklyDigestsToAllOwners().catch((err) => console.error("Weekly owner digest failed:", err));
  }
};

const runEmailAutomationPass = async () => {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    await processScheduledCampaigns();
    await processAppointmentReminderEmails();
    await processLifecycleNotifications();
    await processScheduledFollowUps();
    await processServiceReminders();
    await checkAndSendOwnerDigests();
  } catch (error) {
    console.error("Email automation pass failed", error);
  } finally {
    schedulerRunning = false;
  }
};

export const startEmailScheduler = () => {
  if (schedulerHandle) return schedulerHandle;
  schedulerHandle = setInterval(runEmailAutomationPass, DEFAULT_SCHEDULER_INTERVAL_MS);
  runEmailAutomationPass().catch((error) => {
    console.error("Initial email automation pass failed", error);
  });
  return schedulerHandle;
};
