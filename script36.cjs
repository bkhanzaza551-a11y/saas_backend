const fs = require('fs');
const file = 'src/modules/superAdmin/routes.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace('data: { status: "MEETING_SCHEDULED" }', 'data: { status: "DEMO_SCHEDULED" }');

fs.writeFileSync(file, content, 'utf8');
