const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function clean() {
  await prisma.user.updateMany({
     data: { isPhoneVerified: true }
  });
  console.log("Updated existing users to verified.");
}
clean();
