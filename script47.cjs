const fs = require('fs');
const file = 'src/modules/owner/phase4/operations.js';
let content = fs.readFileSync(file, 'utf8');

const target = `ownerRouter.get("/expense-categories", requireFeatureEnabled("expenses"), requireSalonPermission("expenses", "view"), async (req, res) => {
    res.json(await prisma.expenseCategory.findMany({ where: { salonId: req.salonId }, orderBy: { name: "asc" } }));
  });`;

const replacement = `ownerRouter.get("/expense-categories", requireFeatureEnabled("expenses"), requireSalonPermission("expenses", "view"), async (req, res) => {
    let categories = await prisma.expenseCategory.findMany({ where: { salonId: req.salonId }, orderBy: { name: "asc" } });
    
    if (categories.length === 0) {
      const defaults = [
         { name: "Rent", description: "Monthly salon rent" },
         { name: "Utilities", description: "Electricity, water, internet" },
         { name: "Inventory & Products", description: "Shampoos, colors, professional products" },
         { name: "Staff Payroll", description: "Salaries and wages" },
         { name: "Staff Commission", description: "Commissions paid to staff" },
         { name: "Marketing & Ads", description: "Social media ads, flyers, promotions" },
         { name: "Maintenance & Repairs", description: "AC repair, plumbing, salon maintenance" },
         { name: "Software & IT", description: "Software subscriptions" },
         { name: "Refreshments", description: "Coffee, tea, water for clients and staff" },
         { name: "Taxes & Licenses", description: "Government taxes, business licenses" },
         { name: "Cleaning Services", description: "Daily cleaning, deep cleaning, pest control" },
         { name: "Office Supplies", description: "Stationery, receipt paper, printer ink" },
         { name: "Insurance", description: "Business liability, property insurance" },
         { name: "Legal & Accounting", description: "CA fees, legal consultation" },
         { name: "Miscellaneous", description: "Other general expenses" }
      ];
      await prisma.expenseCategory.createMany({
         data: defaults.map(d => ({ ...d, salonId: req.salonId }))
      });
      categories = await prisma.expenseCategory.findMany({ where: { salonId: req.salonId }, orderBy: { name: "asc" } });
    }
    
    res.json(categories);
  });`;

content = content.replace(target, replacement);
fs.writeFileSync(file, content, 'utf8');
