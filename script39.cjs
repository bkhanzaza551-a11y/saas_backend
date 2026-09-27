const fs = require('fs');
const file = 'src/modules/owner/routes.js';
let content = fs.readFileSync(file, 'utf8');

const target = `  return res.json({
    message: delivered
      ? \`OTP sent via \${channel === "whatsapp" ? "WhatsApp" : "SMS"}.\`
      : "Verification code generated. Use the code shown to continue.",
    channel
  });`;

const replacement = `  return res.json({
    message: delivered
      ? \`OTP sent via \${channel === "whatsapp" ? "WhatsApp" : "SMS"}.\`
      : "Verification code generated. Use the code shown to continue.",
    channel,
    otpCode // Testing purpose
  });`;

content = content.replace(target, replacement);
fs.writeFileSync(file, content, 'utf8');
