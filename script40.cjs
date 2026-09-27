const fs = require('fs');
const file = 'src/modules/owner/routes.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/return res\.json\(\{\s*message: delivered[\s\S]*?channel\s*\}\);/, 
`return res.json({
    message: delivered
      ? \`OTP sent via \${channel === "whatsapp" ? "WhatsApp" : "SMS"}.\`
      : "Verification code generated. Use the code shown to continue.",
    channel,
    otpCode
  });`);

fs.writeFileSync(file, content, 'utf8');
