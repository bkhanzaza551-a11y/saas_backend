import { prisma } from "./prisma.js";
import { sendMail } from "./mailer.js";
import { renderTemplateText, resolveTemplateContext } from "./phase3.js";

const normalizeTemplateType = (value) => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");

const fallbackTemplates = {
  invoice_template: {
    title: "Invoice Generated - {{invoice_number}}",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#3b82f6,#2563eb); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128196;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Invoice Generated</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your invoice from <strong style="color:#0f172a;">{{salon_name}}</strong> is ready</p>

<div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Invoice Number</td>
      <td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">{{invoice_number}}</td>
    </tr>
    <tr>
      <td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Total Amount</td>
      <td style="padding:8px 0; text-align:right; font-weight:700; color:#0f172a; font-size:18px;">{{currency_symbol}}{{invoice_amount}}</td>
    </tr>
  </table>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">If you have any questions regarding this invoice, please contact our front desk and we will be happy to assist you.</p>`
  },
  invoice_refund_template: {
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
  invoice_cancel_template: {
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
  membership_purchase_template: {
    title: "Welcome to your Membership",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#8b5cf6,#7c3aed); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#127942;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Welcome to your Membership</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your membership at <strong style="color:#0f172a;">{{salon_name}}</strong> is now active</p>

<div style="background:#faf5ff; border:1px solid #e9d5ff; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Status</td>
      <td style="padding:8px 0; text-align:right;"><span style="background:#22c55e; color:#fff; padding:3px 12px; border-radius:20px; font-size:13px; font-weight:600;">ACTIVE</span></td>
    </tr>
    <tr>
      <td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Valid Until</td>
      <td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">{{membership_expiry}}</td>
    </tr>
  </table>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">You can now enjoy all your exclusive member benefits and perks. We look forward to serving you.</p>`
  },
  package_purchase_template: {
    title: "Your Package is Active",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#f59e0b,#d97706); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#127873;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Your Package is Active</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your package at <strong style="color:#0f172a;">{{salon_name}}</strong> is now active</p>

<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Status</td>
      <td style="padding:8px 0; text-align:right;"><span style="background:#22c55e; color:#fff; padding:3px 12px; border-radius:20px; font-size:13px; font-weight:600;">ACTIVE</span></td>
    </tr>
    <tr>
      <td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Sessions Available</td>
      <td style="padding:8px 0; text-align:right; font-weight:700; color:#0f172a; font-size:18px;">{{package_balance}}</td>
    </tr>
  </table>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">We look forward to seeing you for your next session. Book your appointment at your convenience.</p>`
  },
  payment_receipt_template: {
    title: "Payment Received - {{currency_symbol}}{{invoice_amount}}",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#22c55e,#16a34a); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#9989;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Payment Received</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Thank you for your payment at <strong style="color:#0f172a;">{{salon_name}}</strong></p>

<div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:24px; margin-bottom:24px; text-align:center;">
  <p style="color:#64748b; font-size:13px; text-transform:uppercase; letter-spacing:1px; margin:0 0 8px 0; font-weight:600;">Amount Paid</p>
  <p style="color:#15803d; font-size:32px; font-weight:800; margin:0;">{{currency_symbol}}{{invoice_amount}}</p>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">This payment has been successfully recorded. Thank you for choosing <strong>{{salon_name}}</strong>.</p>`
  },
  appointment_confirmation: {
    title: "Appointment Confirmed",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#3b82f6,#2563eb); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128197;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Appointment Confirmed</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your appointment at <strong style="color:#0f172a;">{{salon_name}}</strong> has been confirmed</p>

<div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Status</td>
      <td style="padding:8px 0; text-align:right;"><span style="background:#22c55e; color:#fff; padding:3px 12px; border-radius:20px; font-size:13px; font-weight:600;">CONFIRMED</span></td>
    </tr>
    <tr>
      <td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Date & Time</td>
      <td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">{{appointment_date_time}}</td>
    </tr>
  </table>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">If you need to reschedule or cancel, please contact us at your earliest convenience.</p>`
  },
  service_reminder_template: {
    title: "Time for your next {{service_name}}",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#ec4899,#db2777); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#10024;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Time for your next {{service_name}}!</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">It's been a while since your last visit to <strong style="color:#0f172a;">{{salon_name}}</strong>.</p>

<div style="background:#fdf2f8; border:1px solid #fbcfe8; border-radius:12px; padding:24px; margin-bottom:24px;">
  <p style="font-size:15px; color:#334155; text-align:center; margin:0;">
    We noticed it's time for your <strong>{{service_name}}</strong> based on your last appointment on <strong>{{last_appointment_date}}</strong>.
    Keeping up with your routine helps maintain the best results!
  </p>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Contact our front desk or visit our online booking portal to schedule your next session.</p>`
  },
  appointment_reminder: {
    title: "Reminder: Upcoming Appointment",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#f59e0b,#d97706); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#9200;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Appointment Reminder</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">This is a friendly reminder about your upcoming appointment</p>

<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Salon</td>
      <td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">{{salon_name}}</td>
    </tr>
    <tr>
      <td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Date & Time</td>
      <td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">{{appointment_date_time}}</td>
    </tr>
  </table>
</div>

<div style="background:#f8fafc; border-radius:8px; padding:16px; margin-bottom:24px; text-align:center;">
  <p style="color:#64748b; font-size:14px; margin:0;">We look forward to seeing you. Please arrive a few minutes early for the best experience.</p>
</div>`
  },
  appointment_cancelled: {
    title: "Appointment Cancelled",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#ef4444,#dc2626); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128680;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Appointment Cancelled</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your appointment has been cancelled</p>

<div style="background:#fef2f2; border:1px solid #fecaca; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Salon</td>
      <td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">{{salon_name}}</td>
    </tr>
    <tr>
      <td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Scheduled For</td>
      <td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">{{appointment_date_time}}</td>
    </tr>
  </table>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">We hope to see you again soon. Feel free to book a new appointment at any time.</p>`
  },
  order_confirmation: {
    title: "Order Confirmed - {{order_number}}",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#3b82f6,#2563eb); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128230;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Order Confirmed</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Thank you for your order from <strong style="color:#0f172a;">{{salon_name}}</strong></p>

<div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Order Number</td>
      <td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">{{order_number}}</td>
    </tr>
    <tr>
      <td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Total Amount</td>
      <td style="padding:8px 0; text-align:right; font-weight:700; color:#0f172a; font-size:18px;">{{currency_symbol}}{{order_amount}}</td>
    </tr>
  </table>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">We are processing your order and will keep you updated on the status. Thank you for your patience.</p>`
  },
  enquiry_follow_up: {
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
  feedback_follow_up: {
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
  feedback_request_template: {
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
  birthday_offer_template: {
    title: "Happy Birthday {{customer_name}}!",
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
  anniversary_offer_template: {
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
  loyalty_earning_template: {
    title: "You earned {{points_earned}} loyalty points!",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#f59e0b,#d97706); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#127942;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Loyalty Points Earned</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">You have earned points at <strong style="color:#0f172a;">{{salon_name}}</strong></p>

<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Points Earned</td>
      <td style="padding:8px 0; text-align:right; font-weight:700; color:#d97706; font-size:18px;">+{{points_earned}}</td>
    </tr>
    <tr>
      <td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">New Balance</td>
      <td style="padding:8px 0; text-align:right; font-weight:700; color:#0f172a; font-size:18px;">{{new_balance}} points</td>
    </tr>
  </table>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Keep visiting to earn more points and unlock exciting rewards. Your loyalty means the world to us.</p>`
  },
  loyalty_expiry_template: {
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
  membership_expiry_template: {
    title: "Your membership is expiring soon",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#f59e0b,#d97706); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128197;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Membership Expiring Soon</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your membership at <strong style="color:#0f172a;">{{salon_name}}</strong> is nearing its end</p>

<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Expiry Date</td>
      <td style="padding:8px 0; text-align:right; font-weight:700; color:#d97706; font-size:16px;">{{membership_expiry}}</td>
    </tr>
  </table>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Renew your membership now to continue enjoying your exclusive VIP perks and discounts without interruption.</p>`
  },
  membership_renewal_template: {
    title: "Membership Renewed Successfully",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#22c55e,#16a34a); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#9989;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Membership Renewed</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your membership at <strong style="color:#0f172a;">{{salon_name}}</strong> has been renewed</p>

<div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Status</td>
      <td style="padding:8px 0; text-align:right;"><span style="background:#22c55e; color:#fff; padding:3px 12px; border-radius:20px; font-size:13px; font-weight:600;">ACTIVE</span></td>
    </tr>
    <tr>
      <td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">New Expiry Date</td>
      <td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a;">{{membership_expiry}}</td>
    </tr>
  </table>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Thank you for being a valued member. We look forward to continuing to serve you.</p>`
  },
  package_expiry_template: {
    title: "Your package is expiring soon",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#f59e0b,#d97706); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#9200;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Package Expiring Soon</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your package at <strong style="color:#0f172a;">{{salon_name}}</strong> is nearing its expiration</p>

<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Sessions Remaining</td>
      <td style="padding:8px 0; text-align:right; font-weight:700; color:#d97706; font-size:18px;">{{package_balance}}</td>
    </tr>
  </table>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Book your remaining sessions before the package expires. Contact us to schedule your next appointment.</p>`
  },
  gift_card_issued: {
    title: "You received a gift card!",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#8b5cf6,#7c3aed); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#127873;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Gift Card Received</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">You have received a gift card from <strong style="color:#0f172a;">{{salon_name}}</strong></p>

<div style="background:linear-gradient(135deg,#faf5ff,#f3e8ff); border:2px dashed #c4b5fd; border-radius:12px; padding:28px; margin-bottom:24px; text-align:center;">
  <p style="color:#7c3aed; font-size:12px; text-transform:uppercase; letter-spacing:2px; margin:0 0 8px 0; font-weight:700;">Gift Card</p>
  <p style="color:#0f172a; font-size:24px; font-weight:800; margin:0 0 12px 0; letter-spacing:2px;">{{gift_card_code}}</p>
  <p style="color:#7c3aed; font-size:14px; margin:0; font-weight:500;">Value: {{currency_symbol}}{{gift_card_amount}}</p>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Show this code at the front desk on your next visit to redeem your gift card balance.</p>`
  },
  gift_card_expiry_template: {
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
  gift_card_redeemed_template: {
    title: "Gift Card Used - {{currency_symbol}}{{amount_used}}",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#22c55e,#16a34a); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#9989;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Gift Card Redeemed</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Your gift card has been used at <strong style="color:#0f172a;">{{salon_name}}</strong></p>

<div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Gift Card Code</td>
      <td style="padding:8px 0; text-align:right; font-weight:600; color:#0f172a; font-family:monospace;">{{gift_card_code}}</td>
    </tr>
    <tr>
      <td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Amount Used</td>
      <td style="padding:8px 0; text-align:right; font-weight:700; color:#15803d; font-size:18px;">{{currency_symbol}}{{amount_used}}</td>
    </tr>
    <tr>
      <td colspan="2" style="padding:4px 0;"><hr style="border:none; border-top:1px dashed #cbd5e1; margin:0;" /></td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Remaining Balance</td>
      <td style="padding:8px 0; text-align:right; font-weight:700; color:#0f172a; font-size:16px;">{{currency_symbol}}{{balance_amount}}</td>
    </tr>
  </table>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">This transaction has been recorded. You can use your remaining balance on your next visit.</p>`
  },
  referral_code_sms: {
    title: "Your Referral Code",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#3b82f6,#2563eb); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#128279;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Your Personal Referral Code</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">Share the love with your friends and family</p>

<div style="background:#eff6ff; border:2px dashed #93c5fd; border-radius:12px; padding:28px; margin-bottom:24px; text-align:center;">
  <p style="color:#2563eb; font-size:12px; text-transform:uppercase; letter-spacing:2px; margin:0 0 8px 0; font-weight:700;">Your Referral Code</p>
  <p style="color:#0f172a; font-size:24px; font-weight:800; margin:0; letter-spacing:2px; font-family:monospace;">{{referral_code}}</p>
</div>

<div style="background:#f8fafc; border-radius:12px; padding:20px; margin-bottom:24px;">
  <p style="color:#334155; font-size:14px; margin:0; text-align:center; line-height:1.7;">Share this code with friends and family. When they visit <strong>{{salon_name}}</strong>, you both earn rewards!</p>
</div>`
  },
  referrer_reward_sms: {
    title: "Referral Reward Earned!",
    content: `<div style="text-align:center; margin-bottom:24px;">
  <div style="display:inline-block; background:linear-gradient(135deg,#22c55e,#16a34a); width:56px; height:56px; border-radius:50%; line-height:56px; font-size:24px;">&#127942;</div>
</div>
<h2 style="color:#0f172a; font-size:22px; font-weight:700; text-align:center; margin:0 0 8px 0;">Referral Reward Earned!</h2>
<p style="color:#64748b; text-align:center; font-size:14px; margin:0 0 28px 0;">A friend used your referral code at <strong style="color:#0f172a;">{{salon_name}}</strong></p>

<div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:24px; margin-bottom:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px; color:#334155;">
    <tr>
      <td style="padding:8px 0; color:#64748b; font-weight:500;">Points Earned</td>
      <td style="padding:8px 0; text-align:right; font-weight:700; color:#15803d; font-size:18px;">+{{points_earned}}</td>
    </tr>
  </table>
</div>

<p style="color:#64748b; font-size:14px; line-height:1.7; text-align:center; margin:0;">Keep sharing your referral code to keep earning rewards. Thank you for spreading the word!</p>`
  }
};

const resolveMessageTemplate = async (salonId, templateType) => {
  const normalizedType = normalizeTemplateType(templateType);
  const fallback = fallbackTemplates[normalizedType];
  if (!fallback) return null;
  const existing = await prisma.messageTemplate.findUnique({
    where: { salonId_type: { salonId, type: normalizedType } }
  });
  if (existing) {
    if (existing.title !== fallback.title || existing.content !== fallback.content) {
      return prisma.messageTemplate.update({
        where: { id: existing.id },
        data: { title: fallback.title, content: fallback.content }
      });
    }
    return existing;
  }
  return prisma.messageTemplate.create({
    data: {
      salonId,
      type: normalizedType,
      title: fallback.title,
      content: fallback.content,
      variables: []
    }
  });
};

const areNotificationEmailsEnabled = async (salonId) => {
  if (!salonId) return true;
  const setting = await prisma.salonSetting.findFirst({
    where: { salonId, branchId: null },
    select: { advancedSettings: true }
  });
  return setting?.advancedSettings?.notificationSettings?.emailEnabled !== false;
};

export const buildEmailHtml = (textContent, variables) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="format-detection" content="telephone=no, date=no, email=no, address=no" />
  <title>${variables.salon_name || "Notification"}</title>
  <style>
    :root { color-scheme: light !important; supported-color-schemes: light !important; }
    body { background-color: #ffffff !important; margin: 0 !important; padding: 0 !important; }
    table, td { background-color: inherit !important; }
    @media only screen and (max-width: 620px) {
      .email-container { width: 100% !important; padding: 0 8px !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#ffffff; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">

<!-- Gmail dark mode fix: transparent bg image forces white bg -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff; background-image:url('https://img.spacelaunchnow.me/1x1.gif'); background-repeat:repeat; margin:0; padding:0;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="email-container" style="max-width:600px; width:100%;">
        
        <!-- Card -->
        <tr>
          <td style="background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,0.08); border:1px solid #d1d5db;">
            
            <!-- Header -->
            <tr>
              <td style="background-color:#0f172a; padding:32px 28px; text-align:center;">
                <h1 style="color:#ffffff; margin:0; font-size:24px; font-weight:800; letter-spacing:-0.5px;">${variables.salon_name || "Salon"}</h1>
                <p style="color:#94a3b8; margin:6px 0 0 0; font-size:11px; letter-spacing:2px; text-transform:uppercase;">NOTIFICATION</p>
              </td>
            </tr>
            
            <!-- Body -->
            <tr>
              <td style="padding:32px 28px; background-color:#ffffff;">
                <p style="color:#0f172a; font-size:15px; margin:0 0 16px 0; line-height:1.6;">Hi ${variables.customer_name || "there"},</p>
                ${textContent}
              </td>
            </tr>
            
            <!-- Divider -->
            <tr>
              <td style="padding:0 28px; background-color:#ffffff;"><hr style="border:none; border-top:1px solid #e2e8f0; margin:0;" /></td>
            </tr>
            
            <!-- Footer -->
            <tr>
              <td style="padding:20px 28px; text-align:center; background-color:#f8fafc;">
                <p style="font-size:12px; color:#64748b; margin:0 0 4px 0;">&copy; ${new Date().getFullYear()} ${variables.salon_name || "Salon"}. All rights reserved.</p>
                <p style="font-size:11px; color:#94a3b8; margin:0;">This is an automated notification. Please do not reply directly to this email.</p>
              </td>
            </tr>
            
          </td>
        </tr>
        
      </table>
    </td>
  </tr>
</table>

</body>
</html>`;

export const attemptCustomerTemplateEmail = async ({ salonId, toEmail, templateType, context = {} }) => {
  if (!toEmail) {
    return { skipped: true, reason: "missing-recipient" };
  }

  try {
    const emailEnabled = await areNotificationEmailsEnabled(salonId);
    if (!emailEnabled) {
      return { skipped: true, reason: "email-alerts-disabled" };
    }

    const template = await resolveMessageTemplate(salonId, templateType);
    if (!template?.content) {
      return { skipped: true, reason: "missing-template" };
    }

    const variables = await resolveTemplateContext(salonId, context);
    const textContent = renderTemplateText(template.content, variables);
    const subjectRaw = template.title || "Salon update";
    const subject = renderTemplateText(subjectRaw, variables);
    
    const html = buildEmailHtml(textContent, variables);

    const delivery = await sendMail({
      to: toEmail,
      subject,
      html,
      text: textContent
    });

    return {
      skipped: false,
      templateType: template.type,
      delivery
    };
  } catch (error) {
    console.error(`[emailNotifications] Failed to send email of type ${templateType} to ${toEmail}:`, error);
    return {
      skipped: true,
      reason: "delivery-error",
      error: error.message
    };
  }
};
