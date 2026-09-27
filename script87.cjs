const fs = require('fs');
const file = 'src/modules/superAdmin/routes.js';
let lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const startIdx = lines.findIndex(l => l.includes('superAdminRouter.patch("/team/:id",'));
let endIdx = startIdx;
while(endIdx < lines.length && !lines[endIdx].includes('superAdminRouter.patch("/team/:id/activate"')) {
  endIdx++;
}

const newBlock = `  superAdminRouter.patch("/team/:id", asyncHandler(async (req, res) => {
    const { name, adminRoleId, department } = req.body;
    const existingUser = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!existingUser) return res.status(404).json({ message: "User not found" });

    const data = {};
    if (name) data.name = name;

    let pagePermissions = existingUser.pagePermissions || {};
    if (Array.isArray(pagePermissions)) {
      pagePermissions = { permissions: pagePermissions };
    }

    let updatedPermissions = false;
    
    if (adminRoleId !== undefined) {
      pagePermissions.adminRoleId = adminRoleId;
      
      const gs = await prisma.globalSetting.findFirst();
      const roles = gs?.notificationDefaults?.adminRoles || [];
      const role = roles.find(r => r.id === adminRoleId);
      if (role) {
        pagePermissions.permissions = role.permissions || [];
      }
      updatedPermissions = true;
    }

    if (department !== undefined) {
      pagePermissions.department = department;
      updatedPermissions = true;
    }

    if (updatedPermissions) {
      data.pagePermissions = pagePermissions;
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data,
      select: { id: true, name: true, email: true, isActive: true, createdAt: true, pagePermissions: true }
    });
    res.json(user);
  }));`;

lines.splice(startIdx, endIdx - startIdx, newBlock);
fs.writeFileSync(file, lines.join('\n'), 'utf8');
console.log("Updated PATCH /team/:id");
