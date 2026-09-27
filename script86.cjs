const fs = require('fs');
const file = 'src/modules/superAdmin/routes.js';
let lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const catalogIdx = lines.findIndex(l => l.includes('superAdminRouter.get("/product-catalog",'));
if(catalogIdx !== -1) {
  if (lines[catalogIdx+1].includes('prisma.productRequirement.findMany({')) {
     lines[catalogIdx+1] = lines[catalogIdx+1].replace('findMany({ orderBy:', 'findMany({ where: { salonId: null }, orderBy:');
  }
}

const reqIdx = lines.findIndex(l => l.includes('superAdminRouter.get("/product-requirements",'));
if(reqIdx !== -1) {
  // Add where.salonId = { not: null } after const where = {};
  for (let i = reqIdx; i < reqIdx + 5; i++) {
    if (lines[i].includes('const where = {};')) {
      lines[i] = 'const where = { salonId: { not: null } };';
      break;
    }
  }
}

fs.writeFileSync(file, lines.join('\n'), 'utf8');
console.log("Updated get routes");
