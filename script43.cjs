const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function checkUser() {
  const user = await prisma.user.findUnique({
    where: { email: "ranurajput6260@gmail.com" }
  });
  console.log("User:", user ? "Exists" : "Does not exist");
}
checkUser();
