const fs = require('fs');
const file = 'src/modules/owner/phase4/operations.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/ownerRouter\.get\("\/expense-categories"[\s\S]*?res\.json\(categories\);\n  \}\);/, 
`ownerRouter.get("/expense-categories", requireFeatureEnabled("expenses"), requireSalonPermission("expenses", "view"), async (req, res) => {
    let categories = await prisma.expenseCategory.findMany({ where: { salonId: req.salonId }, orderBy: { name: "asc" } });
    
    if (categories.length === 0) {
      const defaults = [
         { name: "Rent", description: "PNL:Operating Expenses|ACTIVE:true|Monthly salon rent" },
         { name: "Utilities", description: "PNL:Operating Expenses|ACTIVE:true|Electricity, water, internet" },
         { name: "Inventory & Products", description: "PNL:Cost of Sales|ACTIVE:true|Shampoos, colors, professional products" },
         { name: "Staff Payroll", description: "PNL:Payroll|ACTIVE:true|Salaries and wages" },
         { name: "Staff Commission", description: "PNL:Payroll|ACTIVE:true|Commissions paid to staff" },
         { name: "Marketing & Ads", description: "PNL:Operating Expenses|ACTIVE:true|Social media ads, flyers, promotions" },
         { name: "Maintenance & Repairs", description: "PNL:Operating Expenses|ACTIVE:true|AC repair, plumbing, salon maintenance" },
         { name: "Software & IT", description: "PNL:Operating Expenses|ACTIVE:true|Software subscriptions" },
         { name: "Refreshments", description: "PNL:Operating Expenses|ACTIVE:true|Coffee, tea, water for clients and staff" },
         { name: "Taxes & Licenses", description: "PNL:Operating Expenses|ACTIVE:true|Government taxes, business licenses" },
         { name: "Cleaning Services", description: "PNL:Operating Expenses|ACTIVE:true|Daily cleaning, deep cleaning, pest control" },
         { name: "Office Supplies", description: "PNL:Operating Expenses|ACTIVE:true|Stationery, receipt paper, printer ink" },
         { name: "Insurance", description: "PNL:Operating Expenses|ACTIVE:true|Business liability, property insurance" },
         { name: "Legal & Accounting", description: "PNL:Operating Expenses|ACTIVE:true|CA fees, legal consultation" },
         { name: "Miscellaneous", description: "PNL:Operating Expenses|ACTIVE:true|Other general expenses" }
      ];
      await prisma.expenseCategory.createMany({
         data: defaults.map(d => ({ ...d, salonId: req.salonId }))
      });
      categories = await prisma.expenseCategory.findMany({ where: { salonId: req.salonId }, orderBy: { name: "asc" } });
    }
    
    res.json(categories);
  });`);

fs.writeFileSync(file, content, 'utf8');
