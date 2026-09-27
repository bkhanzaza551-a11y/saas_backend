const fs = require('fs');
const file = 'prisma/schema.prisma';
let content = fs.readFileSync(file, 'utf8');

content = content.replace('isDemoAccount            Boolean              @default(false)', 'isDemoAccount            Boolean              @default(false)\n  isPhoneVerified          Boolean              @default(false)');
fs.writeFileSync(file, content, 'utf8');
