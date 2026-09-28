/**
 * TEST EMAIL ENDPOINT
 * Send test emails via GET request
 * 
 * Usage:
 * GET /test-email/send?to=ahmedbilalkhangl09@gmail.com&salonId=xxx
 * GET /test-email/send (defaults to ahmedbilalkhangl09@gmail.com)
 */

import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { sendMail } from "../lib/mailer.js";
import { buildEmailHtml } from "../lib/emailNotifications.js";
import { renderTemplateText } from "../lib/phase3.js";

export const testEmailRouter = Router();

const getSalonName = async (salonId) => {
  if (salonId) {
    const salon = await prisma.salon.findUnique({ where: { id: salonId }, select: { name: true } });
    if (salon?.name) return salon.name;
  }
  const firstSalon = await prisma.salon.findFirst({ select: { name: true }, orderBy: { createdAt: "asc" } });
  return firstSalon?.name || "Skillify";
};

const CURRENCY_SYMBOLS = { INR: "₹", PKR: "{{currency_symbol}}", USD: "$", EUR: "€", GBP: "£", AED: "AED ", SAR: "SAR " };
const getSalonCurrency = async (salonId) => {
  let currency = "INR";
  if (salonId) {
    const salon = await prisma.salon.findUnique({ where: { id: salonId }, select: { currency: true } });
    if (salon?.currency) currency = salon.currency;
  } else {
    const first = await prisma.salon.findFirst({ select: { currency: true }, orderBy: { createdAt: "asc" } });
    if (first?.currency) currency = first.currency;
  }
  return CURRENCY_SYMBOLS[currency.toUpperCase()] || `${currency} `;
};

