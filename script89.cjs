const fs = require('fs');
const file = 'src/modules/superAdmin/routes.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Add /notifications endpoints
const notificationsEndpoints = `
superAdminRouter.get("/notifications", asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const items = await prisma.notification.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: "desc" },
    take: limit
  });
  res.json(items);
}));

superAdminRouter.patch("/notifications/read-all", asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.user.id, isRead: false },
    data: { isRead: true }
  });
  res.json({ success: true });
}));

superAdminRouter.patch("/notifications/:id/read", asyncHandler(async (req, res) => {
  await prisma.notification.update({
    where: { id: req.params.id },
    data: { isRead: true }
  });
  res.json({ success: true });
}));
`;

if (!content.includes('superAdminRouter.get("/notifications"')) {
  // Inject before module.exports
  content = content.replace('module.exports = superAdminRouter;', notificationsEndpoints + '\nmodule.exports = superAdminRouter;');
}

// 2. demo-leads assignment
const demoLeadAssignOld = `      if (assignedUser && assignedUser.email) {
        await sendMail({`;
const demoLeadAssignNew = `      if (assignedUser) {
        await prisma.notification.create({
          data: {
            userId: assignedUser.id,
            title: "New Lead Assigned",
            message: \`Lead \${lead.name} (\${lead.company || lead.salonName || "N/A"}) has been assigned to you.\`,
            type: "ASSIGNMENT",
            link: \`/super-admin/leads\`
          }
        });
      }
      if (assignedUser && assignedUser.email) {
        await sendMail({`;
content = content.replace(demoLeadAssignOld, demoLeadAssignNew);

// 3. support-tickets assignment
const ticketUpdateOld = `const row = await tx.supportTicket.update({ where: { id: req.params.id }, data: req.body });`;
const ticketUpdateNew = `const row = await tx.supportTicket.update({ where: { id: req.params.id }, data: req.body });
      if (req.body.assignedToId && req.body.assignedToId !== ticket.assignedToId) {
        await tx.notification.create({
          data: {
            userId: req.body.assignedToId,
            title: "Ticket Assigned",
            message: \`Support Ticket #\${row.id.slice(-6)} "\${row.title}" has been assigned to you.\`,
            type: "ASSIGNMENT",
            link: \`/super-admin/support\`
          }
        });
      }`;
content = content.replace(ticketUpdateOld, ticketUpdateNew);

fs.writeFileSync(file, content, 'utf8');
console.log("Updated superAdmin/routes.js for notifications");
