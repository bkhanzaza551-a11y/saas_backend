const fs = require('fs');
const file = 'src/modules/superAdmin/routes.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace('data: { status: "CONTACTED" }', 'data: { status: "CONNECTED" }');

fs.writeFileSync(file, content, 'utf8');