testEmailRouter.get("/send", async (req, res) => {
  try {
    const toEmail = req.query.to || "ahmedbilalkhangl09@gmail.com";
    const salonName = await getSalonName(req.query.salonId);

    console.log(`[TEST EMAIL] Sending to: ${toEmail} | Salon: ${salonName}`);

    const content = `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#22c55e,#16a34a); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#9989;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Email System Working!</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">All email notifications are operational</p>
<div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:24px; margin-bottom:24px; text-align:center;">
  <p style="color:#15803d; font-size:16px; font-weight:600; margin:0;">All features are working correctly. You will receive styled notification emails automatically.</p>
</div>`;
    const variables = { salon_name: salonName, customer_name: "there" };
    const renderedContent = renderTemplateText(content, variables);

    const mailOptions = {
      to: toEmail,
      subject: `[${salonName}] Email System Test`,
      html: buildEmailHtml(renderedContent, variables),
      text: `${salonName} Email System Test - Email delivery is working!`
    };

    const result = await sendMail(mailOptions);

    console.log(`[TEST EMAIL] Success:`, result);

    res.json({
      success: true,
      mode: result.mode,
      messageId: result.messageId,
      to: toEmail,
      message: `Test email sent successfully to ${toEmail}`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("[TEST EMAIL] Error:", error);
    res.status(500).json({
      success: false,
      error: error.message || String(error),
      code: error.code || null,
      timestamp: new Date().toISOString()
    });
  }
});

testEmailRouter.get("/send-all", async (req, res) => {
  try {
    const TO = req.query.to || "ahmedbilalkhangl09@gmail.com";

    const salonName = await getSalonName(req.query.salonId);
    const salonCurrency = await getSalonCurrency(req.query.salonId);
    const vars = { salon_name: salonName, customer_name: "there", currency_symbol: salonCurrency };

  const allTemplates = [
    {
      name: "1. Invoice Generated",
      title: "Invoice Generated",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#3b82f6,#2563eb); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128196;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Invoice Generated</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your invoice from <strong style="color:#0f172a;">{{salon_name}}</strong> is ready</p>
<div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Invoice Number</td><td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">INV-2026-001</td></tr>
    <tr><td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td></tr>
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Total Amount</td><td style="padding:8px 0; text-align:right; font-weight:700; color:#0f172a; font-size:18px;">{{currency_symbol}}2,500.00</td></tr>
  </table>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">If you have any questions regarding this invoice, please contact our front desk and we will be happy to assist you.</p>`
    },
    {
      name: "2. Invoice Refund",
      title: "Refund Processed",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#22c55e,#16a34a); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128176;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Refund Processed</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">A refund has been issued against your recent invoice</p>
<div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:20px; margin-bottom:24px; text-align:center;">
  <p style="color:#15803d; font-size:15px; margin:0; font-weight:600;">The refund amount should reflect in your account shortly, depending on your payment method.</p>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">For any queries regarding this refund, please reach out to our front desk and we will assist you promptly.</p>`
    },
    {
      name: "3. Invoice Cancelled",
      title: "Invoice Cancelled",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#ef4444,#dc2626); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#10060;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Invoice Cancelled</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your recent invoice at <strong style="color:#0f172a;">{{salon_name}}</strong> has been cancelled</p>
<div style="background:#fef2f2; border:1px solid #fecaca; border-radius:12px; padding:20px; margin-bottom:24px; text-align:center;">
  <p style="color:#dc2626; font-size:15px; margin:0; font-weight:600;">If you did not request this cancellation, please contact our front desk immediately.</p>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">We are here to help. Please reach out if you have any concerns.</p>`
    },
    {
      name: "4. Membership Welcome",
      title: "Welcome to your Membership",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#8b5cf6,#7c3aed); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#127942;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Welcome to your Membership</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your membership at <strong style="color:#0f172a;">{{salon_name}}</strong> is now active</p>
<div style="background:#faf5ff; border:1px solid #e9d5ff; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Status</td><td style="padding:8px 0; text-align:right;"><span style="background:#22c55e; color:#fff; padding:3px 12px; border-radius:20px; font-size:13px; font-weight:600;">ACTIVE</span></td></tr>
    <tr><td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td></tr>
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Valid Until</td><td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">August 6, 2027</td></tr>
  </table>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">You can now enjoy all your exclusive member benefits and perks. We look forward to serving you.</p>`
    },
    {
      name: "5. Package Purchase",
      title: "Your Package is Active",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#f59e0b,#d97706); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#127873;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Your Package is Active</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your package at <strong style="color:#0f172a;">{{salon_name}}</strong> is now active</p>
<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Status</td><td style="padding:8px 0; text-align:right;"><span style="background:#22c55e; color:#fff; padding:3px 12px; border-radius:20px; font-size:13px; font-weight:600;">ACTIVE</span></td></tr>
    <tr><td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td></tr>
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Sessions Available</td><td style="padding:8px 0; text-align:right; font-weight:700; color:#0f172a; font-size:18px;">10</td></tr>
  </table>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">We look forward to seeing you for your next session. Book your appointment at your convenience.</p>`
    },
    {
      name: "6. Payment Receipt",
      title: "Payment Received",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#22c55e,#16a34a); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#9989;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Payment Received</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Thank you for your payment at <strong style="color:#0f172a;">{{salon_name}}</strong></p>
<div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:24px; margin-bottom:24px; text-align:center;">
  <p style="color:#64748b; font-size:13px; text-transform:uppercase; letter-spacing:1px; margin:0 0 8px 0; font-weight:600;">Amount Paid</p>
  <p style="color:#15803d; font-size:32px; font-weight:800; margin:0;">{{currency_symbol}}2,500.00</p>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">This payment has been successfully recorded. Thank you for choosing <strong>{{salon_name}}</strong>.</p>`
    },
    {
      name: "7. Appointment Confirmed",
      title: "Appointment Confirmed",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#3b82f6,#2563eb); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128197;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Appointment Confirmed</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your appointment at <strong style="color:#0f172a;">{{salon_name}}</strong> has been confirmed</p>
<div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Status</td><td style="padding:8px 0; text-align:right;"><span style="background:#22c55e; color:#fff; padding:3px 12px; border-radius:20px; font-size:13px; font-weight:600;">CONFIRMED</span></td></tr>
    <tr><td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td></tr>
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Date & Time</td><td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">Thursday, August 06, 2026 at 10:00 AM</td></tr>
  </table>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">If you need to reschedule or cancel, please contact us at your earliest convenience.</p>`
    },
    {
      name: "8. Appointment Reminder",
      title: "Reminder: Upcoming Appointment",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#f59e0b,#d97706); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#9200;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Appointment Reminder</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">This is a friendly reminder about your upcoming appointment</p>
<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Salon</td><td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">{{salon_name}}</td></tr>
    <tr><td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td></tr>
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Date & Time</td><td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">Thursday, August 06, 2026 at 10:00 AM</td></tr>
  </table>
</div>
<div style="background:#f8fafc; border-radius:8px; padding:16px; margin-bottom:24px; text-align:center;">
  <p style="color:#64748b; font-size:14px; margin:0;">We look forward to seeing you. Please arrive a few minutes early for the best experience.</p>
</div>`
    },
    {
      name: "9. Appointment Cancelled",
      title: "Appointment Cancelled",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#ef4444,#dc2626); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128680;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Appointment Cancelled</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your appointment has been cancelled</p>
<div style="background:#fef2f2; border:1px solid #fecaca; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Salon</td><td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">{{salon_name}}</td></tr>
    <tr><td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td></tr>
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Scheduled For</td><td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">Thursday, August 06, 2026 at 10:00 AM</td></tr>
  </table>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">We hope to see you again soon. Feel free to book a new appointment at any time.</p>`
    },
    {
      name: "10. Order Confirmation",
      title: "Order Confirmed",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#3b82f6,#2563eb); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128230;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Order Confirmed</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Thank you for your order from <strong style="color:#0f172a;">{{salon_name}}</strong></p>
<div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Order Number</td><td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">ORD-2026-042</td></tr>
    <tr><td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td></tr>
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Total Amount</td><td style="padding:8px 0; text-align:right; font-weight:700; color:#0f172a; font-size:18px;">{{currency_symbol}}1,200.00</td></tr>
  </table>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">We are processing your order and will keep you updated on the status. Thank you for your patience.</p>`
    },
    {
      name: "11. Enquiry Follow Up",
      title: "Update on your Enquiry",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#3b82f6,#2563eb); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128172;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Update on your Enquiry</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Thank you for contacting <strong style="color:#0f172a;">{{salon_name}}</strong></p>
<div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:24px; margin-bottom:24px; text-align:center;">
  <p style="color:#334155; font-size:15px; line-height:1.7; margin:0;">Our team has reviewed your enquiry and has an update for you. We are working to ensure everything is resolved to your satisfaction.</p>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">We will stay in touch and keep you informed. If you have any additional questions, please do not hesitate to reach out.</p>`
    },
    {
      name: "12. Feedback Follow Up",
      title: "Update on your Feedback",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#8b5cf6,#7c3aed); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128172;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Update on your Feedback</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Thank you for sharing your feedback with <strong style="color:#0f172a;">{{salon_name}}</strong></p>
<div style="background:#faf5ff; border:1px solid #e9d5ff; border-radius:12px; padding:24px; margin-bottom:24px; text-align:center;">
  <p style="color:#334155; font-size:15px; line-height:1.7; margin:0;">We take your comments seriously. Our team has reviewed your feedback and has an update regarding your experience.</p>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Your satisfaction is our priority. We are committed to providing you with the best possible service.</p>`
    },
    {
      name: "13. Feedback Request",
      title: "How was your experience?",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#f59e0b,#d97706); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#11088;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">How was your experience?</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Thank you for visiting <strong style="color:#0f172a;">{{salon_name}}</strong></p>
<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:24px; margin-bottom:24px; text-align:center;">
  <p style="color:#334155; font-size:15px; line-height:1.7; margin:0;">We hope you had a wonderful experience. Your feedback helps us improve and serve you better.</p>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">We would love to hear your thoughts. Please take a moment to share your feedback at your convenience.</p>`
    },
    {
      name: "14. Birthday Offer",
      title: "Happy Birthday Ahmed!",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#ec4899,#db2777); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#127874;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Happy Birthday!</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Wishing you a wonderful birthday from all of us at <strong style="color:#0f172a;">{{salon_name}}</strong></p>
<div style="background:#fdf2f8; border:1px solid #fbcfe8; border-radius:12px; padding:24px; margin-bottom:24px; text-align:center;">
  <p style="color:#db2777; font-size:16px; font-weight:600; margin:0 0 8px 0;">A Special Birthday Treat Awaits You!</p>
  <p style="color:#64748b; font-size:14px; margin:0;">Visit us soon to claim your exclusive birthday offer. We look forward to making your day even more special.</p>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">From all of us at {{salon_name}}, we wish you a year filled with joy and happiness.</p>`
    },
    {
      name: "15. Anniversary Offer",
      title: "Happy Anniversary!",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#ec4899,#be185d); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128141;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Happy Anniversary!</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Celebrating with you from <strong style="color:#0f172a;">{{salon_name}}</strong></p>
<div style="background:#fdf2f8; border:1px solid #fbcfe8; border-radius:12px; padding:24px; margin-bottom:24px; text-align:center;">
  <p style="color:#be185d; font-size:16px; font-weight:600; margin:0 0 8px 0;">Exclusive Anniversary Offer</p>
  <p style="color:#64748b; font-size:14px; margin:0;">Celebrate with a special pampering session. We have an exclusive anniversary treat just for you.</p>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Visit us to enjoy your exclusive anniversary offer. Here's to many more beautiful moments ahead.</p>`
    },
    {
      name: "16. Loyalty Points Earned",
      title: "You earned 50 loyalty points!",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#f59e0b,#d97706); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#127942;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Loyalty Points Earned</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">You have earned points at <strong style="color:#0f172a;">{{salon_name}}</strong></p>
<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Points Earned</td><td style="padding:8px 0; text-align:right; font-weight:700; color:#d97706; font-size:18px;">+50</td></tr>
    <tr><td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td></tr>
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">New Balance</td><td style="padding:8px 0; text-align:right; font-weight:700; color:#0f172a; font-size:18px;">250 points</td></tr>
  </table>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Keep visiting to earn more points and unlock exciting rewards. Your loyalty means the world to us.</p>`
    },
    {
      name: "17. Loyalty Points Expiring",
      title: "Your loyalty points are expiring soon",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#ef4444,#dc2626); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#9200;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Points Expiring Soon</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your loyalty points at <strong style="color:#0f172a;">{{salon_name}}</strong> are about to expire</p>
<div style="background:#fef2f2; border:1px solid #fecaca; border-radius:12px; padding:24px; margin-bottom:24px; text-align:center;">
  <p style="color:#dc2626; font-size:16px; font-weight:600; margin:0 0 8px 0;">Don't let your points go to waste!</p>
  <p style="color:#64748b; font-size:14px; margin:0;">Book your next visit today and redeem your points before they expire.</p>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Contact us to book an appointment and make the most of your loyalty rewards.</p>`
    },
    {
      name: "18. Membership Expiring",
      title: "Your membership is expiring soon",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#f59e0b,#d97706); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128197;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Membership Expiring Soon</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your membership at <strong style="color:#0f172a;">{{salon_name}}</strong> is nearing its end</p>
<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Expiry Date</td><td style="padding:8px 0; text-align:right; font-weight:700; color:#d97706; font-size:16px;">August 6, 2026</td></tr>
  </table>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Renew your membership now to continue enjoying your exclusive VIP perks and discounts without interruption.</p>`
    },
    {
      name: "19. Membership Renewed",
      title: "Membership Renewed Successfully",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#22c55e,#16a34a); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#9989;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Membership Renewed</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your membership at <strong style="color:#0f172a;">{{salon_name}}</strong> has been renewed</p>
<div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Status</td><td style="padding:8px 0; text-align:right;"><span style="background:#22c55e; color:#fff; padding:3px 12px; border-radius:20px; font-size:13px; font-weight:600;">ACTIVE</span></td></tr>
    <tr><td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td></tr>
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">New Expiry Date</td><td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">August 6, 2027</td></tr>
  </table>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Thank you for being a valued member. We look forward to continuing to serve you.</p>`
    },
    {
      name: "20. Package Expiring",
      title: "Your package is expiring soon",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#f59e0b,#d97706); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#9200;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Package Expiring Soon</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your package at <strong style="color:#0f172a;">{{salon_name}}</strong> is nearing its expiration</p>
<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Sessions Remaining</td><td style="padding:8px 0; text-align:right; font-weight:700; color:#d97706; font-size:18px;">3</td></tr>
  </table>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Book your remaining sessions before the package expires. Contact us to schedule your next appointment.</p>`
    },
    {
      name: "21. Gift Card Received",
      title: "You received a gift card!",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#8b5cf6,#7c3aed); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#127873;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Gift Card Received</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">You have received a gift card from <strong style="color:#0f172a;">{{salon_name}}</strong></p>
<div style="background:linear-gradient(135deg,#faf5ff,#f3e8ff); border:2px dashed #c4b5fd; border-radius:12px; padding:28px; margin-bottom:24px; text-align:center;">
  <p style="color:#7c3aed; font-size:12px; text-transform:uppercase; letter-spacing:2px; margin:0 0 8px 0; font-weight:700;">Gift Card</p>
  <p style="color:#0f172a; font-size:24px; font-weight:800; margin:0 0 12px 0; letter-spacing:2px;">GIFT-ABCD-1234</p>
  <p style="color:#7c3aed; font-size:14px; margin:0; font-weight:500;">Value: {{currency_symbol}}1,000.00</p>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Show this code at the front desk on your next visit to redeem your gift card balance.</p>`
    },
    {
      name: "22. Gift Card Expiring",
      title: "Your gift card is expiring soon",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#ef4444,#dc2626); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#9200;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Gift Card Expiring Soon</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your gift card at <strong style="color:#0f172a;">{{salon_name}}</strong> is about to expire</p>
<div style="background:#fef2f2; border:1px solid #fecaca; border-radius:12px; padding:24px; margin-bottom:24px; text-align:center;">
  <p style="color:#dc2626; font-size:16px; font-weight:600; margin:0 0 8px 0;">Don't let your gift card go to waste!</p>
  <p style="color:#64748b; font-size:14px; margin:0;">Book your appointment and redeem your balance before it expires.</p>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Contact us to book an appointment and enjoy your gift card benefits.</p>`
    },
    {
      name: "23. Gift Card Redeemed",
      title: "Gift Card Used",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#22c55e,#16a34a); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#9989;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Gift Card Redeemed</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your gift card has been used at <strong style="color:#0f172a;">{{salon_name}}</strong></p>
<div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Gift Card Code</td><td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a; font-family:monospace;">GIFT-ABCD-1234</td></tr>
    <tr><td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td></tr>
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Amount Used</td><td style="padding:8px 0; text-align:right; font-weight:700; color:#15803d; font-size:18px;">{{currency_symbol}}500.00</td></tr>
    <tr><td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td></tr>
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Remaining Balance</td><td style="padding:8px 0; text-align:right; font-weight:700; color:#0f172a; font-size:16px;">{{currency_symbol}}500.00</td></tr>
  </table>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">This transaction has been recorded. You can use your remaining balance on your next visit.</p>`
    },
    {
      name: "24. Referral Code",
      title: "Your Referral Code",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#3b82f6,#2563eb); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128279;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Your Personal Referral Code</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Share the love with your friends and family</p>
<div style="background:#eff6ff; border:2px dashed #93c5fd; border-radius:12px; padding:28px; margin-bottom:24px; text-align:center;">
  <p style="color:#2563eb; font-size:12px; text-transform:uppercase; letter-spacing:2px; margin:0 0 8px 0; font-weight:700;">Your Referral Code</p>
  <p style="color:#0f172a; font-size:24px; font-weight:800; margin:0; letter-spacing:2px; font-family:monospace;">AHMED-REF-2026</p>
</div>
<div style="background:#f8fafc; border-radius:12px; padding:20px; margin-bottom:24px;">
  <p style="color:#334155; font-size:14px; margin:0; text-align:center; line-height:1.7;">Share this code with friends and family. When they visit <strong>{{salon_name}}</strong>, you both earn rewards!</p>
</div>`
    },
    {
      name: "25. Referral Reward",
      title: "Referral Reward Earned!",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#22c55e,#16a34a); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#127942;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Referral Reward Earned!</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">A friend used your referral code at <strong style="color:#0f172a;">{{salon_name}}</strong></p>
<div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr><td style="padding:8px 0; color:#64748b; font-weight:500;">Points Earned</td><td style="padding:8px 0; text-align:right; font-weight:700; color:#15803d; font-size:18px;">+100</td></tr>
  </table>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Keep sharing your referral code to keep earning rewards. Thank you for spreading the word!</p>`
    },
    {
      name: "26. Welcome Email",
      title: "Welcome to {{salon_name}}!",
      content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#3b82f6,#2563eb); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128075;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Welcome to {{salon_name}}!</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your account has been created successfully</p>
<div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:24px; margin-bottom:24px; text-align:center;">
  <p style="color:#334155; font-size:15px; line-height:1.7; margin:0 0 16px 0;">We are excited to have you on board. Explore our services and book your first appointment today.</p>
  <p style="color:#2563eb; font-size:14px; font-weight:600; margin:0;">Your journey with us starts here.</p>
</div>
<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">If you have any questions, feel free to reach out. We are always here to help.</p>`
    }
  ];

  const results = [];
  for (const tmpl of allTemplates) {
    try {
      const renderedContent = renderTemplateText(tmpl.content, vars);
      const renderedSubject = renderTemplateText(tmpl.title, vars);
      await sendMail({
        to: TO,
        subject: `[${salonName}] ${renderedSubject}`,
        html: buildEmailHtml(renderedContent, vars),
        text: renderedContent.replace(/<[^>]+>/g, "")
      });
      results.push({ name: tmpl.name, status: "sent" });
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      results.push({ name: tmpl.name, status: "failed", error: err.message });
    }
  }

    res.json({ total: allTemplates.length, sent: results.filter(r => r.status === "sent").length, failed: results.filter(r => r.status === "failed").length, details: results });
  } catch (globalErr) {
    res.status(500).json({ success: false, error: globalErr.message || String(globalErr) });
  }
});

// GET /test-email/health - Check SMTP configuration
testEmailRouter.get("/health", (req, res) => {
  res.json({
    smtpConfigured: !!(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_FROM),
    smtpHost: process.env.SMTP_HOST || "NOT SET",
    smtpPort: process.env.SMTP_PORT || "NOT SET",
    smtpSecure: process.env.SMTP_SECURE || "NOT SET",
    timeout: "30 seconds",
    pooling: "Enabled",
    message: "SMTP configuration check"
  });
});
