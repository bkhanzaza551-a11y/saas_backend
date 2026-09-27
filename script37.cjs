const fs = require('fs');
const file = 'src/modules/owner/routes.js';
let content = fs.readFileSync(file, 'utf8');

const target = `    let channel = "sms";
    let delivered = false;
    try {
      const { sendWhatsApp } = await import("../../lib/whatsappService.js");
      await sendWhatsApp({ salonId: req.user.salonId, to: phone, message: \`Your Salon Nest verification code is \${otpCode}. It expires in 5 minutes.\` });
      delivered = true;
      channel = "whatsapp";
    } catch {
      try {
        const { sendSms } = await import("../../lib/smsService.js");
        await sendSms({ salonId: req.user.salonId, to: phone, message: \`Your Salon Nest verification code is \${otpCode}. It expires in 5 minutes.\` });
        delivered = true;
        channel = "sms";
      } catch {
        delivered = false;
      }
    }`;

const replacement = `    let channel = "sms";
    let delivered = false;
    try {
      const { sendWhatsApp } = await import("../../lib/whatsappService.js");
      const waResult = await sendWhatsApp({ salonId: req.user.salonId, to: phone, message: \`Your Salon Nest verification code is \${otpCode}. It expires in 5 minutes.\` });
      if (!waResult.success) throw new Error("WA Failed");
      delivered = true;
      channel = "whatsapp";
    } catch {
      try {
        const { sendSms } = await import("../../lib/smsService.js");
        const smsResult = await sendSms({ salonId: req.user.salonId, to: phone, message: \`Your Salon Nest verification code is \${otpCode}. It expires in 5 minutes.\` });
        if (!smsResult.success) throw new Error("SMS Failed");
        delivered = true;
        channel = "sms";
      } catch {
        delivered = false;
      }
    }`;

content = content.replace(target, replacement);

fs.writeFileSync(file, content, 'utf8');
