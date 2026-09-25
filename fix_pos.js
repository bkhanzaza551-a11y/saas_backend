import fs from 'fs';

let code = fs.readFileSync('src/lib/pos.js', 'utf8');

code = code.replace(
  `data: item.customServices.map(sid => ({ membershipPlanId: plan.id, serviceId: sid }))`,
  `data: item.customServices.map(sid => ({ membershipPlanId: plan.id, serviceId: typeof sid === 'string' ? sid : (sid.id || sid.serviceId) }))`
);

code = code.replace(
  `data: item.customServices.map(sid => ({ packageId: pack.id, serviceId: sid }))`,
  `data: item.customServices.map(sid => ({ packageId: pack.id, serviceId: typeof sid === 'string' ? sid : (sid.id || sid.serviceId), sessions: typeof sid === 'object' ? Number(sid.qty || sid.sessions || 1) : 1 }))`
);

fs.writeFileSync('src/lib/pos.js', code);
console.log("Replaced pos.js!");
