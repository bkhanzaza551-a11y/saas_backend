const fs = require('fs');
const file = 'src/modules/owner/routes.js';
let content = fs.readFileSync(file, 'utf8');

const regex = /if \(req\.user\.membershipId\) \{\s*await prisma\.userSalon\.update\(\{ where: \{ id: req\.user\.membershipId \}, data: \{ phone \} \}\);\s*\}/g;

const replacement = `await prisma.user.update({ where: { id: req.user.userId }, data: { isPhoneVerified: true } });
      if (req.user.membershipId) {
        await prisma.userSalon.update({ where: { id: req.user.membershipId }, data: { phone } });
      }`;

content = content.replace(regex, replacement);
fs.writeFileSync(file, content, 'utf8');
