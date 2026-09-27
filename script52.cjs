const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function clean() {
  const cats = await prisma.expenseCategory.findMany({ where: { name: "test" } });
  console.log("Found:", cats.length);
  for (const c of cats) {
     await prisma.expenseCategory.delete({ where: { id: c.id } });
  }
  console.log("Deleted test categories");
}
clean();
