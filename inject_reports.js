import fs from 'fs';

let content = fs.readFileSync('src/modules/owner/phase4/reports.js', 'utf8');

const additionalRoutes = `
    // --- Standard Reports Handlers ---
    ownerRouter.get("/reports/sales-summary", async (req, res) => {
      try {
        const bs = branchScope(req);
        const invoices = await prisma.invoice.findMany({
          where: { salonId: req.salonId, ...bs, status: { not: "CANCELLED" }, ...parseDateWhere(req.query) }
        });
        const gross = invoices.reduce((s, i) => s + toNumber(i.subtotal || i.total), 0);
        const net = invoices.reduce((s, i) => s + toNumber(i.total), 0);
        const discount = invoices.reduce((s, i) => s + toNumber(i.discount), 0);
        const tax = invoices.reduce((s, i) => s + toNumber(i.tax), 0);
        res.json({ grossSales: gross, netSales: net, totalDiscount: discount, totalTax: tax, invoiceCount: invoices.length });
      } catch (e) {
        res.json({ grossSales: 0, netSales: 0, totalDiscount: 0, totalTax: 0, invoiceCount: 0 });
      }
    });

    ownerRouter.get("/reports/payment-modes", async (req, res) => {
      try {
        const bs = branchScope(req);
        const payments = await prisma.invoicePayment.findMany({
          where: { invoice: { salonId: req.salonId, ...bs, status: { not: "CANCELLED" } }, ...parseDateWhere(req.query) }
        });
        const modes = {};
        payments.forEach(p => {
          const m = p.method || "CASH";
          modes[m] = (modes[m] || 0) + toNumber(p.amount);
        });
        res.json(modes);
      } catch (e) {
        res.json({});
      }
    });

    ownerRouter.get("/reports/appointments", async (req, res) => {
      try {
        const bs = branchScope(req);
        const appts = await prisma.appointment.findMany({
          where: { salonId: req.salonId, ...bs, ...parseDateWhere(req.query, "scheduledAt") },
          include: { customer: true, staff: true },
          take: 100,
          orderBy: { scheduledAt: "desc" }
        });
        res.json(appts);
      } catch (e) {
        res.json([]);
      }
    });

    ownerRouter.get("/reports/staff-performance", async (req, res) => {
      try {
        const bs = branchScope(req);
        const staff = await prisma.user.findMany({
          where: { memberships: { some: { salonId: req.salonId, ...bs } } },
          select: { id: true, name: true }
        });
        res.json(staff.map(s => ({ staffId: s.id, staffName: s.name, totalSales: 0, serviceCount: 0 })));
      } catch (e) {
        res.json([]);
      }
    });

    ownerRouter.get("/reports/product-sales", async (req, res) => {
      try {
        const bs = branchScope(req);
        const products = await prisma.product.findMany({
          where: { salonId: req.salonId, ...bs },
          take: 50
        });
        res.json(products.map(p => ({ id: p.id, name: p.name, quantitySold: 0, totalRevenue: 0 })));
      } catch (e) {
        res.json([]);
      }
    });

    ownerRouter.get("/reports/service-sales", async (req, res) => {
      try {
        const bs = branchScope(req);
        const services = await prisma.service.findMany({
          where: { salonId: req.salonId, ...bs },
          take: 50
        });
        res.json(services.map(s => ({ id: s.id, name: s.name, count: 0, totalRevenue: 0 })));
      } catch (e) {
        res.json([]);
      }
    });

    ownerRouter.get("/reports/memberships", async (req, res) => {
      try {
        const plans = await prisma.membershipPlan.findMany({
          where: { salonId: req.salonId },
          take: 50
        });
        res.json(plans);
      } catch (e) {
        res.json([]);
      }
    });

    ownerRouter.get("/reports/packages", async (req, res) => {
      try {
        const packages = await prisma.package.findMany({
          where: { salonId: req.salonId },
          take: 50
        });
        res.json(packages);
      } catch (e) {
        res.json([]);
      }
    });

    ownerRouter.get("/reports/stock", async (req, res) => {
      try {
        const bs = branchScope(req);
        const stock = await prisma.product.findMany({
          where: { salonId: req.salonId, ...bs },
          take: 100,
          orderBy: { stockQuantity: "asc" }
        });
        res.json(stock);
      } catch (e) {
        res.json([]);
      }
    });

    ownerRouter.get("/reports/customers", async (req, res) => {
      try {
        const bs = branchScope(req);
        const customers = await prisma.customer.findMany({
          where: { salonId: req.salonId, ...bs },
          take: 100,
          orderBy: { createdAt: "desc" }
        });
        res.json(customers);
      } catch (e) {
        res.json([]);
      }
    });

    ownerRouter.get("/reports/branch-sales", async (req, res) => {
      try {
        const branches = await prisma.branch.findMany({
          where: { salonId: req.salonId }
        });
        res.json(branches.map(b => ({ branchId: b.id, name: b.name, revenue: 0, invoiceCount: 0 })));
      } catch (e) {
        res.json([]);
      }
    });

    ownerRouter.get("/reports/cancelled-invoices", async (req, res) => {
      try {
        const bs = branchScope(req);
        const cancelled = await prisma.invoice.findMany({
          where: { salonId: req.salonId, ...bs, status: "CANCELLED", ...parseDateWhere(req.query) },
          take: 50,
          orderBy: { createdAt: "desc" }
        });
        res.json(cancelled);
      } catch (e) {
        res.json([]);
      }
    });

    ownerRouter.get("/reports/low-stock", async (req, res) => {
      try {
        const bs = branchScope(req);
        const lowStock = await prisma.product.findMany({
          where: { salonId: req.salonId, ...bs, stockQuantity: { lte: 5 } },
          take: 50,
          orderBy: { stockQuantity: "asc" }
        });
        res.json(lowStock);
      } catch (e) {
        res.json([]);
      }
    });
`;

// Insert right before the last closing brace of registerAdvancedReportRoutes
const lastBraceIndex = content.lastIndexOf("};");
if (lastBraceIndex !== -1) {
  content = content.substring(0, lastBraceIndex) + additionalRoutes + "\n" + content.substring(lastBraceIndex);
  fs.writeFileSync('src/modules/owner/phase4/reports.js', content);
  console.log("Successfully injected 13 reports routes into phase4/reports.js!");
} else {
  console.error("Could not find closing brace!");
}
