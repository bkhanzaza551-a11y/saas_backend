import { prisma } from "../../../lib/prisma.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";

const toNumber = (value) => Number(value || 0);
const normalizeBranchId = (value) => (value ? String(value) : null);

const parseDateWhere = (query, field = "createdAt") => {
  const start = query.start ? new Date(String(query.start)) : null;
  const end = query.end ? new Date(String(query.end)) : null;
  return start || end
    ? { [field]: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } }
    : {};
};

const branchScope = (req) => {
  const branchId = normalizeBranchId(req.query.branchId);
  return branchId ? { branchId } : {};
};

export const registerAdvancedReportRoutes = (ownerRouter) => {
  ownerRouter.get("/reports/advanced", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), async (req, res) => {
    const bs = branchScope(req);
    const [expenses, feedback, enquiries, couponRedemptions, giftCardRedemptions] = await Promise.all([
      prisma.expense.findMany({ where: { salonId: req.salonId, ...bs, ...parseDateWhere(req.query, "expenseDate") } }),
      prisma.customerFeedback.findMany({ where: { salonId: req.salonId, ...bs, ...parseDateWhere(req.query) } }),
      prisma.enquiry.findMany({ where: { salonId: req.salonId, ...bs, ...parseDateWhere(req.query) } }),
      prisma.couponRedemption.findMany({ where: { salonId: req.salonId, ...bs, ...parseDateWhere(req.query) } }),
      prisma.giftCardRedemption.findMany({ where: { salonId: req.salonId, ...bs, ...parseDateWhere(req.query) } })
    ]);
    res.json({
      summaryCards: {
        expenses: expenses.reduce((sum, row) => sum + toNumber(row.amount), 0),
        payroll: 0,
        averageFeedback: feedback.length ? feedback.reduce((sum, row) => sum + row.rating, 0) / feedback.length : 0,
        enquiries: enquiries.length,
        couponSavings: couponRedemptions.reduce((sum, row) => sum + toNumber(row.amountSaved), 0),
        giftCardUse: giftCardRedemptions.reduce((sum, row) => sum + toNumber(row.amountUsed), 0)
      }
    });
  });

  ownerRouter.get("/reports/profit-loss", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), async (req, res) => {
    const bs = branchScope(req);
    const [invoices, expenses] = await Promise.all([
      prisma.invoice.findMany({ where: { salonId: req.salonId, ...bs, status: { not: "CANCELLED" }, ...parseDateWhere(req.query) } }),
      prisma.expense.findMany({ where: { salonId: req.salonId, ...bs, status: { in: ["APPROVED", "PAID"] }, ...parseDateWhere(req.query, "expenseDate") } })
    ]);
    const revenue = invoices.reduce((sum, row) => sum + toNumber(row.total), 0);
    const costs = expenses.reduce((sum, row) => sum + toNumber(row.amount), 0);
    res.json({ revenue, expenses: costs, profit: revenue - costs, invoices, expenseRows: expenses });
  });

  ownerRouter.get("/reports/campaign-roi", requireFeatureEnabled("campaigns"), requireSalonPermission("campaignAnalytics", "view"), async (req, res) => {
    const bs = branchScope(req);
    const campaigns = await prisma.campaign.findMany({
      where: { salonId: req.salonId, ...bs },
      include: { conversions: true, logs: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(campaigns.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      revenue: campaign.conversions.reduce((sum, row) => sum + toNumber(row.revenueAmount), 0),
      conversions: campaign.conversions.length,
      sends: campaign.logs.filter((row) => row.eventType.includes("SENT")).length
    })));
  });



  
  ownerRouter.get("/reports/payroll", requireFeatureEnabled("payroll"), requireSalonPermission("payroll", "view"), async (req, res) => {
    res.json([]);
  });

  ownerRouter.get("/reports/tax", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), async (req, res) => {
    const bs = branchScope(req);
    const invoices = await prisma.invoice.findMany({ where: { salonId: req.salonId, ...bs, status: { not: "CANCELLED" }, ...parseDateWhere(req.query) }, orderBy: { createdAt: "desc" } });
    res.json({
      taxCollected: invoices.reduce((sum, row) => sum + toNumber(row.tax), 0),
      rows: invoices.map((row) => ({ invoiceNumber: row.invoiceNumber, total: row.total, tax: row.tax, createdAt: row.createdAt }))
    });
  });

  ownerRouter.get("/reports/export", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), async (req, res) => {
    const moduleKey = String(req.query.module || "profit-loss");
    const bs = branchScope(req);
    let rows = [];
    if (moduleKey === "expenses") {
      rows = await prisma.expense.findMany({ where: { salonId: req.salonId, ...bs }, orderBy: { expenseDate: "desc" } });
    } else if (moduleKey === "campaigns") {
      rows = await prisma.campaign.findMany({
        where: { salonId: req.salonId, ...bs },
        include: { conversions: true, logs: true },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        status: row.status,
        audienceFilter: row.audienceFilter,
        conversions: row.conversions.length,
        sends: row.logs.filter((entry) => entry.eventType.includes("SENT")).length,
        revenue: row.conversions.reduce((sum, entry) => sum + toNumber(entry.revenueAmount), 0),
        createdAt: row.createdAt
      }));
    } else if (moduleKey === "loyalty") {
      rows = await prisma.loyaltyTransaction.findMany({
        where: { salonId: req.salonId, ...bs },
        include: { customer: true, invoice: true },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        id: row.id,
        customer: row.customer?.name || "",
        type: row.type,
        points: row.points,
        balanceAfter: row.balanceAfter,
        invoiceNumber: row.invoice?.invoiceNumber || "",
        createdAt: row.createdAt
      }));
    } else if (moduleKey === "coupons") {
      rows = await prisma.couponRedemption.findMany({
        where: { salonId: req.salonId, ...bs },
        include: { coupon: true, customer: true, invoice: true, order: true },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        id: row.id,
        couponCode: row.coupon?.code || "",
        customer: row.customer?.name || "",
        amountSaved: row.amountSaved,
        invoiceNumber: row.invoice?.invoiceNumber || "",
        orderNumber: row.order?.orderNumber || "",
        createdAt: row.createdAt
      }));
    } else if (moduleKey === "gift-cards") {
      rows = await prisma.giftCardRedemption.findMany({
        where: { salonId: req.salonId, ...bs },
        include: { giftCard: true, customer: true, invoice: true, order: true },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        id: row.id,
        giftCardCode: row.giftCard?.code || "",
        customer: row.customer?.name || "",
        amountUsed: row.amountUsed,
        invoiceNumber: row.invoice?.invoiceNumber || "",
        orderNumber: row.order?.orderNumber || "",
        createdAt: row.createdAt
      }));
    } else if (moduleKey === "feedback") {
      rows = await prisma.customerFeedback.findMany({
        where: { salonId: req.salonId, ...bs },
        include: { customer: true, branch: true, service: true },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        id: row.id,
        customer: row.customer?.name || "",
        branch: row.branch?.name || "",
        service: row.service?.name || "",
        rating: row.rating,
        status: row.complaintFollowUpStatus || row.status,
        comment: row.message || "",
        createdAt: row.createdAt
      }));
    } else if (moduleKey === "enquiries") {
      rows = await prisma.enquiry.findMany({
        where: { salonId: req.salonId, ...bs },
        include: { interestedBranch: true, assignedToMembership: { include: { user: true } }, interestedService: true },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        id: row.id,
        customerName: row.name,
        source: row.source,
        service: row.interestedService?.name || "",
        branch: row.interestedBranch?.name || "",
        priority: row.priority,
        status: row.status,
        assignedTo: row.assignedToMembership?.user?.name || "",
        createdAt: row.createdAt
      }));
    } else if (moduleKey === "payroll") {
      rows = [];
    } else if (moduleKey === "tax") {
      rows = await prisma.invoice.findMany({
        where: { salonId: req.salonId, ...bs, status: { not: "CANCELLED" } },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        invoiceNumber: row.invoiceNumber,
        total: row.total,
        tax: row.tax,
        createdAt: row.createdAt
      }));
    } else {
      rows = await prisma.invoice.findMany({ where: { salonId: req.salonId, ...bs }, orderBy: { createdAt: "desc" } });
    }

    const csv = [
      Object.keys(rows[0] || {}).join(","),
      ...rows.map((row) => Object.values(row).map((value) => JSON.stringify(value ?? "")).join(","))
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"${moduleKey}-report.csv\"`);
    res.send(csv);
  });

  ownerRouter.get("/financial-reports", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), async (req, res) => {
    const bs = branchScope(req);
    const period = req.query.period || "thisMonth";
    const now = new Date();
    let start = new Date(now);
    if (period === "today") start.setHours(0, 0, 0, 0);
    else if (period === "thisMonth") { start.setDate(1); start.setHours(0, 0, 0, 0); }
    else if (period === "thisQuarter") { start.setMonth(Math.floor(now.getMonth() / 3) * 3, 1); start.setHours(0, 0, 0, 0); }
    else if (period === "thisYear") { start.setMonth(0, 1); start.setHours(0, 0, 0, 0); }
    else if (period === "custom" && req.query.start) { start = new Date(req.query.start); }
    else { start.setDate(1); start.setHours(0, 0, 0, 0); }

    const dateFilter = { gte: start };
    const [invoices, expenses, payments] = await Promise.all([
      prisma.invoice.findMany({ where: { salonId: req.salonId, ...bs, status: { not: "CANCELLED" }, createdAt: dateFilter } }),
      prisma.expense.findMany({ where: { salonId: req.salonId, ...bs, status: { in: ["APPROVED", "PAID"] }, expenseDate: dateFilter } }),
      prisma.payment.findMany({ where: { salonId: req.salonId, ...bs, createdAt: dateFilter } })
    ]);

    const totalRevenue = invoices.reduce((s, r) => s + toNumber(r.total), 0);
    const totalTax = invoices.reduce((s, r) => s + toNumber(r.tax), 0);
    const totalExpenses = expenses.reduce((s, r) => s + toNumber(r.amount), 0);
    const serviceRevenue = invoices.reduce((s, r) => s + toNumber(r.total) - toNumber(r.productTotal || 0), 0);
    const productRevenue = invoices.reduce((s, r) => s + toNumber(r.productTotal || 0), 0);

    const inflows = { CASH: 0, CARD: 0, UPI: 0, BANK_TRANSFER: 0, WALLET: 0, ONLINE: 0 };
    payments.forEach(p => { const m = (p.mode || "CASH").toUpperCase(); if (inflows[m] !== undefined) inflows[m] += toNumber(p.amount); });
    const inflowTotal = Object.values(inflows).reduce((a, b) => a + b, 0);

    const outflows = { CASH: 0, CARD: 0, UPI: 0, BANK_TRANSFER: 0, WALLET: 0, ONLINE: 0 };
    expenses.forEach(e => { const m = (e.paymentMode || "CASH").toUpperCase(); if (outflows[m] !== undefined) outflows[m] += toNumber(e.amount); });
    const outflowTotal = Object.values(outflows).reduce((a, b) => a + b, 0);

    const expenseByCategory = {};
    expenses.forEach(e => { const cat = e.categoryName || "Other"; expenseByCategory[cat] = (expenseByCategory[cat] || 0) + toNumber(e.amount); });

    res.json({
      summary: {
        totalGrossIncome: totalRevenue,
        grossProfit: totalRevenue - totalExpenses,
        grossMargin: totalRevenue ? Math.round(((totalRevenue - totalExpenses) / totalRevenue) * 100) : 0,
        totalExpensesPayroll: totalExpenses,
        netProfit: totalRevenue - totalExpenses,
        netMargin: totalRevenue ? Math.round(((totalRevenue - totalExpenses) / totalRevenue) * 100) : 0
      },
      pnl: {
        revenue: { services: serviceRevenue, products: productRevenue, memberships: 0, packages: 0, giftCards: 0, total: totalRevenue },
        costOfGoodsSold: 0,
        grossProfit: totalRevenue,
        expenses: { rent: expenseByCategory["Rent"] || 0, utilities: expenseByCategory["Utilities"] || 0, supplies: expenseByCategory["Supplies"] || 0, marketing: expenseByCategory["Marketing"] || 0, other: totalExpenses, total: totalExpenses },
        payroll: expenseByCategory["Payroll"] || 0,
        netProfit: totalRevenue - totalExpenses
      },
      cashFlow: {
        inflows: { ...inflows, total: inflowTotal },
        outflows: { ...outflows, total: outflowTotal },
        netCashFlow: inflowTotal - outflowTotal
      },
      gst: {
        taxableTurnover: totalRevenue - totalTax,
        totalGSTCollected: totalTax,
        gstByRate: [{ rate: "default", amount: totalTax }],
        hsnSummary: []
      }
    });
  });

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

};
