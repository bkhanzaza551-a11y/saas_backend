const fs = require('fs');
const file = 'src/modules/auth/routes.js';
let content = fs.readFileSync(file, 'utf8');

const str = content.substring(content.indexOf('authRouter.get("/me"'));
console.log(str.substring(0, 1500));
