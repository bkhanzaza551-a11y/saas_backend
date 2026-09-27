const fs = require('fs');
const file = 'src/modules/owner/routes.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace('...(process.env.NODE_ENV !== "production" ? { otpCode } : {})', 'otpCode // Added for testing');

fs.writeFileSync(file, content, 'utf8');
