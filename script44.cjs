const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function checkUsers() {
  const users = await prisma.user.findMany({ select: { email: true }, take: 5 });
  console.log("Some emails in DB:", users.map(u => u.email));
}
checkUsers();
