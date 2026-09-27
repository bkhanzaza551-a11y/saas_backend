const fs = require('fs');
const file = 'src/modules/auth/routes.js';
let content = fs.readFileSync(file, 'utf8');

const regex = /const serializeMembership = \([\s\S]*?return res\.json\(\{[\s\S]*?user: \{ id: user\.id, name: user\.name, systemRole: user\.systemRole \},[\s\S]*?\}\);/;

console.log(content.match(regex)[0]);
