import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const email = "renurajput6260@gmail.com";
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    include: {
      memberships: {
        include: {
          salon: true,
          branch: true
        }
      },
      customerProfile: true
    }
  });

  console.log("User record for", email);
  console.log(JSON.stringify(user, null, 2));

  const allSalons = await prisma.salon.findMany({
    select: { id: true, name: true, status: true, ownerEmail: true, createdAt: true }
  });
  console.log("All Salons in DB:");
  console.log(JSON.stringify(allSalons, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
