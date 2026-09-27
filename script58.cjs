const fs = require('fs');
const file = 'src/modules/auth/routes.js';
let content = fs.readFileSync(file, 'utf8');
content = content.replace('user: { id: user.id, name: user.name, email: user.email, systemRole: user.systemRole },', 'user: { id: user.id, name: user.name, email: user.email, systemRole: user.systemRole, isPhoneVerified: user.isPhoneVerified },');
fs.writeFileSync(file, content, 'utf8');
