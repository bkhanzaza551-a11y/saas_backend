import { prisma } from "./prisma.js";

/**
 * SMS Provider interface.
 * Each provider implements send({ to, message, senderId }).
 * Providers: twilio, msg91, gupshup, stub (fallback)
 *
 * Required env vars per provider:
 *   Twilio:  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   Msg91:   MSG91_AUTH_KEY, MSG91_TEMPLATE_ID (optional)
 *   Gupshup: GUPSHUP_API_KEY, GUPSHUP_SENDER_ID
 */

const SMS_TIMEOUT_MS = Number(process.env.SMS_TIMEOUT_MS || 10000);

// Keep logs useful without printing full phone numbers.
const maskPhone = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length <= 4) return "****" + digits;
  return "*".repeat(digits.length - 4) + digits.slice(-4);
};

/* ── Twilio ────────────────────────────────────────────────────────── */
const twilioSend = async ({ to, message, senderId }) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = senderId || process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    throw new Error("Twilio credentials missing: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const body = new URLSearchParams({ To: to, From: fromNumber, Body: message });
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMS_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `Twilio HTTP ${res.status}`);
    return { success: true, provider: "twilio", messageId: data.sid };
  } finally {
    clearTimeout(timer);
  }
};

/* ── Msg91 ─────────────────────────────────────────────────────────── */
const msg91Send = async ({ to, message, senderId }) => {
  const authKey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;

  if (!authKey) throw new Error("Msg91 credentials missing: set MSG91_AUTH_KEY");

  const phone = String(to).replace(/[^\d]/g, "");
  const payload = {
    flow_id: templateId || undefined,
    sender_id: senderId || process.env.MSG91_SENDER_ID || "MSG91",
    mobiles: phone,
    message
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMS_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.msg91.com/v5/flow", {
      method: "POST",
      headers: { authkey: authKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `Msg91 HTTP ${res.status}`);
    return { success: true, provider: "msg91", messageId: data.request_id || `msg91_${Date.now()}` };
  } finally {
    clearTimeout(timer);
  }
};

