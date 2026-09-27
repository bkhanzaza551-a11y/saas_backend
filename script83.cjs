const fs = require('fs');
const file = 'src/modules/superAdmin/routes.js';
let content = fs.readFileSync(file, 'utf8');

const startIdx = content.indexOf('superAdminRouter.patch("/product-requirements/:id", asyncHandler(async (req, res) => {');
const endStr = 'res.json(await prisma.productRequirement.update({ where: { id: req.params.id }, data }));\r\n  }));';
const endIdx = content.indexOf(endStr, startIdx);

if (startIdx !== -1 && endIdx !== -1) {
  const newBlock = `superAdminRouter.patch("/product-requirements/:id", asyncHandler(async (req, res) => {
    const existing = await prisma.productRequirement.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: "Not found" });
    const data = {};
    if (req.body.productName !== undefined) data.productName = req.body.productName;
    if (req.body.description !== undefined) data.description = req.body.description;
    if (req.body.category !== undefined) data.category = req.body.category;
    if (req.body.requiredQty !== undefined || req.body.quantity !== undefined) data.quantity = req.body.requiredQty || req.body.quantity;
    if (req.body.unitCost !== undefined || req.body.unitPrice !== undefined) data.unitPrice = req.body.unitCost || req.body.unitPrice;
    if (req.body.priority !== undefined) data.priority = req.body.priority;
    if (req.body.status !== undefined) data.status = req.body.status;
    if (req.body.vendor !== undefined) data.vendor = req.body.vendor;
    if (req.body.remark !== undefined) data.notes = req.body.remark;
    if (req.body.notes !== undefined) data.notes = req.body.notes;

    if (req.body.status === "COMPLETED" && existing.status !== "COMPLETED") {
      const catalogItem = await prisma.productRequirement.findFirst({
        where: {
          salonId: null,
          productName: { equals: existing.productName, mode: "insensitive" }
        },
        orderBy: { availableQty: 'desc' }
      });
      if (catalogItem && catalogItem.availableQty >= existing.quantity) {
        await prisma.productRequirement.update({
          where: { id: catalogItem.id },
          data: { availableQty: catalogItem.availableQty - existing.quantity }
        });
      } else if (catalogItem && catalogItem.availableQty > 0) {
        await prisma.productRequirement.update({
          where: { id: catalogItem.id },
          data: { availableQty: 0 }
        });
      }
    }

    res.json(await prisma.productRequirement.update({ where: { id: req.params.id }, data }));
  }));`;

  content = content.substring(0, startIdx) + newBlock + content.substring(endIdx + endStr.length);
  fs.writeFileSync(file, content, 'utf8');
  console.log("Successfully replaced block using indexOf.");
} else {
  console.log("Could not find start or end bounds.");
  console.log("Start:", startIdx, "End:", endIdx);
}
