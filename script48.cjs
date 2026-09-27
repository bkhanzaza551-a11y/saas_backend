const fs = require('fs');
const file = 'src/modules/owner/phase4/operations.js';
let content = fs.readFileSync(file, 'utf8');

const target = `      const defaults = [
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
      ];`;

const replacement = `      const defaults = [
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
      ];`;

content = content.replace(target, replacement);
fs.writeFileSync(file, content, 'utf8');