/* ── Gupshup ───────────────────────────────────────────────────────── */
const gupshupSend = async ({ to, message, senderId }) => {
  const apiKey = process.env.GUPSHUP_API_KEY;
  const sender = senderId || process.env.GUPSHUP_SENDER_ID;

  if (!apiKey || !sender) throw new Error("Gupshup credentials missing: set GUPSHUP_API_KEY, GUPSHUP_SENDER_ID");

  const phone = String(to).replace(/[^\d]/g, "");
  const params = new URLSearchParams({
    method: "sms",
    msg: message,
    msg_type: "text",
    userid: "",
    apikey: apiKey,
    senderid: sender,
    phone,
    format: "json"
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMS_TIMEOUT_MS);

  try {
    const res = await fetch(`https://enterprise.smsgupshup.com/API/1.0/sms/v2/send?${params}`, {
      method: "GET",
      signal: controller.signal
    });
    const data = await res.json();
    if (data.status !== "success") throw new Error(data.message || "Gupshup send failed");
    return { success: true, provider: "gupshup", messageId: data.messages?.[0]?.id || `gupshup_${Date.now()}` };
  } finally {
    clearTimeout(timer);
  }
};

/* ── SMSLogin ──────────────────────────────────────────────────────── */
const smsloginSend = async ({ to, message, senderId }) => {
  const apiKey = process.env.SMSLOGIN_API_KEY || "a6c1394e8d00ba6fe1f6";
  const sender = senderId || process.env.SMSLOGIN_SENDER_ID || "SAONST";
  const username = process.env.SMSLOGIN_USERNAME || "SALONEST";
  const templateId = process.env.OTP_SMS_TEMPLATE_ID || process.env.SMSLOGIN_TEMPLATE_ID || "1277178729296112165";

  if (!apiKey || !username) {
    throw new Error("SMSLogin credentials missing: set SMSLOGIN_API_KEY and SMSLOGIN_USERNAME");
  }

  // Format mobile: recipient mobile number with country code (e.g. 917747911593)
  let rawPhone = String(to).replace(/[^\d]/g, "");
  if (rawPhone.length === 10) rawPhone = `91${rawPhone}`;
  if (rawPhone.length === 11 && rawPhone.startsWith("0")) rawPhone = `91${rawPhone.slice(1)}`;

  const baseUrl = process.env.SMSLOGIN_API_URL || "https://smslogin.co/v3/api.php";

  const params = new URLSearchParams({
    username,
    apikey: apiKey,
    senderid: sender,
    mobile: rawPhone,
    message
  });

  if (templateId) {
    params.append("templateid", templateId);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMS_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}?${params.toString()}`, {
      method: "GET",
      signal: controller.signal
    });
    const data = await res.text();
    if (!res.ok) throw new Error(`SMSLogin HTTP ${res.status}: ${data}`);

    // SMSLogin returns strings like "{'Error':'Invalid Template ID'}" or "{'success':'...'}"
    if (data.includes("'Error':") || data.includes('"Error":') || data.includes("ErrorCode")) {
      let errMsg = data;
      try {
        const jsonClean = data.replace(/'/g, '"');
        const parsed = JSON.parse(jsonClean);
        errMsg = parsed.Error || parsed.ErrorMessage || data;
      } catch {}
      throw new Error(`SMSLogin Gateway Error: ${errMsg}`);
    }

    return { success: true, provider: "smslogin", messageId: `smslogin_${Date.now()}`, rawResponse: data };
  } finally {
    clearTimeout(timer);
  }
};

/* ── Stub (fallback) ───────────────────────────────────────────────── */
const stubSend = async ({ to, message }) => {
  console.log(`[SMS STUB] would send to ${to}: ${message.slice(0, 80)}...`);
  return { success: true, provider: "stub", messageId: `stub_${Date.now()}` };
};

/* ── Provider registry ─────────────────────────────────────────────── */
const providers = {
  twilio: { send: twilioSend },
  msg91: { send: msg91Send },
  gupshup: { send: gupshupSend },
  smslogin: { send: smsloginSend },
  stub: { send: stubSend }
};

const getProvider = (name) => providers[String(name || "stub").toLowerCase()] || providers.stub;

export const sendSms = async ({ salonId, to, message, senderId }) => {
  if (!to || !message) {
    return { success: false, error: "to and message are required" };
  }
  const settings = salonId
    ? await prisma.salonSetting.findFirst({
        where: { salonId, branchId: null },
        select: { smsSettings: true }
      }).catch(() => null)
    : null;

  const smsSettings = settings?.smsSettings && typeof settings.smsSettings === "object"
    ? settings.smsSettings
    : { gatewayProvider: null, senderId: null, apiKey: null };

  const defaultProvider = (process.env.SMSLOGIN_API_KEY || "a6c1394e8d00ba6fe1f6") ? "smslogin" : (process.env.TWILIO_ACCOUNT_SID ? "twilio" : (process.env.MSG91_AUTH_KEY ? "msg91" : "stub"));

  const providerName = smsSettings.gatewayProvider && smsSettings.gatewayProvider !== "stub"
    ? smsSettings.gatewayProvider
    : defaultProvider;

  const provider = getProvider(providerName);

  try {
    const result = await provider.send({
      to,
      message,
      senderId: senderId || smsSettings.senderId || null
    });
    await prisma.auditLog.create({
      data: {
        salonId,
        module: "SMS",
        action: "SMS_SENT",
        entityType: "SMS",
        entityId: result.messageId || null,
        summary: `SMS sent to ${to} via ${providerName}`,
        metadata: { provider: providerName, messageLength: message.length }
      }
    }).catch(() => {});
    return { success: true, ...result };
  } catch (error) {
    const reason = error?.message || String(error) || "unknown error";
    // sendSms() resolves instead of throwing, so callers that only attach a .catch()
    // never see provider failures. Log it here so gateway errors (bad DLT template
    // id, blocked number, auth failure) are visible in the service logs.
    console.error(
      `[SMS] send failed via ${providerName} to ${maskPhone(to)} (salon ${salonId ?? "none"}, template ${process.env.OTP_SMS_TEMPLATE_ID || process.env.SMSLOGIN_TEMPLATE_ID || "default"}):`,
      reason
    );
    await prisma.auditLog.create({
      data: {
        salonId,
        module: "SMS",
        action: "SMS_FAILED",
        entityType: "SMS",
        entityId: null,
        summary: `SMS failed to ${maskPhone(to)}: ${reason}`,
        metadata: { provider: providerName, error: reason, to: maskPhone(to) }
      }
    }).catch(() => {});
    return { success: false, error: reason === "unknown error" ? "SMS send failed" : reason };
  }
};

export const getSmsSettings = async (salonId) => {
  const settings = await prisma.salonSetting.findFirst({
    where: { salonId, branchId: null },
    select: { smsSettings: true }
  });
  return settings?.smsSettings && typeof settings.smsSettings === "object"
    ? settings.smsSettings
    : { gatewayProvider: "stub", senderId: null, apiKey: null };
};
