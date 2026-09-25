import fs from 'fs';

let code = fs.readFileSync('src/modules/superAdmin/routes.js', 'utf8');

const target = 'superAdminRouter.get("/demo-leads", asyncHandler(async (req, res) => {';
const oldRouteStart = code.indexOf(target);
const oldRouteEnd = code.indexOf('superAdminRouter.put("/demo-leads/:id"', oldRouteStart);

if (oldRouteStart === -1 || oldRouteEnd === -1) {
  console.error("Could not find bounds for demo-leads route!");
  process.exit(1);
}

const replacement = `superAdminRouter.get("/demo-leads", asyncHandler(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : "";
  const q = req.query.q ? String(req.query.q).trim() : "";
  const source = req.query.leadSource || req.query.source ? String(req.query.leadSource || req.query.source).trim() : "";
  const assignedUserId = req.query.assignedUserId || req.query.assigned ? String(req.query.assignedUserId || req.query.assigned).trim() : "";
  const createdFrom = req.query.createdFrom || req.query.from ? new Date(req.query.createdFrom || req.query.from) : null;
  const createdTo = req.query.createdTo || req.query.to ? new Date(req.query.createdTo || req.query.to) : null;
  if (createdTo) createdTo.setHours(23, 59, 59, 999);

  const where = {
    ...(status ? { status } : {}),
    ...(source ? { leadSource: { equals: source, mode: "insensitive" } } : {}),
    ...(assignedUserId ? { assignedUserId } : {}),
    ...((createdFrom || createdTo) ? {
      createdAt: {
        ...(createdFrom ? { gte: createdFrom } : {}),
        ...(createdTo ? { lte: createdTo } : {})
      }
    } : {}),
    ...(q ? {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
        { message: { contains: q, mode: "insensitive" } },
        { company: { contains: q, mode: "insensitive" } }
      ]
    } : {})
  };

  res.json(
    await prisma.demoLead.findMany({
      where,
      include: {
        salon: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true
          }
        }
      },
      orderBy: { createdAt: "desc" }
    })
  );
}));

`;

code = code.substring(0, oldRouteStart) + replacement + code.substring(oldRouteEnd);
fs.writeFileSync('src/modules/superAdmin/routes.js', code);
console.log("Successfully updated GET /demo-leads in backend with leadSource filter!");
