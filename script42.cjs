const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function getLink() {
  const token = await prisma.passwordSetupToken.findFirst({
    where: { user: { email: "ranurajput6260@gmail.com" } },
    orderBy: { createdAt: 'desc' }
  });
  console.log("TokenHash:", token?.tokenHash);
}
getLink();
